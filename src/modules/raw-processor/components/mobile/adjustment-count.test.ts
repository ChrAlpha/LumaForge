import { describe, expect, it } from 'vitest'

import { COLOR_NEUTRAL } from '../color-fields'
import { TONE_NEUTRAL } from '../tone-fields'
import type { HSLToolValue } from '../tools/HSLTool'
import { countAdjustments } from './adjustment-count'

const neutralBand = { hue: 0, saturation: 0, lightness: 0 }
const neutralHsl: HSLToolValue = {
  red: neutralBand,
  orange: neutralBand,
  yellow: neutralBand,
  green: neutralBand,
  aqua: neutralBand,
  blue: neutralBand,
  purple: neutralBand,
  magenta: neutralBand,
}

describe('countAdjustments', () => {
  it('counts nothing at neutral, with or without HSL', () => {
    expect(
      countAdjustments({
        tone: TONE_NEUTRAL,
        color: COLOR_NEUTRAL,
        selectiveColor: undefined,
      }),
    ).toBe(0)
    expect(
      countAdjustments({
        tone: TONE_NEUTRAL,
        color: COLOR_NEUTRAL,
        selectiveColor: neutralHsl,
      }),
    ).toBe(0)
  })

  it('counts every tone, colour and HSL field away from neutral once', () => {
    expect(
      countAdjustments({
        tone: { ...TONE_NEUTRAL, userExposureEv: 0.3, userShadows: -12 },
        color: { ...COLOR_NEUTRAL, userTemperature: 400 },
        selectiveColor: {
          ...neutralHsl,
          red: { hue: 4, saturation: -10, lightness: 0 },
          blue: { hue: 0, saturation: 0, lightness: 8 },
        },
      }),
    ).toBe(6)
  })
})
