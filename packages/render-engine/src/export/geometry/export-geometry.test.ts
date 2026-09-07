import { describe, expect, it } from 'vitest'

import {
  applyGeometryMatte,
  EXPORT_GEOMETRY_MATTE,
  INVALID_EXPORT_GEOMETRY,
  planExportGeometry,
  planGeometryTiles,
  preimageRect,
  resampleGeometryTile,
} from './export-geometry'
import type { Matrix3 } from './matrix'
import { invertMatrix } from './matrix'

const IDENTITY: Matrix3 = [1, 0, 0, 0, 1, 0, 0, 0, 1]

/** Source-normalized to output-normalized for a 90 degree turn. */
const QUARTER_TURN = invertMatrix([0, 1, 0, -1, 0, 1, 0, 0, 1])!

function makeSource(width: number, height: number) {
  const data = new Uint16Array(width * height * 3)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 3
      data[index] = 1000 + x * 100
      data[index + 1] = 2000 + y * 100
      data[index + 2] = 3000 + (x + y) * 10
    }
  }
  return {
    rect: { x: 0, y: 0, width, height },
    data,
  }
}

function makeTarget(width: number, height: number) {
  return {
    stripRect: { x: 0, y: 0, width, height },
    tileRect: { x: 0, y: 0, width, height },
    data: new Uint16Array(width * height * 3),
    coverage: new Uint8Array(width * height),
  }
}

function pixel(
  data: Uint16Array,
  width: number,
  x: number,
  y: number,
): [number, number, number] {
  const index = (y * width + x) * 3
  return [data[index]!, data[index + 1]!, data[index + 2]!]
}

describe('planExportGeometry', () => {
  it('keeps the source frame when the geometry is identity', () => {
    const planned = planExportGeometry(
      { matrix: IDENTITY, constrainCrop: true },
      { width: 6000, height: 4000 },
    )

    expect(planned.outputWidth).toBe(6000)
    expect(planned.outputHeight).toBe(4000)
    expect(planned.scale).toBe(1)
    expect(planned.retainedArea).toBe(1)
  })

  it('derives output size from a resolution-independent crop scale', () => {
    const rotated: Matrix3 = [
      Math.cos(0.2),
      -Math.sin(0.2),
      0.1,
      Math.sin(0.2),
      Math.cos(0.2),
      0.05,
      0,
      0,
      1,
    ]
    const small = planExportGeometry(
      { matrix: rotated, constrainCrop: true },
      { width: 600, height: 400 },
    )
    const large = planExportGeometry(
      { matrix: rotated, constrainCrop: true },
      { width: 6000, height: 4000 },
    )

    // The same geometry frames the same photograph at any resolution, which is
    // what lets the full-res export match the preview the user approved.
    expect(large.scale).toBeCloseTo(small.scale, 10)
    expect(large.outputWidth).toBe(Math.round(6000 * large.scale))
    expect(large.outputHeight).toBe(Math.round(4000 * large.scale))
  })

  it('leaves the frame uncropped when the crop is not constrained', () => {
    const planned = planExportGeometry(
      { matrix: QUARTER_TURN, constrainCrop: false },
      { width: 100, height: 100 },
    )

    expect(planned.scale).toBe(1)
    expect(planned.outputWidth).toBe(100)
    expect(planned.outputHeight).toBe(100)
  })

  it.each([
    ['a singular matrix', [0, 0, 0, 0, 0, 0, 0, 0, 1]],
    ['a horizon crossing the frame', [1, 0, 0, 0, 1, 0, 0, -2, 1]],
    ['a non-numeric matrix', [1, 0, 0, 0, 1, 0, 0, 0, Number.NaN]],
    ['the wrong arity', [1, 0, 0, 0, 1, 0]],
  ])('fails closed on %s', (_label, matrix) => {
    expect(() =>
      planExportGeometry(
        { matrix, constrainCrop: true },
        { width: 100, height: 100 },
      ),
    ).toThrow(INVALID_EXPORT_GEOMETRY)
  })

  it('fails closed when the projective horizon crosses the output frame', () => {
    // The forward denominator keeps its sign across the source square, so the
    // older check passed this; the inverse still changes sign across the
    // output square, which is the mapping sampling actually runs.
    const folding: Matrix3 = [
      0.8928, -0.0402, 0.0737, 0.7931, 0.5803, -0.1867, 0.9196, 0.2946, 0.3929,
    ]

    expect(() =>
      planExportGeometry(
        { matrix: folding, constrainCrop: false },
        { width: 1024, height: 1024 },
      ),
    ).toThrow(INVALID_EXPORT_GEOMETRY)
  })

  it('fails closed when a constrained crop would retain almost nothing', () => {
    // A severe shear leaves no usable rectangle inside the frame.
    expect(() =>
      planExportGeometry(
        { matrix: [1, 0, 0, 0, 0.02, 0.49, 0, 0, 1], constrainCrop: true },
        { width: 100, height: 100 },
      ),
    ).toThrow(INVALID_EXPORT_GEOMETRY)
  })
})

describe('preimageRect', () => {
  it('returns the matching source rect plus a halo under identity', () => {
    const planned = planExportGeometry(
      { matrix: IDENTITY, constrainCrop: true },
      { width: 64, height: 64 },
    )
    const rect = preimageRect(
      planned,
      { x: 16, y: 16, width: 16, height: 16 },
      { width: 64, height: 64 },
      2,
    )

    expect(rect).toEqual({ x: 14, y: 14, width: 20, height: 20 })
  })

  it('clamps the halo to the source bounds', () => {
    const planned = planExportGeometry(
      { matrix: IDENTITY, constrainCrop: true },
      { width: 32, height: 32 },
    )

    expect(
      preimageRect(
        planned,
        { x: 0, y: 0, width: 32, height: 32 },
        { width: 32, height: 32 },
        2,
      ),
    ).toEqual({ x: 0, y: 0, width: 32, height: 32 })
  })

  it('bounds a rotated tile without spanning the whole frame', () => {
    const planned = planExportGeometry(
      { matrix: QUARTER_TURN, constrainCrop: false },
      { width: 256, height: 256 },
    )
    const rect = preimageRect(
      planned,
      { x: 0, y: 0, width: 64, height: 64 },
      { width: 256, height: 256 },
      2,
    )!

    // A quarter turn sends a corner tile to a corner tile, not to a band that
    // spans the image. This is the property that keeps the export bounded.
    expect(rect.width).toBeLessThanOrEqual(70)
    expect(rect.height).toBeLessThanOrEqual(70)
  })
})

describe('planGeometryTiles', () => {
  const strip = { x: 0, y: 0, width: 1024, height: 256 }

  function plan(matrix: Matrix3, maxWindowPixels: number) {
    const planned = planExportGeometry(
      { matrix, constrainCrop: false },
      { width: 1024, height: 1024 },
    )
    return planGeometryTiles({
      planned,
      stripRect: strip,
      source: { width: 1024, height: 1024 },
      maxWindowPixels,
      minTileWidth: 16,
      halo: 2,
    })
  }

  it('reads the strip in one window when it already fits', () => {
    const tiles = plan(IDENTITY, 4_000_000)

    expect(tiles).toHaveLength(1)
    expect(tiles[0]!.tileRect).toEqual(strip)
  })

  it('splits until every window fits the budget', () => {
    const tiles = plan(IDENTITY, 20_000)

    expect(tiles.length).toBeGreaterThan(1)
    for (const tile of tiles) {
      if (!tile.sourceRect) continue
      const pixels = tile.sourceRect.width * tile.sourceRect.height
      // The floor on tile size means a tile can only exceed the budget once it
      // can no longer be split; nothing here is that small.
      expect(pixels).toBeLessThanOrEqual(20_000)
    }
  })

  it('covers the strip exactly, with no gap and no overlap', () => {
    const tiles = plan(QUARTER_TURN, 20_000)
    const seen = new Uint8Array(strip.width * strip.height)

    for (const tile of tiles) {
      for (let y = 0; y < tile.tileRect.height; y += 1) {
        for (let x = 0; x < tile.tileRect.width; x += 1) {
          const column = tile.tileRect.x - strip.x + x
          const row = tile.tileRect.y - strip.y + y
          seen[row * strip.width + column]! += 1
        }
      }
    }

    // A gap would leave output pixels silently matted; an overlap would resample
    // the same pixel twice. Both have to be impossible, not merely unlikely.
    expect(seen.every((count) => count === 1)).toBe(true)
  })

  it('splits rows too, not only columns', () => {
    // A wide-but-short strip forces the column axis to bottom out first.
    const planned = planExportGeometry(
      { matrix: IDENTITY, constrainCrop: false },
      { width: 1024, height: 1024 },
    )
    const tiles = planGeometryTiles({
      planned,
      stripRect: { x: 0, y: 0, width: 64, height: 256 },
      source: { width: 1024, height: 1024 },
      maxWindowPixels: 4_000,
      minTileWidth: 64,
      minTileHeight: 8,
      halo: 0,
    })

    expect(tiles.length).toBeGreaterThan(1)
    expect(new Set(tiles.map((tile) => tile.tileRect.y)).size).toBeGreaterThan(
      1,
    )
  })

  it('marks tiles with no source behind them instead of reading', () => {
    const planned = planExportGeometry(
      { matrix: [1, 0, 3, 0, 1, 0, 0, 0, 1], constrainCrop: false },
      { width: 1024, height: 1024 },
    )
    const tiles = planGeometryTiles({
      planned,
      stripRect: strip,
      source: { width: 1024, height: 1024 },
      maxWindowPixels: 4_000_000,
      minTileWidth: 16,
      halo: 2,
    })

    expect(tiles.some((tile) => tile.sourceRect === null)).toBe(true)
  })
})

describe('resampleGeometryTile', () => {
  it('reproduces the source exactly under identity', () => {
    const source = makeSource(8, 8)
    const planned = planExportGeometry(
      { matrix: IDENTITY, constrainCrop: true },
      { width: 8, height: 8 },
    )
    const target = makeTarget(8, 8)

    resampleGeometryTile({
      planned,
      source: { width: 8, height: 8 },
      window: source,
      target,
    })

    expect(Array.from(target.data)).toEqual(Array.from(source.data))
    expect(Array.from(target.coverage)).toEqual(
      Array.from({ length: 64 }).fill(1),
    )
  })

  it('places every pixel where a quarter turn sends it', () => {
    const size = 8
    const source = makeSource(size, size)
    const planned = planExportGeometry(
      { matrix: QUARTER_TURN, constrainCrop: false },
      { width: size, height: size },
    )
    const target = makeTarget(size, size)

    resampleGeometryTile({
      planned,
      source: { width: size, height: size },
      window: source,
      target,
    })

    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        expect(pixel(target.data, size, x, y)).toEqual(
          pixel(source.data, size, y, size - 1 - x),
        )
      }
    }
  })

  it('leaves pixels with no source behind them uncovered', () => {
    const source = makeSource(8, 8)
    // Push the frame far enough right that the left half has no source.
    const planned = planExportGeometry(
      { matrix: [1, 0, 0.5, 0, 1, 0, 0, 0, 1], constrainCrop: false },
      { width: 8, height: 8 },
    )
    const target = makeTarget(8, 8)

    resampleGeometryTile({
      planned,
      source: { width: 8, height: 8 },
      window: source,
      target,
    })

    expect(target.coverage[0]).toBe(0)
    expect(target.coverage[7]).toBe(1)
  })

  it('writes only its own tile columns of the strip', () => {
    const source = makeSource(8, 8)
    const planned = planExportGeometry(
      { matrix: IDENTITY, constrainCrop: true },
      { width: 8, height: 8 },
    )
    const target = {
      ...makeTarget(8, 8),
      tileRect: { x: 4, y: 0, width: 4, height: 8 },
    }

    resampleGeometryTile({
      planned,
      source: { width: 8, height: 8 },
      window: source,
      target,
    })

    for (let y = 0; y < 8; y += 1) {
      expect(target.coverage[y * 8]).toBe(0)
      expect(target.coverage[y * 8 + 4]).toBe(1)
    }
  })
})

describe('applyGeometryMatte', () => {
  it('paints the matte only where the resample found no source', () => {
    const rgb8 = new Uint8Array([10, 20, 30, 40, 50, 60])
    const coverage = new Uint8Array([0, 1])

    applyGeometryMatte({ rgb8, coverage, pixelCount: 2, coverageOffset: 0 })

    expect(Array.from(rgb8.subarray(0, 3))).toEqual([...EXPORT_GEOMETRY_MATTE])
    expect(Array.from(rgb8.subarray(3, 6))).toEqual([40, 50, 60])
  })

  it('reads coverage from the band offset it was given', () => {
    const rgb8 = new Uint8Array([10, 20, 30])
    const coverage = new Uint8Array([0, 1])

    applyGeometryMatte({ rgb8, coverage, pixelCount: 1, coverageOffset: 1 })

    expect(Array.from(rgb8)).toEqual([10, 20, 30])
  })
})
