import type { PreviewHistogramState } from '@lumaforge/luma-color-runtime'
import { makeNeutralBand } from '@lumaforge/luma-color-runtime'
import { AnimatePresence, m, useReducedMotion } from 'motion/react'

import { useI18n } from '~/lib/i18n'
import { surfaceFade } from '~/lib/spring'
import type { ManualTransform } from '~/modules/transform-demo/transform-types'

import type { ColorValue } from '../color-fields'
import { COLOR_FIELDS, formatColorValueShort } from '../color-fields'
import {
  formatStrengthPercent,
  intensityToStrengthPercent,
} from '../strength-field'
import type { ToneValue } from '../tone-fields'
import { formatToneValue, TONE_FIELDS } from '../tone-fields'
import { HistogramPlot, readyHistogram } from '../tools/HistogramTool'
import type { HSLToolValue } from '../tools/HSLTool'
import {
  formatTransformValue,
  TRANSFORM_FIELDS,
  transformSliderValue,
} from '../transform-fields'
import type { ScrubFieldId } from './AdjustListPanel'
import {
  formatHSLValueShort,
  HSL_BAND_LABEL_KEY,
  MOBILE_HSL_FIELDS,
} from './hsl-fields'

type ScrubValueHudProps = {
  field: ScrubFieldId | null
  tone: ToneValue
  color: ColorValue
  selectiveColor: HSLToolValue | undefined
  manualTransform: ManualTransform | undefined
  /** How much of the applied LUT reaches the photo, 0..1. */
  lookIntensity?: number
  /**
   * The preview histogram while the user has it turned on; null when it is
   * off. Unsupported or not yet computed, it draws nothing.
   */
  histogram?: PreviewHistogramState | null
}

export function ScrubValueHud(props: ScrubValueHudProps) {
  const { t } = useI18n()
  const reduced = useReducedMotion() ?? false
  const readout = resolveReadout(props, t)
  // A Transform scrub moves geometry, not tone: no histogram beside it.
  const bins =
    readout && readout.kind !== 'transform' && props.histogram
      ? readyHistogram(props.histogram)
      : null

  return (
    <AnimatePresence initial={false}>
      {readout && (
        <m.div
          key={`${readout.kind}-${readout.key}`}
          data-scrub-value-hud
          aria-label={t('raw.mobile.adjustList.scrubHudAria')}
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={surfaceFade}
          // Centred in the topbar band (safe area + 56px) on its solid
          // plate, so the readout needs no shadow to hold over the photo.
          // `w-max` keeps the readout on one line: an absolutely placed box
          // centred from 50% would otherwise shrink to the right half of the
          // band and wrap the unit under the number.
          className="pointer-events-none absolute left-1/2 top-safe-offset-2 z-30 grid w-max max-w-[calc(100vw-1.5rem)] -translate-x-1/2 gap-1 px-4 text-center text-lf-on-photo-ink"
        >
          <span className="text-[0.62rem] font-bold uppercase leading-none tracking-[0.18em] text-lf-amber-soft">
            {readout.label}
          </span>
          <span className="flex items-center justify-center gap-3">
            <strong className="whitespace-nowrap text-[1.85rem] font-semibold leading-none tabular-nums">
              {readout.formatted}
            </strong>
            {/* The tonal answer to the move, beside the number and inside
                the topbar band, so it never covers the photo. */}
            <AnimatePresence initial={false}>
              {bins && (
                <m.span
                  key="histogram"
                  data-scrub-hud-histogram
                  className="block"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={reduced ? { duration: 0 } : surfaceFade}
                >
                  <HistogramPlot
                    bins={bins.bins}
                    ariaLabel={t('raw.histogram.aria')}
                    variant="mini"
                  />
                </m.span>
              )}
            </AnimatePresence>
          </span>
        </m.div>
      )}
    </AnimatePresence>
  )
}

type Readout = {
  kind: 'tone' | 'color' | 'hsl' | 'transform' | 'strength'
  key: string
  label: string
  formatted: string
}

function resolveReadout(
  props: ScrubValueHudProps,
  t: ReturnType<typeof useI18n>['t'],
): Readout | null {
  const { field } = props
  if (!field) return null

  // The row reads in whole percents; so does the HUD ("62%", 0 is Off).
  if (field.kind === 'strength') {
    if (props.lookIntensity === undefined) return null
    return {
      kind: 'strength',
      key: 'strength',
      label: t('raw.strength.title'),
      formatted: formatStrengthPercent(
        intensityToStrengthPercent(props.lookIntensity),
        t,
      ),
    }
  }

  if (field.kind === 'tone') {
    const toneField = TONE_FIELDS.find((f) => f.key === field.key)
    if (!toneField) return null
    const value = props.tone[toneField.key]
    return {
      kind: 'tone',
      key: toneField.key,
      label: t(toneField.labelKey),
      formatted: formatToneValue(toneField.key, value),
    }
  }

  // Transform trades in offsets from neutral, so the HUD reports the same
  // string the row does rather than the raw model value (Scale reads "100%").
  if (field.kind === 'transform') {
    const transformField = TRANSFORM_FIELDS.find((f) => f.key === field.key)
    if (!transformField || !props.manualTransform) return null
    return {
      kind: 'transform',
      key: transformField.key,
      label: t(transformField.labelKey),
      formatted: formatTransformValue(
        transformField,
        transformSliderValue(transformField, props.manualTransform),
      ),
    }
  }

  if (field.kind === 'color') {
    const colorField = COLOR_FIELDS.find((f) => f.key === field.key)
    if (!colorField) return null
    const value = props.color[colorField.key]
    return {
      kind: 'color',
      key: colorField.key,
      label: t(colorField.labelKey),
      formatted: formatColorValueShort(colorField.key, value),
    }
  }

  // HSL — label couples the band name with the field name so the HUD reads
  // "Red · Hue" instead of just "Hue" while a band is being scrubbed.
  const hslField = MOBILE_HSL_FIELDS.find((f) => f.key === field.key)
  if (!hslField) return null
  const band = props.selectiveColor?.[field.band] ?? makeNeutralBand()
  const value = band[hslField.key]
  return {
    kind: 'hsl',
    key: `${field.band}.${hslField.key}`,
    label: `${t(HSL_BAND_LABEL_KEY[field.band])} · ${t(hslField.labelKey)}`,
    formatted: formatHSLValueShort(hslField.key, value),
  }
}
