import type { LumaRawWindowRect } from '@lumaforge/luma-raw-runtime'
import {
  INVALID_EXPORT_GEOMETRY,
  planExportGeometry,
  planGeometryTiles,
} from '@lumaforge/render-engine/export'
import { describe, expect, it } from 'vitest'

import { composeManualTransform } from '~/modules/transform-demo/transform-render'
import type { ManualTransform } from '~/modules/transform-demo/transform-types'
import { NEUTRAL_TRANSFORM } from '~/modules/transform-demo/transform-types'

// Mirrors the export's own constants; see `full-res-export.ts`.
const MAX_STRIP_ROWS = 256
const MAX_WINDOW_PIXELS = 4_000_000
const MIN_TILE_WIDTH = 64
const HALO = 2

/** 100 MP — the size the bounded export pipeline exists for. */
const SOURCE = { width: 11648, height: 8736 }

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1] as const

/** The full slider range of every Transform field. */
const EXTREMES: Record<keyof ManualTransform, number[]> = {
  vertical: [-60, 60],
  horizontal: [-60, 60],
  rotate: [-30, 30],
  aspect: [-50, 50],
  scale: [50, 150],
  offsetX: [-30, 30],
  offsetY: [-30, 30],
}

function matrixFor(manual: ManualTransform) {
  return composeManualTransform(IDENTITY, manual, SOURCE.width / SOURCE.height)
}

type Measured =
  | { rejected: true }
  | { rejected: false; worstWindowPixels: number; worstRect: LumaRawWindowRect }

/**
 * Walk the whole output the way the export does and report the largest source
 * window any single tile would read.
 */
function measureWorstWindow(
  manual: ManualTransform,
  constrainCrop: boolean,
): Measured {
  let planned
  try {
    planned = planExportGeometry(
      { matrix: matrixFor(manual), constrainCrop },
      SOURCE,
    )
  } catch {
    return { rejected: true }
  }

  let worstWindowPixels = 0
  let worstRect: LumaRawWindowRect = { x: 0, y: 0, width: 0, height: 0 }
  for (let y = 0; y < planned.outputHeight; y += MAX_STRIP_ROWS) {
    const height = Math.min(MAX_STRIP_ROWS, planned.outputHeight - y)
    for (const tile of planGeometryTiles({
      planned,
      stripRect: { x: 0, y, width: planned.outputWidth, height },
      source: SOURCE,
      maxWindowPixels: MAX_WINDOW_PIXELS,
      minTileWidth: MIN_TILE_WIDTH,
      halo: HALO,
    })) {
      if (!tile.sourceRect) continue
      const pixels = tile.sourceRect.width * tile.sourceRect.height
      if (pixels > worstWindowPixels) {
        worstWindowPixels = pixels
        worstRect = tile.sourceRect
      }
    }
  }

  return { rejected: false, worstWindowPixels, worstRect }
}

const COMBINATIONS: Array<[string, Partial<ManualTransform>]> = [
  ['rotate + zoom out', { rotate: 30, scale: 50 }],
  ['rotate + zoom out + vertical', { rotate: 30, scale: 50, vertical: 60 }],
  ['zoom out + aspect', { scale: 50, aspect: -50 }],
  ['both perspective axes', { vertical: 60, horizontal: 60 }],
  [
    'every field at its limit',
    {
      rotate: 30,
      scale: 50,
      vertical: 60,
      horizontal: 60,
      aspect: -50,
      offsetX: 30,
      offsetY: 30,
    },
  ],
]

function cases(): Array<[string, ManualTransform, boolean]> {
  const out: Array<[string, ManualTransform, boolean]> = []
  for (const key of Object.keys(EXTREMES) as Array<keyof ManualTransform>) {
    for (const value of EXTREMES[key]!) {
      for (const crop of [true, false]) {
        out.push([
          `${key}=${value} crop=${crop}`,
          { ...NEUTRAL_TRANSFORM, [key]: value },
          crop,
        ])
      }
    }
  }
  for (const [label, patch] of COMBINATIONS) {
    for (const crop of [true, false]) {
      out.push([
        `${label} crop=${crop}`,
        { ...NEUTRAL_TRANSFORM, ...patch },
        crop,
      ])
    }
  }
  return out
}

describe('geometried export memory bound', () => {
  it.each(cases())(
    'keeps every tile read inside the budget for %s',
    (_label, manual, crop) => {
      const measured = measureWorstWindow(manual, crop)
      if (measured.rejected) return

      // The whole point of tiling: no single read scales with the image, so a
      // 100 MP export stays inside a browser's memory however extreme the
      // geometry is. Without adaptive splitting the worst case here read the
      // entire 11648x8736 frame in one window.
      expect(measured.worstWindowPixels).toBeLessThanOrEqual(MAX_WINDOW_PIXELS)
      expect(measured.worstRect.height).toBeLessThan(SOURCE.height)
    },
  )

  it('never asks for a window larger than the source it reads from', () => {
    for (const [, manual, crop] of cases()) {
      const measured = measureWorstWindow(manual, crop)
      if (measured.rejected) continue
      expect(measured.worstRect.width).toBeLessThanOrEqual(SOURCE.width)
      expect(measured.worstRect.height).toBeLessThanOrEqual(SOURCE.height)
    }
  })

  it('fails closed when the projective horizon crosses the exported frame', () => {
    // Sampling runs the inverse over the output square; here its denominator
    // changes sign inside that square, so the frame folds. The bounding box of
    // a folded preimage covers the whole source, which is how this showed up:
    // one tile asking for 582 MB on a 100 MP file.
    const folded = {
      ...NEUTRAL_TRANSFORM,
      rotate: 30,
      scale: 50,
      vertical: 60,
      horizontal: 60,
    }

    expect(() =>
      planExportGeometry(
        { matrix: matrixFor(folded), constrainCrop: false },
        SOURCE,
      ),
    ).toThrow(INVALID_EXPORT_GEOMETRY)

    // Constraining the crop pulls the frame back inside the horizon, so the
    // same geometry stays exportable with the default crop mode.
    expect(() =>
      planExportGeometry(
        { matrix: matrixFor(folded), constrainCrop: true },
        SOURCE,
      ),
    ).not.toThrow()
  })
})
