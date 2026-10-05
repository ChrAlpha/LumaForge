import type { DeliveredExportSize } from '../../services/export/delivered-export-size'
import type { ColorValue } from '../color-fields'
import { COLOR_FIELDS } from '../color-fields'
import type { ToneValue } from '../tone-fields'
import { TONE_FIELDS } from '../tone-fields'
import type { HSLToolValue } from '../tools/HSLTool'
import { HSL_BAND_ORDER } from './hsl-fields'

/**
 * The JPEG export can write right now: the full-resolution export when it
 * can run, else the bounded HQ preview when that can, else nothing. The
 * full-resolution recap is never shown for a session that cannot write it.
 */
export type MobileExportOutput = 'full-resolution' | 'hq-preview' | null

export function getAvailableExportOutput(input: {
  canExport: boolean
  canPreviewExport: boolean
}): MobileExportOutput {
  if (input.canExport) return 'full-resolution'
  if (input.canPreviewExport) return 'hq-preview'
  return null
}

/** What the export panel says it will write, read from state only. */
export interface MobileExportRecap {
  output: MobileExportOutput
  /**
   * The full-resolution size; null while it is not known or when the
   * full-resolution export cannot run.
   */
  size: DeliveredExportSize | null
  /**
   * Null when no LUT is applied. `percent` is the strength the export
   * writes, rounded to the whole percent the Strength row sets; 0 is Off.
   */
  look: { name: string; percent: number } | null
  /** Tone, colour, and HSL fields away from neutral. */
  adjustments: number
  transformApplied: boolean
}

/**
 * Every Adjust field away from neutral counts once: the six tone fields,
 * the four colour fields, and each HSL band's hue, saturation and
 * lightness.
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
      if (shift.hue !== 0) count += 1
      if (shift.saturation !== 0) count += 1
      if (shift.lightness !== 0) count += 1
    }
  }
  return count
}

export function buildMobileExportRecap(input: {
  canExport: boolean
  canPreviewExport: boolean
  deliveredSize: DeliveredExportSize | null | undefined
  lutName: string | null | undefined
  /** How much of the look reaches the photo, 0..1. */
  intensity: number
  tone: ToneValue
  color: ColorValue
  selectiveColor: HSLToolValue | undefined
  transformApplied: boolean
}): MobileExportRecap {
  const output = getAvailableExportOutput(input)
  return {
    output,
    size: output === 'full-resolution' ? (input.deliveredSize ?? null) : null,
    look: input.lutName
      ? {
          name: input.lutName,
          percent: Math.round(input.intensity * 100),
        }
      : null,
    adjustments: countAdjustments(input),
    transformApplied: input.transformApplied,
  }
}
