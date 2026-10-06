import { describe, expect, it } from 'vitest'

import type { Translate } from '~/lib/i18n'
import enMessages from '~/locales/en.json'

import {
  DEFAULT_LOOK_INTENSITY,
  LOOK_INTENSITY_PRESETS,
} from '../services/look/style-system'
import {
  formatStrengthPercent,
  intensityToStrengthPercent,
  STRENGTH_DETENTS,
  STRENGTH_FIELD,
  STRENGTH_TICKS,
  strengthPercentToIntensity,
  strengthTickMarks,
} from './strength-field'
import { createScrubSession } from './tools/slider-scrub-model'

const t = ((key: string) =>
  (enMessages as Record<string, string>)[key] ?? key) as Translate

describe('strength field', () => {
  it('works in whole percents and resets to a look default of 70%', () => {
    expect(STRENGTH_FIELD).toEqual({ min: 0, max: 100, step: 1, neutral: 70 })
    expect(STRENGTH_FIELD.neutral).toBe(
      Math.round(DEFAULT_LOOK_INTENSITY * 100),
    )
  })

  it('sticks at Light, Standard and Strong as plain detent values', () => {
    expect(STRENGTH_DETENTS).toEqual([40, 70, 100])
    expect(STRENGTH_TICKS.map((tick) => tick.labelKey)).toEqual([
      'raw.strength.light',
      'raw.strength.standard',
      'raw.strength.strong',
    ])
    expect(STRENGTH_DETENTS).toEqual(
      Object.values(LOOK_INTENSITY_PRESETS).map((v) => Math.round(v * 100)),
    )
    expect(strengthTickMarks(t)).toEqual([
      { value: 40, label: 'Light' },
      { value: 70, label: 'Standard' },
      { value: 100, label: 'Strong' },
    ])
  })

  it('stores a continuous 0..1 amount that round-trips through percent', () => {
    for (const percent of [0, 1, 37, 40, 62, 70, 99, 100]) {
      const intensity = strengthPercentToIntensity(percent)
      expect(intensity).toBeCloseTo(percent / 100, 12)
      expect(intensityToStrengthPercent(intensity)).toBe(percent)
    }
    // An amount between detents is never snapped to one.
    expect(strengthPercentToIntensity(37)).toBe(0.37)
    expect(strengthPercentToIntensity(62)).toBe(0.62)
    expect(intensityToStrengthPercent(0.374)).toBe(37)
    expect(intensityToStrengthPercent(0.616)).toBe(62)
  })

  it('clamps outside the domain and reads a non-number as the default', () => {
    expect(strengthPercentToIntensity(140)).toBe(1)
    expect(strengthPercentToIntensity(-5)).toBe(0)
    expect(intensityToStrengthPercent(1.4)).toBe(100)
    expect(intensityToStrengthPercent(-0.2)).toBe(0)
    expect(intensityToStrengthPercent(Number.NaN)).toBe(70)
    expect(strengthPercentToIntensity(Number.NaN)).toBe(DEFAULT_LOOK_INTENSITY)
  })

  it('reads 0 as Off and every other amount as a percent', () => {
    expect(formatStrengthPercent(0, t)).toBe('Off')
    expect(formatStrengthPercent(1, t)).toBe('1%')
    expect(formatStrengthPercent(37, t)).toBe('37%')
    expect(formatStrengthPercent(62, t)).toBe('62%')
    expect(formatStrengthPercent(100, t)).toBe('100%')
  })

  it('parks a scrub on its detents and still lands between them', () => {
    // 200px track: 2px per percent, ticks at x=180 (40), 240 (70), 300 (100).
    const scrub = (startX: number) =>
      createScrubSession({
        ...STRENGTH_FIELD,
        detents: STRENGTH_DETENTS,
        track: { left: 100, width: 200, centerY: 50 },
        pointerType: 'mouse',
        startValue: 0,
        startX,
        startY: 50,
      })
    const up = scrub(160)
    expect(up.value).toBe(30)
    expect(up.move(190, 50, {}).value).toBe(40)
    const free = scrub(160)
    // 37% sits between detents and is reachable as is.
    expect(free.move(174, 50, {}).value).toBe(37)
    const fine = scrub(220)
    expect(fine.value).toBe(60)
    expect(fine.move(224, 50, {}).value).toBe(62)
    // Shift scrubs at one tenth: 40px of travel is 2%, not 20%.
    const shifted = scrub(220)
    expect(shifted.move(260, 50, { shift: true }).value).toBe(62)
  })
})
