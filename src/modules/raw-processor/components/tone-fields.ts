import type { UserColorIntent } from '@lumaforge/luma-color-runtime'
import {
  NEUTRAL_USER_COLOR_INTENT,
  USER_COLOR_FIELD_BOUNDS,
} from '@lumaforge/luma-color-runtime'

import type { Translate } from '~/lib/i18n'

export type ToneValue = Pick<
  UserColorIntent,
  | 'userExposureEv'
  | 'userContrast'
  | 'userHighlights'
  | 'userShadows'
  | 'userWhites'
  | 'userBlacks'
>

export type ToneField = {
  key: keyof ToneValue
  labelKey: Parameters<Translate>[0]
  short: string
  min: number
  max: number
  step: number
  unit: string
  group: 'basic' | 'fine'
}

export const TONE_FIELDS: ToneField[] = [
  {
    key: 'userExposureEv',
    labelKey: 'raw.tone.exposure',
    short: 'EXP',
    ...USER_COLOR_FIELD_BOUNDS.userExposureEv,
    step: 0.01,
    unit: 'EV',
    group: 'basic',
  },
  {
    key: 'userContrast',
    labelKey: 'raw.tone.contrast',
    short: 'CON',
    ...USER_COLOR_FIELD_BOUNDS.userContrast,
    step: 1,
    unit: '',
    group: 'basic',
  },
  {
    key: 'userHighlights',
    labelKey: 'raw.tone.highlights',
    short: 'HIGH',
    ...USER_COLOR_FIELD_BOUNDS.userHighlights,
    step: 1,
    unit: '',
    group: 'fine',
  },
  {
    key: 'userShadows',
    labelKey: 'raw.tone.shadows',
    short: 'SHAD',
    ...USER_COLOR_FIELD_BOUNDS.userShadows,
    step: 1,
    unit: '',
    group: 'fine',
  },
  {
    key: 'userWhites',
    labelKey: 'raw.tone.whites',
    short: 'WHT',
    ...USER_COLOR_FIELD_BOUNDS.userWhites,
    step: 1,
    unit: '',
    group: 'fine',
  },
  {
    key: 'userBlacks',
    labelKey: 'raw.tone.blacks',
    short: 'BLK',
    ...USER_COLOR_FIELD_BOUNDS.userBlacks,
    step: 1,
    unit: '',
    group: 'fine',
  },
]

export const TONE_NEUTRAL: ToneValue = {
  userExposureEv: NEUTRAL_USER_COLOR_INTENT.userExposureEv,
  userContrast: NEUTRAL_USER_COLOR_INTENT.userContrast,
  userHighlights: NEUTRAL_USER_COLOR_INTENT.userHighlights,
  userShadows: NEUTRAL_USER_COLOR_INTENT.userShadows,
  userWhites: NEUTRAL_USER_COLOR_INTENT.userWhites,
  userBlacks: NEUTRAL_USER_COLOR_INTENT.userBlacks,
}

export function isToneNeutral(value: ToneValue): boolean {
  return TONE_FIELDS.every((f) => value[f.key] === 0)
}

const sign = (v: number) => (v > 0 ? '+' : '')

export function formatToneValueShort(key: keyof ToneValue, v: number): string {
  if (key === 'userExposureEv') return `${sign(v)}${v.toFixed(2)}`
  return `${sign(v)}${Math.round(v)}`
}

export function formatToneValue(key: keyof ToneValue, v: number): string {
  if (key === 'userExposureEv') return `${formatToneValueShort(key, v)} EV`
  return formatToneValueShort(key, v)
}
