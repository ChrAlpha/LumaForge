import type { LumaRawWindowRect } from '@lumaforge/luma-raw-runtime'
import type {
  GeometrySourceWindow,
  PlannedExportGeometry,
} from '@lumaforge/render-engine/export'
import {
  applyGeometryMatte,
  applyMatrix as applyExportMatrix,
  EXPORT_GEOMETRY_MATTE,
  INVALID_EXPORT_GEOMETRY,
  planExportGeometry,
  planGeometryTiles,
  resampleGeometryTile,
} from '@lumaforge/render-engine/export'
import { describe, expect, it } from 'vitest'

import {
  applyMatrix,
  invertMatrix,
} from '~/modules/transform-demo/geometry/matrix'
import type { Matrix3 } from '~/modules/transform-demo/geometry/types'
import type { PreviewFrame } from '~/modules/transform-demo/preview-types'
import {
  composeManualTransform,
  renderTransformedPreview,
} from '~/modules/transform-demo/transform-render'
import type { RenderedPreview } from '~/modules/transform-demo/transform-types'
import { PREVIEW_MATTE } from '~/modules/transform-demo/transform-types'

import type { TransformGeometryCase } from './transform-geometry-test-cases'
import {
  FOLDING_TRANSFORM,
  transformGeometryCases,
} from './transform-geometry-test-cases'

type Size = { width: number; height: number }

/**
 * Representative aspect ratios. The preview buffer stays small and no edge
 * passes 256, so a source column or row fits one 8-bit channel exactly; the
 * full-resolution source the export plans against has the same aspect, the
 * way the committed matrix is composed against the preview frame's aspect.
 */
const FRAMES: ReadonlyArray<{ label: string; preview: Size; source: Size }> = [
  {
    label: '3:2',
    preview: { width: 96, height: 64 },
    source: { width: 6000, height: 4000 },
  },
  {
    label: '4:3',
    preview: { width: 96, height: 72 },
    source: { width: 11648, height: 8736 },
  },
  {
    label: '2:3',
    preview: { width: 64, height: 96 },
    source: { width: 4000, height: 6000 },
  },
  {
    label: '1:1',
    preview: { width: 80, height: 80 },
    source: { width: 6000, height: 6000 },
  },
  {
    label: '16:9',
    preview: { width: 128, height: 72 },
    source: { width: 7680, height: 4320 },
  },
]

const IDENTITY: Matrix3 = [1, 0, 0, 0, 1, 0, 0, 0, 1]

/** Blue for every source pixel; the matte's blue is different. */
const SOURCE_MARK = 200
/** The export window carries coordinates at 1/256 pixel precision. */
const COORDINATE_STEP = 256

/**
 * Small enough that the frame splits into many windows with their halos, the
 * way a 100 MP export does under its real budget.
 */
const TILE_BUDGET = 512
const MIN_TILE_WIDTH = 8
const HALO = 2

/**
 * Both samplers are bilinear over a source whose channels are its own column
 * and row, so each output pixel carries the source point it sampled. They
 * agree up to the rounding of their output encodings: half a step of the
 * preview's 8 bits plus half a step of the export's 1/256 pixel.
 */
const SAMPLE_TOLERANCE = 0.5 + 0.5 / COORDINATE_STEP + 1e-9

/** Output-frame landmarks in normalized space: corners, edge midpoints, centre. */
const LANDMARKS = [0, 0.5, 1].flatMap((y) => [0, 0.5, 1].map((x) => ({ x, y })))

/**
 * Every extreme and combination, plus a geometry that folds inside the frame,
 * in both crop modes at every aspect ratio.
 */
function sweep() {
  const cases: TransformGeometryCase[] = [
    ...transformGeometryCases(),
    ...[true, false].map(
      (crop): TransformGeometryCase => [
        `folding crop=${crop}`,
        FOLDING_TRANSFORM,
        crop,
      ],
    ),
  ]
  return FRAMES.flatMap((frame) =>
    cases.map(
      ([label, manual, constrainCrop]) =>
        [`${frame.label} ${label}`, frame, manual, constrainCrop] as const,
    ),
  )
}

/** Opaque preview frame whose red and green are the pixel's column and row. */
function coordinateFrame({ width, height }: Size): PreviewFrame {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      data.set([x, y, SOURCE_MARK, 255], (y * width + x) * 4)
    }
  }
  return { width, height, data }
}

/** Export source carrying the same coordinates in its first two channels. */
function coordinateSource({ width, height }: Size): Uint16Array {
  const data = new Uint16Array(width * height * 3)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 3
      data[index] = x * COORDINATE_STEP
      data[index + 1] = y * COORDINATE_STEP
      data[index + 2] = SOURCE_MARK
    }
  }
  return data
}

function sourceWindow(
  source: Uint16Array,
  sourceWidth: number,
  rect: LumaRawWindowRect,
): GeometrySourceWindow {
  const stride = rect.width * 3
  const data = new Uint16Array(stride * rect.height)
  for (let row = 0; row < rect.height; row += 1) {
    const from = ((rect.y + row) * sourceWidth + rect.x) * 3
    data.set(source.subarray(from, from + stride), row * stride)
  }
  return { rect, data }
}

function renderPreview(
  frame: PreviewFrame,
  matrix: Matrix3,
  constrainCrop: boolean,
): RenderedPreview | null {
  try {
    return renderTransformedPreview(frame, matrix, constrainCrop)
  } catch (error) {
    expect((error as Error).message).toBe('invalid-transform')
    return null
  }
}

function planExport(
  matrix: Matrix3,
  constrainCrop: boolean,
  source: Size,
): PlannedExportGeometry | null {
  try {
    return planExportGeometry({ matrix, constrainCrop }, source)
  } catch (error) {
    expect((error as Error).message).toBe(INVALID_EXPORT_GEOMETRY)
    return null
  }
}

/**
 * Run the export's own tiling, resampling and matte stages over a coordinate
 * source. `rgb8` stands in for the color graph's output, which the matte then
 * overwrites wherever no source was found.
 */
function exportSampling(planned: PlannedExportGeometry, size: Size) {
  const source = coordinateSource(size)
  const width = planned.outputWidth
  const height = planned.outputHeight
  const stripRect = { x: 0, y: 0, width, height }
  const data = new Uint16Array(width * height * 3)
  const coverage = new Uint8Array(width * height)

  for (const tile of planGeometryTiles({
    planned,
    stripRect,
    source: size,
    maxWindowPixels: TILE_BUDGET,
    minTileWidth: MIN_TILE_WIDTH,
    halo: HALO,
  })) {
    if (!tile.sourceRect) continue
    resampleGeometryTile({
      planned,
      source: size,
      window: sourceWindow(source, size.width, tile.sourceRect),
      target: { stripRect, tileRect: tile.tileRect, data, coverage },
    })
  }

  const rgb8 = new Uint8Array(width * height * 3)
  applyGeometryMatte({
    rgb8,
    coverage,
    pixelCount: width * height,
    coverageOffset: 0,
  })
  return { data, coverage, rgb8 }
}

describe('transform preview and export geometry parity', () => {
  it('paints the same matte in both paths', () => {
    expect([...PREVIEW_MATTE]).toEqual([...EXPORT_GEOMETRY_MATTE])
  })

  it('checks both refused and delivered geometry in each crop mode', () => {
    const outcomes = new Set(
      sweep().map(([, frame, manual, constrainCrop]) => {
        const planned = planExport(
          composeManualTransform(
            IDENTITY,
            manual,
            frame.preview.width / frame.preview.height,
          ),
          constrainCrop,
          frame.source,
        )
        return `crop=${constrainCrop} ${planned ? 'delivered' : 'refused'}`
      }),
    )

    // A sweep that only ever accepts, or only ever refuses, proves nothing
    // about the other half of the contract. The two crop modes refuse for
    // different reasons: too little frame retained, or a fold inside it.
    expect([...outcomes].sort()).toEqual([
      'crop=false delivered',
      'crop=false refused',
      'crop=true delivered',
      'crop=true refused',
    ])
  })

  it.each(sweep())(
    'frames what the preview showed for %s',
    (_label, frame, manual, constrainCrop) => {
      const matrix = composeManualTransform(
        IDENTITY,
        manual,
        frame.preview.width / frame.preview.height,
      )
      const rendered = renderPreview(
        coordinateFrame(frame.preview),
        matrix,
        constrainCrop,
      )
      const planned = planExport(matrix, constrainCrop, frame.source)

      // The preview may only show a geometry the export can deliver, and the
      // export may only refuse one the preview also refused.
      expect(rendered === null).toBe(planned === null)
      if (!rendered || !planned) return

      // The crop is planned on the unit square, so the preview's frame is the
      // full-resolution frame scaled down, rounded the same way.
      expect(rendered.retainedArea).toBe(planned.retainedArea)
      expect(rendered.frame.width).toBe(
        Math.max(1, Math.round(frame.preview.width * planned.scale)),
      )
      expect(rendered.frame.height).toBe(
        Math.max(1, Math.round(frame.preview.height * planned.scale)),
      )

      // The overlay draws through `displayMatrix`; the export frames the
      // centred retained square. Each landmark of the frame has to land on the
      // same point of the photograph in both.
      const shownToSource = invertMatrix(rendered.displayMatrix)
      expect(shownToSource).not.toBeNull()
      const start = (1 - planned.scale) / 2
      for (const landmark of LANDMARKS) {
        const shown = applyMatrix(shownToSource!, landmark)
        const delivered = applyExportMatrix(planned.inverse, {
          x: start + landmark.x * planned.scale,
          y: start + landmark.y * planned.scale,
        })
        expect(shown).not.toBeNull()
        expect(delivered).not.toBeNull()
        expect(shown!.x).toBeCloseTo(delivered!.x, 9)
        expect(shown!.y).toBeCloseTo(delivered!.y, 9)
      }
    },
  )

  it.each(sweep())(
    'samples the source where the preview did for %s',
    (_label, frame, manual, constrainCrop) => {
      const matrix = composeManualTransform(
        IDENTITY,
        manual,
        frame.preview.width / frame.preview.height,
      )
      const rendered = renderPreview(
        coordinateFrame(frame.preview),
        matrix,
        constrainCrop,
      )
      // Planned at the preview's own size so the two frames line up pixel for
      // pixel; the crop scale does not depend on resolution.
      const planned = planExport(matrix, constrainCrop, frame.preview)
      const fullResolution = planExport(matrix, constrainCrop, frame.source)
      expect(rendered === null).toBe(planned === null)
      if (!rendered || !planned) return
      expect(planned.scale).toBe(fullResolution!.scale)
      expect([planned.outputWidth, planned.outputHeight]).toEqual([
        rendered.frame.width,
        rendered.frame.height,
      ])

      // The preview resamples display sRGB after the color graph and the
      // export resamples linear ProPhoto before it, so their pixels are not
      // comparable. What must agree is which output pixels have source behind
      // them, the matte on those that do not, and where the rest sample.
      const exported = exportSampling(planned, frame.preview)
      const pixels = planned.outputWidth * planned.outputHeight
      let coverageMismatches = 0
      let matteMismatches = 0
      let worstSampleError = 0
      for (let pixel = 0; pixel < pixels; pixel += 1) {
        const shown = rendered.frame.data.subarray(pixel * 4, pixel * 4 + 3)
        const covered = exported.coverage[pixel] === 1
        if ((shown[2] === SOURCE_MARK) !== covered) {
          coverageMismatches += 1
          continue
        }
        if (!covered) {
          const matte = exported.rgb8.subarray(pixel * 3, pixel * 3 + 3)
          if (shown.some((value, channel) => value !== matte[channel])) {
            matteMismatches += 1
          }
          continue
        }
        for (const channel of [0, 1]) {
          const delivered =
            exported.data[pixel * 3 + channel]! / COORDINATE_STEP
          worstSampleError = Math.max(
            worstSampleError,
            Math.abs(shown[channel]! - delivered),
          )
        }
      }

      expect({ coverageMismatches, matteMismatches }).toEqual({
        coverageMismatches: 0,
        matteMismatches: 0,
      })
      expect(worstSampleError).toBeLessThanOrEqual(SAMPLE_TOLERANCE)
    },
  )
})
