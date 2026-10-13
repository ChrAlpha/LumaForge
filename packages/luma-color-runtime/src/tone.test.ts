import { describe, expect, it } from 'vitest'

import type { RegionalToneScaleInput } from './tone'
import {
  contrastFactorFromAmount,
  contrastScaleFromLuminance,
  normalizeToneParams,
  regionalToneScaleFromLuminance,
  USER_CONTRAST_PIVOT,
  userExposureMultiplierFromEv,
} from './tone'

/** Luminance after contrast at `amount`, as the executor scales it. */
function contrasted(luminance: number, amount: number) {
  return (
    luminance *
    contrastScaleFromLuminance(
      luminance,
      contrastFactorFromAmount(amount),
      USER_CONTRAST_PIVOT,
    )
  )
}

const NO_REGIONAL_TONE: RegionalToneScaleInput = {
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
}

/** Luminance after regional tone, as the executor scales it. */
function regional(luminance: number, input: Partial<RegionalToneScaleInput>) {
  return (
    luminance *
    regionalToneScaleFromLuminance(luminance, {
      ...NO_REGIONAL_TONE,
      ...input,
    })
  )
}

describe('tone math', () => {
  it('normalizes missing and invalid tone params to neutral', () => {
    expect(normalizeToneParams(undefined)).toEqual({
      userExposureEv: 0,
      userContrast: 0,
      userHighlights: 0,
      userShadows: 0,
      userWhites: 0,
      userBlacks: 0,
    })
    expect(
      normalizeToneParams({
        userExposureEv: Number.NaN,
        userContrast: Infinity,
        userHighlights: -Infinity,
        userShadows: Number.NaN,
        userWhites: Infinity,
        userBlacks: Number.NaN,
      }),
    ).toEqual({
      userExposureEv: 0,
      userContrast: 0,
      userHighlights: 0,
      userShadows: 0,
      userWhites: 0,
      userBlacks: 0,
    })
  })

  it('clamps tone params to the public editing range', () => {
    expect(
      normalizeToneParams({
        userExposureEv: 12,
        userContrast: -180,
        userHighlights: 125,
        userShadows: -125,
        userWhites: 140,
        userBlacks: -140,
      }),
    ).toEqual({
      userExposureEv: 5,
      userContrast: -100,
      userHighlights: 100,
      userShadows: -100,
      userWhites: 100,
      userBlacks: -100,
    })
  })

  it('maps exposure stops and contrast amount to bounded factors', () => {
    expect(userExposureMultiplierFromEv(1)).toBe(2)
    expect(userExposureMultiplierFromEv(-1)).toBe(0.5)
    expect(contrastFactorFromAmount(-100)).toBeCloseTo(Math.SQRT1_2, 12)
    expect(contrastFactorFromAmount(0)).toBe(1)
    expect(contrastFactorFromAmount(100)).toBeCloseTo(Math.SQRT2, 12)
  })

  it('leaves black and the 18 percent pivot stable under contrast', () => {
    for (const amount of [-100, 50, 100]) {
      expect(contrasted(0, amount)).toBe(0)
      expect(contrasted(USER_CONTRAST_PIVOT, amount)).toBeCloseTo(
        USER_CONTRAST_PIVOT,
        12,
      )
    }
    expect(contrastScaleFromLuminance(-0.1, Math.SQRT2, 0.18)).toBe(0)
  })

  it('spreads luminance away from the pivot for positive contrast', () => {
    expect(contrasted(0.09, 60)).toBeLessThan(0.09)
    expect(contrasted(0.72, 60)).toBeGreaterThan(0.72)
    expect(contrasted(0.09, -60)).toBeGreaterThan(0.09)
    expect(contrasted(0.72, -60)).toBeLessThan(0.72)
  })

  it.each([1e-8, 1e-6, 1e-4])(
    'keeps near-black positive luminance continuous for Y=%s',
    (y) => {
      expect(contrasted(y, -100)).toBeGreaterThan(y)
      expect(contrasted(y, 100)).toBeLessThan(y)
      expect(contrasted(y, 100)).toBeGreaterThanOrEqual(0)
    },
  )

  it('keeps neutral regional tone as an exact unit scale at any luminance', () => {
    for (const y of [-0.25, 0, 0.18, 2]) {
      expect(regionalToneScaleFromLuminance(y, NO_REGIONAL_TONE)).toBe(1)
    }
    expect(
      regionalToneScaleFromLuminance(-0.1, {
        ...NO_REGIONAL_TONE,
        shadows: 50,
      }),
    ).toBe(0)
  })

  it('applies highlights and whites primarily to bright scene-linear ranges', () => {
    const input = { highlights: 100, whites: 100 }

    expect(regional(0.02, input)).toBeCloseTo(0.02, 6)
    expect(regional(1.2, input) - 1.2).toBeGreaterThan(
      regional(0.18, input) - 0.18,
    )
    expect(regional(0.18, input)).toBeGreaterThanOrEqual(0.18)
  })

  it('applies shadows and blacks primarily to dark scene-linear ranges', () => {
    const input = { shadows: 100, blacks: 100 }

    expect(regional(0, input)).toBe(0)
    expect(regional(0.01, input) / 0.01).toBeGreaterThan(
      regional(0.18, input) / 0.18,
    )
    expect(regional(1.2, input)).toBeCloseTo(1.2, 6)
  })

  it('keeps regional tone monotonic on a grayscale ramp for each slider endpoint', () => {
    const cases = [
      { highlights: 100 },
      { highlights: -100 },
      { shadows: 100 },
      { shadows: -100 },
      { whites: 100 },
      { whites: -100 },
      { blacks: 100 },
      { blacks: -100 },
    ]

    for (const input of cases) {
      let previous = regional(0, input)
      for (const y of [
        1e-6, 3e-6, 1e-5, 3e-5, 1e-4, 3e-4, 1e-3, 3e-3, 1e-2, 3e-2, 0.1, 0.18,
        0.3, 0.6, 1, 2, 4, 8,
      ]) {
        const next = regional(y, input)
        expect(next).toBeGreaterThanOrEqual(previous)
        previous = next
      }
    }
  })
})
