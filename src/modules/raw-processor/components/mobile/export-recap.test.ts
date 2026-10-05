import { describe, expect, it } from 'vitest'

import { COLOR_NEUTRAL } from '../color-fields'
import { TONE_NEUTRAL } from '../tone-fields'
import { buildMobileExportRecap, countAdjustments } from './export-recap'

const neutral = {
  tone: TONE_NEUTRAL,
  color: COLOR_NEUTRAL,
  selectiveColor: undefined,
}

describe('countAdjustments', () => {
  it('counts every Adjust field away from neutral once', () => {
    expect(countAdjustments(neutral)).toBe(0)
    expect(
      countAdjustments({
        tone: { ...TONE_NEUTRAL, userExposureEv: 0.3, userShadows: -12 },
        color: { ...COLOR_NEUTRAL, userTemperature: 400 },
        selectiveColor: {
          red: { hue: 4, saturation: -10, lightness: 0 },
          orange: { hue: 0, saturation: 0, lightness: 0 },
          yellow: { hue: 0, saturation: 0, lightness: 0 },
          green: { hue: 0, saturation: 0, lightness: 0 },
          aqua: { hue: 0, saturation: 0, lightness: 0 },
          blue: { hue: 0, saturation: 0, lightness: 8 },
          purple: { hue: 0, saturation: 0, lightness: 0 },
          magenta: { hue: 0, saturation: 0, lightness: 0 },
        },
      }),
    ).toBe(6)
  })
})

describe('buildMobileExportRecap', () => {
  it('reads only state: size when known, the look and its strength, Transform', () => {
    expect(
      buildMobileExportRecap({
        ...neutral,
        deliveredSize: { width: 9728, height: 6656 },
        lutName: 'ARRI 3110 Film A',
        intensity: 0.62,
        transformApplied: true,
      }),
    ).toEqual({
      size: { width: 9728, height: 6656 },
      // The exact amount, as the whole percent the Strength row sets.
      look: { name: 'ARRI 3110 Film A', percent: 62 },
      adjustments: 0,
      transformApplied: true,
    })

    expect(
      buildMobileExportRecap({
        ...neutral,
        deliveredSize: undefined,
        lutName: null,
        intensity: 0.7,
        transformApplied: false,
      }),
    ).toEqual({
      size: null,
      look: null,
      adjustments: 0,
      transformApplied: false,
    })
  })
})
