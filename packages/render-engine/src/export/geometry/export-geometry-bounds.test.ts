import type { LumaRawWindowRect } from '@lumaforge/luma-raw-runtime'
import { describe, expect, it } from 'vitest'

import type { TransformCaseOutput } from '../../geometry/testing/transform-cases'
import {
  FOLDING_MATRIX_GEOMETRY,
  TRANSFORM_CASE_SOURCE,
  TRANSFORM_MATRIX_GEOMETRIES,
  transformMatrixCases,
} from '../../geometry/testing/transform-cases'
import type { PlannedExportGeometry } from './export-geometry'
import {
  INVALID_EXPORT_GEOMETRY,
  planExportGeometry,
  planGeometryTiles,
} from './export-geometry'
import type { Matrix3 } from './matrix'

// Mirrors the export's own constants; see `full-res-export.ts`.
const MAX_STRIP_ROWS = 256
const MAX_WINDOW_PIXELS = 4_000_000
const MIN_TILE_WIDTH = 64
const HALO = 2

const SOURCE = TRANSFORM_CASE_SOURCE

function plan(
  matrix: Matrix3,
  constrainCrop: boolean,
): PlannedExportGeometry | null {
  try {
    return planExportGeometry({ matrix, constrainCrop }, SOURCE)
  } catch (error) {
    expect((error as Error).message).toBe(INVALID_EXPORT_GEOMETRY)
    return null
  }
}

function plannedOutput(
  planned: PlannedExportGeometry | null,
): TransformCaseOutput {
  return planned
    ? { width: planned.outputWidth, height: planned.outputHeight }
    : null
}

/**
 * Walk the whole output the way the export does and report the largest source
 * window any single tile would read.
 */
function worstWindow(planned: PlannedExportGeometry) {
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
  return { worstWindowPixels, worstRect }
}

describe('geometried export memory bound', () => {
  it('sweeps every field extreme and combination in both crop modes', () => {
    const cases = transformMatrixCases()
    // Seven fields at both ends of their range plus five combinations, each
    // constrained and unconstrained.
    expect(TRANSFORM_MATRIX_GEOMETRIES).toHaveLength(7 * 2 + 5)
    expect(cases).toHaveLength(38)
    expect(new Set(cases.map(([label]) => label)).size).toBe(38)

    // A sweep that only ever accepts, or only ever refuses, proves nothing
    // about the other half of the contract.
    const outcomes = new Set(
      [...cases, ...transformMatrixCases([FOLDING_MATRIX_GEOMETRY])].map(
        ([, , constrainCrop, expected]) =>
          `crop=${constrainCrop} ${expected ? 'delivered' : 'refused'}`,
      ),
    )
    expect([...outcomes].sort()).toEqual([
      'crop=false delivered',
      'crop=false refused',
      'crop=true delivered',
      'crop=true refused',
    ])
  })

  it.each(transformMatrixCases())(
    'keeps every tile read inside the budget for %s',
    (_label, matrix, constrainCrop, expected) => {
      const planned = plan(matrix, constrainCrop)
      expect(plannedOutput(planned)).toEqual(expected)
      if (!planned) return

      // The whole point of tiling: no single read scales with the image, so a
      // 100 MP export stays inside a browser's memory however extreme the
      // geometry is. Without adaptive splitting the worst case here read the
      // entire 11648x8736 frame in one window.
      const { worstWindowPixels, worstRect } = worstWindow(planned)
      expect(worstWindowPixels).toBeGreaterThan(0)
      expect(worstWindowPixels).toBeLessThanOrEqual(MAX_WINDOW_PIXELS)
      expect(worstRect.height).toBeLessThan(SOURCE.height)

      // Never a window larger than the source it reads from.
      expect(worstRect.width).toBeLessThanOrEqual(SOURCE.width)
      expect(worstRect.height).toBeLessThanOrEqual(SOURCE.height)
    },
  )

  it('fails closed when the projective horizon crosses the exported frame', () => {
    // Sampling runs the inverse over the output square; here its denominator
    // changes sign inside that square, so the frame folds. The bounding box of
    // a folded preimage covers the whole source, which is how this showed up:
    // one tile asking for 582 MB on a 100 MP file.
    expect(() =>
      planExportGeometry(
        { matrix: FOLDING_MATRIX_GEOMETRY.matrix, constrainCrop: false },
        SOURCE,
      ),
    ).toThrow(INVALID_EXPORT_GEOMETRY)
    expect(FOLDING_MATRIX_GEOMETRY.unconstrained).toBeNull()

    // Constraining the crop pulls the frame back inside the horizon, so the
    // same geometry stays exportable with the default crop mode, and stays
    // inside the read budget.
    const planned = plan(FOLDING_MATRIX_GEOMETRY.matrix, true)
    expect(plannedOutput(planned)).toEqual(FOLDING_MATRIX_GEOMETRY.constrained)
    expect(worstWindow(planned!).worstWindowPixels).toBeLessThanOrEqual(
      MAX_WINDOW_PIXELS,
    )
  })
})
