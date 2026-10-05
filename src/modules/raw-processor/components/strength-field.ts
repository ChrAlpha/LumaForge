import type { Translate } from '~/lib/i18n'

import {
  clampLookIntensity,
  DEFAULT_LOOK_INTENSITY,
  LOOK_INTENSITY_PRESETS,
} from '../services/look/style-system'
import type { SliderTickMark } from './tools/SliderTicks'

/**
 * The Strength row on both surfaces: how much of the applied LUT reaches
 * the photo, set in whole percents. The session keeps the amount as 0..1;
 * the row works in percent so a step is one visible unit.
 */
export const STRENGTH_FIELD = {
  min: 0,
  max: 100,
  step: 1,
  /** The reset target: a look's default amount. */
  neutral: Math.round(DEFAULT_LOOK_INTENSITY * 100),
} as const

export interface StrengthTick {
  value: number
  labelKey: Parameters<Translate>[0]
}

/** The named presets, as the detents a scrub sticks to and their labels. */
export const STRENGTH_TICKS: readonly StrengthTick[] = [
  {
    value: Math.round(LOOK_INTENSITY_PRESETS.light * 100),
    labelKey: 'raw.strength.light',
  },
  {
    value: Math.round(LOOK_INTENSITY_PRESETS.standard * 100),
    labelKey: 'raw.strength.standard',
  },
  {
    value: Math.round(LOOK_INTENSITY_PRESETS.strong * 100),
    labelKey: 'raw.strength.strong',
  },
]

export const STRENGTH_DETENTS: readonly number[] = STRENGTH_TICKS.map(
  (tick) => tick.value,
)

export function strengthTickMarks(t: Translate): SliderTickMark[] {
  return STRENGTH_TICKS.map((tick) => ({
    value: tick.value,
    label: t(tick.labelKey),
  }))
}

export function intensityToStrengthPercent(intensity: number): number {
  return Math.round(clampLookIntensity(intensity) * 100)
}

export function strengthPercentToIntensity(percent: number): number {
  return clampLookIntensity(percent / 100)
}

/** "62%", and "Off" at 0, where none of the look reaches the photo. */
export function formatStrengthPercent(percent: number, t: Translate): string {
  return percent === 0 ? t('raw.strength.off') : `${percent}%`
}
