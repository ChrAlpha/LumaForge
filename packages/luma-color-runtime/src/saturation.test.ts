import { describe, expect, it } from 'vitest'

import { linearProPhotoToOklab } from './oklab'
import {
  applyUserSaturationTo,
  normalizeSaturationParams,
  USER_SATURATION_MAX,
  USER_SATURATION_MIN,
  USER_VIBRANCE_MAX,
  USER_VIBRANCE_MIN,
} from './saturation'

describe('saturation', () => {
  describe('normalizeSaturationParams', () => {
    it('defaults missing input to identity', () => {
      expect(normalizeSaturationParams()).toEqual({
        userSaturation: 0,
        userVibrance: 0,
      })
      expect(normalizeSaturationParams(null)).toEqual({
        userSaturation: 0,
        userVibrance: 0,
      })
      expect(normalizeSaturationParams({})).toEqual({
        userSaturation: 0,
        userVibrance: 0,
      })
    })

    it('clamps out-of-range values', () => {
      expect(
        normalizeSaturationParams({ userSaturation: 200, userVibrance: -300 }),
      ).toEqual({ userSaturation: 100, userVibrance: -100 })
    })

    it('replaces non-finite with zero', () => {
      expect(
        normalizeSaturationParams({
          userSaturation: Number.NaN,
          userVibrance: Number.POSITIVE_INFINITY,
        }),
      ).toEqual({ userSaturation: 0, userVibrance: 0 })
    })

    it('passes through valid values', () => {
      expect(
        normalizeSaturationParams({ userSaturation: -50, userVibrance: 75 }),
      ).toEqual({ userSaturation: -50, userVibrance: 75 })
    })
  })

  it('exports range constants', () => {
    expect(USER_SATURATION_MIN).toBe(-100)
    expect(USER_SATURATION_MAX).toBe(100)
    expect(USER_VIBRANCE_MIN).toBe(-100)
    expect(USER_VIBRANCE_MAX).toBe(100)
  })
})

function applyAndRead(
  r: number,
  g: number,
  b: number,
  saturation: number,
  vibrance: number,
): { r: number; g: number; b: number } {
  const buf = new Float32Array([r, g, b])
  applyUserSaturationTo(buf, 0, saturation, vibrance)
  return { r: buf[0], g: buf[1], b: buf[2] }
}

function oklabChroma(r: number, g: number, b: number): number {
  const lab = linearProPhotoToOklab(new Float32Array([r, g, b]))
  return Math.sqrt(lab[1] * lab[1] + lab[2] * lab[2])
}

function oklabL(r: number, g: number, b: number): number {
  return linearProPhotoToOklab(new Float32Array([r, g, b]))[0]
}

function oklabHueDeg(r: number, g: number, b: number): number {
  const lab = linearProPhotoToOklab(new Float32Array([r, g, b]))
  return (Math.atan2(lab[2], lab[1]) * 180) / Math.PI
}

describe('applyUserSaturationTo', () => {
  it('identity: S=0 V=0 returns exact input', () => {
    const buf = new Float32Array([0.3, 0.18, 0.05])
    const r0 = buf[0]
    const g0 = buf[1]
    const b0 = buf[2]
    applyUserSaturationTo(buf, 0, 0, 0)
    expect(buf[0]).toBe(r0)
    expect(buf[1]).toBe(g0)
    expect(buf[2]).toBe(b0)
  })

  it('s=+100 approximately doubles chroma, preserves L', () => {
    const r = 0.3
    const g = 0.18
    const b = 0.05
    const chromaBefore = oklabChroma(r, g, b)
    const lBefore = oklabL(r, g, b)
    const out = applyAndRead(r, g, b, 100, 0)
    const chromaAfter = oklabChroma(out.r, out.g, out.b)
    const lAfter = oklabL(out.r, out.g, out.b)
    expect(chromaAfter).toBeCloseTo(chromaBefore * 2, 4)
    expect(lAfter).toBeCloseTo(lBefore, 5)
  })

  it('s=-100 produces near-zero chroma (monochrome)', () => {
    const out = applyAndRead(0.3, 0.18, 0.05, -100, 0)
    expect(oklabChroma(out.r, out.g, out.b)).toBeLessThan(1e-6)
  })

  it('preserves hue when S > 0', () => {
    const r = 0.3
    const g = 0.18
    const b = 0.05
    const hueBefore = oklabHueDeg(r, g, b)
    const out = applyAndRead(r, g, b, 50, 0)
    const hueAfter = oklabHueDeg(out.r, out.g, out.b)
    expect(hueAfter).toBeCloseTo(hueBefore, 3)
  })

  it('v=+100 boosts low-chroma more than high-chroma', () => {
    const lowC = applyAndRead(0.18, 0.17, 0.16, 0, 100)
    const lowBefore = oklabChroma(0.18, 0.17, 0.16)
    const lowAfter = oklabChroma(lowC.r, lowC.g, lowC.b)
    const lowRatio = lowAfter / Math.max(lowBefore, 1e-12)

    const highC = applyAndRead(0.5, 0.05, 0.0, 0, 100)
    const highBefore = oklabChroma(0.5, 0.05, 0.0)
    const highAfter = oklabChroma(highC.r, highC.g, highC.b)
    const highRatio = highAfter / Math.max(highBefore, 1e-12)

    expect(lowRatio).toBeGreaterThan(highRatio)
  })

  it('v=+100 skin hue is dampened vs non-skin hue', () => {
    // Warm muted pixel near skin hue center (~46 deg in OKLab)
    const skinC = applyAndRead(0.15, 0.12, 0.09, 0, 100)
    const skinBefore = oklabChroma(0.15, 0.12, 0.09)
    const skinAfter = oklabChroma(skinC.r, skinC.g, skinC.b)
    const skinRatio = skinAfter / Math.max(skinBefore, 1e-12)

    // Green/cyan pixel far from skin hue (~172 deg in OKLab)
    const greenC = applyAndRead(0.09, 0.15, 0.12, 0, 100)
    const greenBefore = oklabChroma(0.09, 0.15, 0.12)
    const greenAfter = oklabChroma(greenC.r, greenC.g, greenC.b)
    const greenRatio = greenAfter / Math.max(greenBefore, 1e-12)

    expect(skinRatio).toBeLessThan(greenRatio)
  })

  it('s=-100 V=-100 does not invert hue (chromaFactor >= 0)', () => {
    const out = applyAndRead(0.5, 0.1, 0.0, -100, -100)
    expect(oklabChroma(out.r, out.g, out.b)).toBeLessThan(1e-6)
    expect(Number.isFinite(out.r)).toBe(true)
    expect(Number.isFinite(out.g)).toBe(true)
    expect(Number.isFinite(out.b)).toBe(true)
  })

  it('white pixel stays white under any (S, V)', () => {
    for (const [s, v] of [
      [100, 100],
      [-100, -100],
      [50, -50],
    ] as const) {
      const out = applyAndRead(1, 1, 1, s, v)
      const lab = linearProPhotoToOklab(new Float32Array([out.r, out.g, out.b]))
      // Float32 round-trip through OKLab introduces ~3e-4 residual chroma
      expect(Math.abs(lab[1])).toBeLessThan(1e-3)
      expect(Math.abs(lab[2])).toBeLessThan(1e-3)
    }
  })

  it('s and V combine multiplicatively', () => {
    const r = 0.2
    const g = 0.15
    const b = 0.1
    const satOnly = applyAndRead(r, g, b, 50, 0)
    const vibOnly = applyAndRead(r, g, b, 0, 50)
    const both = applyAndRead(r, g, b, 50, 50)

    const chromaBefore = oklabChroma(r, g, b)
    const satFactor =
      oklabChroma(satOnly.r, satOnly.g, satOnly.b) / chromaBefore
    const vibFactor =
      oklabChroma(vibOnly.r, vibOnly.g, vibOnly.b) / chromaBefore
    const bothFactor = oklabChroma(both.r, both.g, both.b) / chromaBefore
    expect(bothFactor).toBeCloseTo(satFactor * vibFactor, 5)
  })

  it('round-trip stability at scene-linear ProPhoto extremes', () => {
    for (const [r, g, b] of [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ] as const) {
      const out = applyAndRead(r, g, b, 100, 100)
      expect(Number.isFinite(out.r)).toBe(true)
      expect(Number.isFinite(out.g)).toBe(true)
      expect(Number.isFinite(out.b)).toBe(true)
    }
  })
})
