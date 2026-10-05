import { describe, expect, it } from 'vitest'

import {
  estimateRawRenderExposureFromRgbU16,
  resolveRawRenderExposure,
} from './raw-render-exposure'

function neutralRgb(values: number[]) {
  return new Uint16Array(
    values.flatMap((value) => {
      const code = Math.round(value * 65535)
      return [code, code, code]
    }),
  )
}

describe('raw render exposure', () => {
  it('uses finite DNG baseline exposure as an EV multiplier', () => {
    expect(
      resolveRawRenderExposure({
        metadata: { baselineExposure: 1.5 },
        image: null,
      }),
    ).toEqual({
      ev: 1.5,
      multiplier: Math.pow(2, 1.5),
      source: 'dng-baseline',
    })
  })

  it('clamps metadata exposure to the automatic safety range', () => {
    expect(
      resolveRawRenderExposure({
        metadata: { baselineExposure: 9 },
        image: null,
      }),
    ).toMatchObject({ ev: 3, source: 'dng-baseline' })
  })

  it('estimates a deterministic fallback from RGB16 luminance percentile', () => {
    const data = new Uint16Array([
      8192, 8192, 8192, 16384, 16384, 16384, 24576, 24576, 24576, 32768, 32768,
      32768,
    ])

    const exposure = estimateRawRenderExposureFromRgbU16({
      data,
      width: 4,
      height: 1,
    })

    expect(exposure.source).toBe('image-statistics')
    expect(exposure.ev).toBeCloseTo(0.999977986052736, 12)
    expect(exposure.multiplier).toBeCloseTo(1.999969482421875, 12)
  })

  it('limits statistical lift when sparse high-key highlights need headroom', () => {
    const luminance = [
      ...Array.from<number>({ length: 90 }).fill(0.02),
      ...Array.from<number>({ length: 5 }).fill(0.15181709606469823),
      ...Array.from<number>({ length: 4 }).fill(0.26330750196536207),
      0.7245288776989395,
    ]

    const exposure = estimateRawRenderExposureFromRgbU16({
      data: neutralRgb(luminance),
      width: luminance.length,
      height: 1,
    })

    expect(exposure.source).toBe('image-statistics')
    expect(exposure.ev).toBeCloseTo(1.3036791481460117, 12)
    expect(exposure.multiplier).toBeCloseTo(2.468576147426982, 12)
  })

  it('does not turn highlight protection into negative EV for dark frames', () => {
    const luminance = [
      ...Array.from<number>({ length: 95 }).fill(0.1),
      ...Array.from<number>({ length: 5 }).fill(0.9),
    ]

    const exposure = estimateRawRenderExposureFromRgbU16({
      data: neutralRgb(luminance),
      width: luminance.length,
      height: 1,
    })

    expect(exposure).toEqual({
      ev: 0,
      multiplier: 1,
      source: 'image-statistics',
    })
  })

  it('clamps statistics fallback exposure to the automatic safety range', () => {
    const exposure = estimateRawRenderExposureFromRgbU16({
      data: new Uint16Array([2, 2, 2]),
      width: 1,
      height: 1,
    })

    expect(exposure).toEqual({
      ev: 3,
      multiplier: 8,
      source: 'image-statistics',
    })
  })

  it.each([
    { width: -1, height: -1 },
    { width: 0.5, height: 2 },
    { width: Number.POSITIVE_INFINITY, height: 1 },
  ])(
    'falls back to identity for invalid dimensions %#',
    ({ width, height }) => {
      expect(
        estimateRawRenderExposureFromRgbU16({
          data: new Uint16Array([4096, 4096, 4096]),
          width,
          height,
        }),
      ).toEqual({ ev: 0, multiplier: 1, source: 'identity' })
    },
  )

  it.each([
    new Uint16Array([4096, 4096]),
    new Uint16Array([4096, 4096, 4096, 4096]),
  ])('falls back to identity for invalid RGB16 data length %#', (data) => {
    expect(
      estimateRawRenderExposureFromRgbU16({
        data,
        width: 1,
        height: 1,
      }),
    ).toEqual({ ev: 0, multiplier: 1, source: 'identity' })
  })

  it('falls back to identity when pixels are unusable', () => {
    expect(
      resolveRawRenderExposure({
        metadata: {},
        image: { data: new Uint16Array([0, 0, 0]), width: 1, height: 1 },
      }),
    ).toEqual({ ev: 0, multiplier: 1, source: 'identity' })
  })
})
