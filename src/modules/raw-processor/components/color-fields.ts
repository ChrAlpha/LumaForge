import {
  NEUTRAL_USER_COLOR_INTENT,
  USER_COLOR_FIELD_BOUNDS,
} from '@lumaforge/luma-color-runtime'
import { z } from 'zod'

import type { Translate } from '~/lib/i18n'

import { boundedColorNumber } from './fields/bounded-color-number'

export const ColorValueSchema = z.object({
  userTemperature: boundedColorNumber('userTemperature'),
  userTint: boundedColorNumber('userTint'),
  userSaturation: boundedColorNumber('userSaturation'),
  userVibrance: boundedColorNumber('userVibrance'),
})

export type ColorValue = z.infer<typeof ColorValueSchema>

export type ColorField = {
  key: keyof ColorValue
  labelKey: Parameters<Translate>[0]
  short: string
  min: number
  max: number
  step: number
  unit: string
}

export const COLOR_FIELDS: ColorField[] = [
  {
    key: 'userTemperature',
    labelKey: 'raw.color.temperature',
    short: 'TEMP',
    ...USER_COLOR_FIELD_BOUNDS.userTemperature,
    step: 1,
    unit: '',
  },
  {
    key: 'userTint',
    labelKey: 'raw.color.tint',
    short: 'TINT',
    ...USER_COLOR_FIELD_BOUNDS.userTint,
    step: 1,
    unit: '',
  },
  {
    key: 'userSaturation',
    labelKey: 'raw.color.saturation',
    short: 'SAT',
    ...USER_COLOR_FIELD_BOUNDS.userSaturation,
    step: 1,
    unit: '',
  },
  {
    key: 'userVibrance',
    labelKey: 'raw.color.vibrance',
    short: 'VIB',
    ...USER_COLOR_FIELD_BOUNDS.userVibrance,
    step: 1,
    unit: '',
  },
]

export const COLOR_NEUTRAL: ColorValue = {
  userTemperature: NEUTRAL_USER_COLOR_INTENT.userTemperature,
  userTint: NEUTRAL_USER_COLOR_INTENT.userTint,
  userSaturation: NEUTRAL_USER_COLOR_INTENT.userSaturation,
  userVibrance: NEUTRAL_USER_COLOR_INTENT.userVibrance,
}

export function isColorNeutral(value: ColorValue): boolean {
  return COLOR_FIELDS.every((f) => value[f.key] === 0)
}

const sign = (v: number) => (v > 0 ? '+' : '')

export function formatColorValueShort(_key: keyof ColorValue, v: number) {
  const rounded = Math.round(v)
  return `${sign(rounded)}${rounded}`
}

export function formatColorValue(key: keyof ColorValue, v: number) {
  return formatColorValueShort(key, v)
}
