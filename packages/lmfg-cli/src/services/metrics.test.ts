// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { computeImageMetrics } from './metrics'

function solid(
  width: number,
  height: number,
  [r, g, b]: [number, number, number],
) {
  const rgba = new Uint8ClampedArray(width * height * 4)
  for (let p = 0; p < width * height; p += 1) rgba.set([r, g, b, 255], p * 4)
  return rgba
}

describe('computeImageMetrics', () => {
  it('measures white as clipped highlights with zero saturation', () => {
    const m = computeImageMetrics(solid(8, 4, [255, 255, 255]), 8, 4)
    expect(m.schema).toBe('lmfg.metrics.v1')
    expect(m.luma.mean).toBeCloseTo(1, 5)
    expect(m.luma.clipped_highlight_ratio).toBe(1)
    expect(m.luma.clipped_shadow_ratio).toBe(0)
    expect(m.chroma.mean_saturation).toBe(0)
    expect(m.histogram.luma.reduce((a, b) => a + b, 0)).toBe(m.sampled_pixels)
  })

  it('measures black as clipped shadows and red as saturated', () => {
    expect(
      computeImageMetrics(solid(4, 4, [0, 0, 0]), 4, 4).luma
        .clipped_shadow_ratio,
    ).toBe(1)
    const red = computeImageMetrics(solid(4, 4, [255, 0, 0]), 4, 4)
    expect(red.chroma.mean_saturation).toBe(1)
    expect(red.chroma.colorfulness).toBeGreaterThan(50)
    expect(red.approximate).toBe(false)
  })

  it('subsamples large images and flags approximate results', () => {
    const m = computeImageMetrics(
      solid(1000, 1000, [128, 128, 128]),
      1000,
      1000,
      {
        maxSamples: 1000,
        approximate: true,
      },
    )
    expect(m.sampled_pixels).toBeLessThanOrEqual(1001)
    expect(m.luma.p50).toBeCloseTo(128 / 255, 3)
    expect(m.approximate).toBe(true)
  })
})
