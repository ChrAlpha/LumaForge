import type { ColorValue } from '../color-fields'
import { COLOR_FIELDS } from '../color-fields'
import type { ToneValue } from '../tone-fields'
import { TONE_FIELDS } from '../tone-fields'
import type { HSLToolValue } from '../tools/HSLTool'
import { HSL_BAND_ORDER, MOBILE_HSL_FIELDS } from './hsl-fields'

/**
 * Every Adjust field away from neutral counts once: the tone fields, the
 * colour fields, and each HSL band's hue, saturation and lightness. The
 * export recap and the details sheet both name this one count.
 */
export function countAdjustments(input: {
  tone: ToneValue
  color: ColorValue
  selectiveColor: HSLToolValue | undefined
}): number {
  let count = 0
  for (const field of TONE_FIELDS) if (input.tone[field.key] !== 0) count += 1
  for (const field of COLOR_FIELDS) if (input.color[field.key] !== 0) count += 1
  if (input.selectiveColor) {
    for (const band of HSL_BAND_ORDER) {
      const shift = input.selectiveColor[band]
      if (!shift) continue
      for (const field of MOBILE_HSL_FIELDS) {
        if (shift[field.key] !== 0) count += 1
      }
    }
  }
  return count
}
