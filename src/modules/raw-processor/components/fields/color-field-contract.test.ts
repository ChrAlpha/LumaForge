import {
  HSL_BAND_IDS,
  HSL_SHIFT_AXES,
  HSL_SHIFT_BOUNDS,
  NEUTRAL_USER_COLOR_INTENT,
  USER_COLOR_FIELD_BOUNDS,
  USER_COLOR_SCALAR_KEYS,
} from '@lumaforge/luma-color-runtime'
import { describe, expect, it } from 'vitest'

import enMessages from '~/locales/en.json'

import {
  COLOR_FIELDS,
  COLOR_NEUTRAL,
  formatColorValueShort,
  isColorNeutral,
} from '../color-fields'
import {
  formatToneValue,
  formatToneValueShort,
  isToneNeutral,
  TONE_FIELDS,
  TONE_NEUTRAL,
} from '../tone-fields'
import {
  formatHSLValueShort,
  HSL_BAND_LABEL_KEY,
  HSL_BAND_ORDER,
  HSL_BAND_SWATCH,
  HSL_FIELDS,
  isHSLBandNeutral,
  isHSLNeutral,
} from './hsl-fields'

function row(field: {
  key: string
  min: number
  max: number
  step: number
}): [string, number, number, number] {
  return [field.key, field.min, field.max, field.step]
}

describe('adjust field tables', () => {
  it('lists every tone field with its range and step, in order', () => {
    expect(TONE_FIELDS.map(row)).toEqual([
      ['userExposureEv', -5, 5, 0.01],
      ['userContrast', -100, 100, 1],
      ['userHighlights', -100, 100, 1],
      ['userShadows', -100, 100, 1],
      ['userWhites', -100, 100, 1],
      ['userBlacks', -100, 100, 1],
    ])
    expect(TONE_FIELDS.map((f) => f.group)).toEqual([
      'basic',
      'basic',
      'fine',
      'fine',
      'fine',
      'fine',
    ])
  })

  it('lists every color field with its range and step, in order', () => {
    expect(COLOR_FIELDS.map(row)).toEqual([
      ['userTemperature', -100, 100, 1],
      ['userTint', -100, 100, 1],
      ['userSaturation', -100, 100, 1],
      ['userVibrance', -100, 100, 1],
    ])
  })

  it('lists every HSL axis with its range and step, in order', () => {
    expect(HSL_FIELDS.map(row)).toEqual([
      ['hue', -100, 100, 1],
      ['saturation', -100, 100, 1],
      ['lightness', -100, 100, 1],
    ])
    expect(HSL_BAND_ORDER).toEqual([
      'red',
      'orange',
      'yellow',
      'green',
      'aqua',
      'blue',
      'purple',
      'magenta',
    ])
  })

  it('covers exactly the user color fields of the color intent, in pipeline order', () => {
    expect([...TONE_FIELDS, ...COLOR_FIELDS].map((f) => f.key)).toEqual([
      ...USER_COLOR_SCALAR_KEYS,
    ])
    expect(HSL_FIELDS.map((f) => f.key)).toEqual([...HSL_SHIFT_AXES])
    expect([...HSL_BAND_ORDER]).toEqual([...HSL_BAND_IDS])
  })

  it('takes every range from the color intent clamps', () => {
    for (const field of [...TONE_FIELDS, ...COLOR_FIELDS]) {
      expect({ min: field.min, max: field.max }).toEqual(
        USER_COLOR_FIELD_BOUNDS[field.key],
      )
    }
    for (const field of HSL_FIELDS) {
      expect({ min: field.min, max: field.max }).toEqual(HSL_SHIFT_BOUNDS)
    }
  })

  it('resets to the neutral of the color intent', () => {
    for (const field of TONE_FIELDS) {
      expect(TONE_NEUTRAL[field.key]).toBe(NEUTRAL_USER_COLOR_INTENT[field.key])
    }
    for (const field of COLOR_FIELDS) {
      expect(COLOR_NEUTRAL[field.key]).toBe(
        NEUTRAL_USER_COLOR_INTENT[field.key],
      )
    }
    expect(Object.keys(TONE_NEUTRAL)).toEqual(TONE_FIELDS.map((f) => f.key))
    expect(Object.keys(COLOR_NEUTRAL)).toEqual(COLOR_FIELDS.map((f) => f.key))
    expect(isToneNeutral(TONE_NEUTRAL)).toBe(true)
    expect(isColorNeutral(COLOR_NEUTRAL)).toBe(true)
    expect(isHSLNeutral(NEUTRAL_USER_COLOR_INTENT.selectiveColor)).toBe(true)
  })

  it('names one field away from neutral as not neutral', () => {
    for (const field of TONE_FIELDS) {
      expect(isToneNeutral({ ...TONE_NEUTRAL, [field.key]: field.step })).toBe(
        false,
      )
    }
    for (const field of COLOR_FIELDS) {
      expect(
        isColorNeutral({ ...COLOR_NEUTRAL, [field.key]: -field.step }),
      ).toBe(false)
    }
    for (const band of HSL_BAND_ORDER) {
      for (const field of HSL_FIELDS) {
        const shifted = {
          ...NEUTRAL_USER_COLOR_INTENT.selectiveColor,
          [band]: { hue: 0, saturation: 0, lightness: 0, [field.key]: 1 },
        }
        expect(isHSLBandNeutral(shifted[band])).toBe(false)
        expect(isHSLNeutral(shifted)).toBe(false)
      }
    }
    expect(isHSLNeutral(undefined)).toBe(true)
  })

  it('keeps labels and swatches app-owned for every band and axis', () => {
    const messages = enMessages as Record<string, string>
    for (const field of [...TONE_FIELDS, ...COLOR_FIELDS, ...HSL_FIELDS]) {
      expect(messages[field.labelKey]).toBeTruthy()
    }
    expect(HSL_FIELDS.map((f) => [f.labelKey, f.short])).toEqual([
      ['raw.hsl.fields.hue', 'HUE'],
      ['raw.hsl.fields.saturation', 'SAT'],
      ['raw.hsl.fields.lightness', 'LIGHT'],
    ])
    for (const band of HSL_BAND_ORDER) {
      expect(HSL_BAND_LABEL_KEY[band]).toBe(`raw.hsl.bands.${band}`)
      expect(HSL_BAND_SWATCH[band]).toMatch(/^oklch\(/)
    }
    expect(Object.keys(HSL_BAND_LABEL_KEY)).toEqual([...HSL_BAND_ORDER])
    expect(Object.keys(HSL_BAND_SWATCH)).toEqual([...HSL_BAND_ORDER])
  })

  it('formats every field the way the rows and the HUD read it', () => {
    expect(formatToneValue('userExposureEv', 1.5)).toBe('+1.50 EV')
    expect(formatToneValueShort('userExposureEv', -0.25)).toBe('-0.25')
    expect(formatToneValue('userContrast', 40.4)).toBe('+40')
    expect(formatToneValue('userBlacks', 0)).toBe('0')
    expect(formatColorValueShort('userTint', -12.6)).toBe('-13')
    expect(formatColorValueShort('userVibrance', 0)).toBe('0')
    expect(formatHSLValueShort('hue', 4.6)).toBe('+5')
    expect(formatHSLValueShort('lightness', -8)).toBe('-8')
    expect(formatHSLValueShort('saturation', 0)).toBe('0')
  })
})
