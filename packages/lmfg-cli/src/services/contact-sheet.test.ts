// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { buildContactSheet, downsampleRgba, fitTileSize } from './contact-sheet'

describe('contact sheet helpers', () => {
  it('fits tiles preserving aspect ratio and never upsamples', () => {
    expect(fitTileSize(4000, 3000, 320)).toEqual({ width: 320, height: 240 })
    expect(fitTileSize(100, 50, 320)).toEqual({ width: 100, height: 50 })
  })

  it('box-averages when downsampling', () => {
    const src = new Uint8ClampedArray([
      0, 0, 0, 255, 100, 100, 100, 255, 200, 200, 200, 255, 100, 100, 100, 255,
    ])
    const dst = downsampleRgba(src, 2, 2, 1, 1)
    expect([...dst]).toEqual([100, 100, 100, 255])
  })

  it('lays tiles out on a grid and reports their positions', () => {
    const tile = (v: number) => ({
      id: `cand_000${v}`,
      rgba: new Uint8ClampedArray([v, v, v, 255, v, v, v, 255]),
      width: 2,
      height: 1,
    })
    const built = buildContactSheet({
      tiles: [tile(1), tile(2), tile(3)],
      cols: 2,
      gap: 1,
    })
    expect(built.rows).toBe(2)
    expect(built.sheet.width).toBe(5)
    expect(built.sheet.height).toBe(3)
    expect(built.map.map((t) => [t.candidate_id, t.x, t.y])).toEqual([
      ['cand_0001', 0, 0],
      ['cand_0002', 3, 0],
      ['cand_0003', 0, 2],
    ])
    expect(built.sheet.rgba[(0 * 5 + 3) * 4]).toBe(2)
  })
})
