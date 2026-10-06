import type {
  HSLBandId,
  HSLBandShift,
  HSLShiftAxis,
  NormalizedSelectiveColorBands,
} from '@lumaforge/luma-color-runtime'
import { HSL_BAND_IDS, HSL_SHIFT_BOUNDS } from '@lumaforge/luma-color-runtime'

import type { Translate } from '~/lib/i18n'

/**
 * The HSL bands in hue-wheel order, red to magenta, as the color runtime
 * lists them. Both surfaces draw their rows in this order.
 */
export const HSL_BAND_ORDER: readonly HSLBandId[] = HSL_BAND_IDS

export type HSLField = {
  key: HSLShiftAxis
  labelKey: Parameters<Translate>[0]
  short: string
  min: number
  max: number
  step: number
}

/** One HSL axis: its range is the runtime clamp, its label app copy. */
function hslField(
  key: HSLShiftAxis,
  labelKey: Parameters<Translate>[0],
  short: string,
): HSLField {
  return {
    key,
    labelKey,
    short,
    min: HSL_SHIFT_BOUNDS.min,
    max: HSL_SHIFT_BOUNDS.max,
    step: 1,
  }
}

/** Every HSL axis of a band, in the runtime's display order. */
export const HSL_FIELDS: readonly HSLField[] = [
  hslField('hue', 'raw.hsl.fields.hue', 'HUE'),
  hslField('saturation', 'raw.hsl.fields.saturation', 'SAT'),
  hslField('lightness', 'raw.hsl.fields.lightness', 'LIGHT'),
]

export const HSL_BAND_LABEL_KEY: Record<HSLBandId, Parameters<Translate>[0]> = {
  red: 'raw.hsl.bands.red',
  orange: 'raw.hsl.bands.orange',
  yellow: 'raw.hsl.bands.yellow',
  green: 'raw.hsl.bands.green',
  aqua: 'raw.hsl.bands.aqua',
  blue: 'raw.hsl.bands.blue',
  purple: 'raw.hsl.bands.purple',
  magenta: 'raw.hsl.bands.magenta',
}

/**
 * Swatch chips that hint at each band's anchor hue on the dark `/raw`
 * surface, one identity per band on both surfaces and in the slider tracks.
 * Anchors live in OKLch inside the runtime; these are recognition cues only.
 */
export const HSL_BAND_SWATCH: Record<HSLBandId, string> = {
  red: 'oklch(0.62 0.21 27)',
  orange: 'oklch(0.74 0.17 55)',
  yellow: 'oklch(0.86 0.17 95)',
  green: 'oklch(0.74 0.18 145)',
  aqua: 'oklch(0.78 0.13 200)',
  blue: 'oklch(0.62 0.18 260)',
  purple: 'oklch(0.58 0.20 305)',
  magenta: 'oklch(0.66 0.22 340)',
}

const sign = (v: number) => (v > 0 ? '+' : '')

export function formatHSLValueShort(_key: HSLShiftAxis, v: number): string {
  const rounded = Math.round(v)
  return `${sign(rounded)}${rounded}`
}

export function isHSLBandNeutral(band: Readonly<HSLBandShift>): boolean {
  return band.hue === 0 && band.saturation === 0 && band.lightness === 0
}

export function isHSLNeutral(
  value: NormalizedSelectiveColorBands | undefined,
): boolean {
  if (!value) return true
  return HSL_BAND_ORDER.every((band) => isHSLBandNeutral(value[band]))
}
