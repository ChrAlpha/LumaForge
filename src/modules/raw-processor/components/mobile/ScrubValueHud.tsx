import { makeNeutralBand } from '@lumaforge/luma-color-runtime'
import { useAtomValue } from 'jotai'
import { AnimatePresence, m } from 'motion/react'

import { clsxm } from '~/lib/cn'
import { useI18n } from '~/lib/i18n'
import { surfaceFade } from '~/lib/spring'

import { scrubGainBandAtom } from '../../state/scrub.atoms'
import type { ColorValue } from '../color-fields'
import { COLOR_FIELDS, formatColorValueShort } from '../color-fields'
import type { ToneValue } from '../tone-fields'
import { formatToneValueShort, TONE_FIELDS } from '../tone-fields'
import type { HSLToolValue } from '../tools/HSLTool'
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
}

const GAIN_LABEL_KEY = {
  half: 'raw.mobile.adjustList.gain.half',
  quarter: 'raw.mobile.adjustList.gain.quarter',
  fine: 'raw.mobile.adjustList.gain.fine',
} as const

export function ScrubValueHud(props: ScrubValueHudProps) {
  const { t } = useI18n()
  const readout = resolveReadout(props, t)
  const gain = useAtomValue(scrubGainBandAtom)
  const gainLabel = gain === 'full' ? null : t(GAIN_LABEL_KEY[gain])

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
          className="pointer-events-none absolute left-1/2 top-safe-offset-3 z-30 grid -translate-x-1/2 gap-0.5 px-4 text-center text-lf-on-photo-ink [text-shadow:0_1px_2px_oklch(0_0_0/0.55)]"
        >
          <span className="text-[0.62rem] font-bold uppercase tracking-[0.18em] text-lf-amber-soft">
            {readout.label}
          </span>
          <strong className="text-[1.85rem] font-semibold leading-none tabular-nums">
            {readout.formatted}
          </strong>
          {/* Precision band while the finger is away from the track. Kept in
              the flow with a fixed line height so the value never shifts. */}
          <span
            data-scrub-gain={gain}
            aria-hidden="true"
            className={clsxm(
              'h-3.5 text-[0.62rem] font-semibold uppercase leading-[0.875rem] tracking-[0.14em] text-lf-on-photo-ink/72 transition-opacity duration-150',
              gainLabel ? 'opacity-100' : 'opacity-0',
            )}
          >
            {gainLabel ?? '\u00A0'}
          </span>
        </m.div>
      )}
    </AnimatePresence>
  )
}

type Readout = {
  kind: 'tone' | 'color' | 'hsl'
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

  if (field.kind === 'tone') {
    const toneField = TONE_FIELDS.find((f) => f.key === field.key)
    if (!toneField) return null
    const value = props.tone[toneField.key]
    return {
      kind: 'tone',
      key: toneField.key,
      label: t(toneField.labelKey),
      formatted: formatToneValueShort(toneField.key, value),
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
