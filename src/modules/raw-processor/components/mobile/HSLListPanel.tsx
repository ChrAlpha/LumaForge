import type { HSLBandId, HSLBandShift } from '@lumaforge/luma-color-runtime'
import { makeNeutralBand } from '@lumaforge/luma-color-runtime'
import { ChevronDown } from 'lucide-react'
import { AnimatePresence, m, useReducedMotion } from 'motion/react'
import { useState } from 'react'

import { clsxm } from '~/lib/cn'
import { useI18n } from '~/lib/i18n'
import { surfaceFade } from '~/lib/spring'

import type { HSLToolValue } from '../tools/HSLTool'
import {
  hslHueTrack,
  hslLightnessTrack,
  hslSaturationTrack,
} from '../tools/slider-tracks'
import { AdjustSliderRow } from './AdjustSliderRow'
import {
  formatHSLValueShort,
  HSL_BAND_LABEL_KEY,
  HSL_BAND_ORDER,
  HSL_BAND_SWATCH,
  isHSLBandNeutral,
  MOBILE_HSL_FIELDS,
} from './hsl-fields'

type HSLScrubField = { band: HSLBandId; key: keyof HSLBandShift }

type HSLListPanelProps = {
  value: HSLToolValue | undefined
  onChange: (band: HSLBandId, shift: Partial<HSLBandShift>) => void
  onScrubChange: (field: HSLScrubField | null) => void
}

function trackForField(band: HSLBandId, key: keyof HSLBandShift): string {
  switch (key) {
    case 'hue':
      return hslHueTrack(band)
    case 'saturation':
      return hslSaturationTrack(band)
    case 'lightness':
      return hslLightnessTrack(band)
  }
}

export function HSLListPanel(props: HSLListPanelProps) {
  const { t } = useI18n()
  const [openBand, setOpenBand] = useState<HSLBandId | null>(null)
  const [scrub, setScrub] = useState<HSLScrubField | null>(null)
  const prefersReduced = useReducedMotion() ?? false
  const { onScrubChange: notifyParent } = props

  const selectBand = (band: HSLBandId) => {
    if (band === openBand) {
      setOpenBand(null)
      if (scrub) {
        setScrub(null)
        notifyParent(null)
      }
      return
    }
    if (scrub) {
      setScrub(null)
      notifyParent(null)
    }
    setOpenBand(band)
  }

  return (
    <div
      role="group"
      aria-label={t('raw.mobile.adjustList.hslListAria')}
      className="grid gap-0.5"
    >
      {HSL_BAND_ORDER.map((band) => {
        const bandValue = props.value?.[band] ?? makeNeutralBand()
        const isOpen = band === openBand
        const isDirty = !isHSLBandNeutral(bandValue)
        const label = t(HSL_BAND_LABEL_KEY[band])
        return (
          <div
            key={band}
            data-hsl-band-row={band}
            data-open={isOpen || undefined}
            data-dirty={isDirty || undefined}
            className="grid gap-0.5"
          >
            <button
              type="button"
              aria-expanded={isOpen}
              aria-controls={`hsl-band-fields-${band}`}
              onClick={() => selectBand(band)}
              className={clsxm(
                'inline-grid min-h-11 grid-cols-[18px_minmax(0,1fr)_18px] items-center gap-3 rounded-md border border-transparent px-3 text-left transition-[background-color,border-color] duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lf-green/80',
                isOpen && 'border-lf-amber/55 bg-lf-on-photo-bg-strong',
              )}
            >
              <span
                aria-hidden="true"
                data-hsl-band-swatch={band}
                className="size-2.5 shrink-0 justify-self-center rounded-full ring-1 ring-[oklch(from_var(--color-lf-on-photo-ink)_l_c_h_/_0.32)]"
                style={{ backgroundColor: HSL_BAND_SWATCH[band] }}
              />
              <span
                className={clsxm(
                  'truncate text-[0.86rem] font-semibold leading-tight [text-shadow:0_1px_2px_oklch(0_0_0/0.45)]',
                  isDirty ? 'text-lf-amber-soft' : 'text-lf-on-photo-ink',
                )}
              >
                {label}
              </span>
              <m.span
                aria-hidden="true"
                animate={{ rotate: isOpen ? 180 : 0 }}
                transition={
                  prefersReduced ? { duration: 0 } : { duration: 0.15 }
                }
                className="inline-flex items-center justify-center text-lf-on-photo-ink/68"
              >
                <ChevronDown className="size-[14px]" />
              </m.span>
            </button>
            <AnimatePresence initial={false}>
              {isOpen && (
                <m.div
                  key={`hsl-band-fields-${band}`}
                  id={`hsl-band-fields-${band}`}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={surfaceFade}
                  className="grid gap-0.5 pb-1"
                >
                  {MOBILE_HSL_FIELDS.map((field) => {
                    const fieldLabel = t(field.labelKey)
                    const isActive =
                      scrub !== null &&
                      scrub.band === band &&
                      scrub.key === field.key
                    const isSibling = scrub !== null && !isActive
                    const value = bandValue[field.key]
                    return (
                      <AdjustSliderRow
                        key={field.key}
                        label={fieldLabel}
                        value={value}
                        min={field.min}
                        max={field.max}
                        step={field.step}
                        track={trackForField(band, field.key)}
                        formatValue={(v) => formatHSLValueShort(field.key, v)}
                        resetAriaLabel={t('raw.adjust.fieldResetAria', {
                          label: fieldLabel,
                        })}
                        activeScrub={isActive}
                        siblingScrubbing={isSibling}
                        onChange={(next) =>
                          props.onChange(band, { [field.key]: next })
                        }
                        onScrubChange={(scrubbing) => {
                          if (scrubbing) {
                            const next: HSLScrubField = {
                              band,
                              key: field.key,
                            }
                            setScrub(next)
                            notifyParent(next)
                          } else {
                            setScrub(null)
                            notifyParent(null)
                          }
                        }}
                      />
                    )
                  })}
                </m.div>
              )}
            </AnimatePresence>
          </div>
        )
      })}
    </div>
  )
}
