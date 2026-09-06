import type { HSLBandId, HSLBandShift } from '@lumaforge/luma-color-runtime'
import { RotateCcw } from 'lucide-react'
import { AnimatePresence, m, useReducedMotion } from 'motion/react'
import { useId, useState } from 'react'

import { clsxm } from '~/lib/cn'
import { useI18n } from '~/lib/i18n'
import { surfaceFade } from '~/lib/spring'

import { DOCK_SPRING } from '../../motion'
import type { ColorValue } from '../color-fields'
import { isColorNeutral } from '../color-fields'
import type { ToneValue } from '../tone-fields'
import { isToneNeutral } from '../tone-fields'
import type { HSLToolValue } from '../tools/HSLTool'
import { ColorListPanel } from './ColorListPanel'
import { isHSLNeutral } from './hsl-fields'
import { HSLListPanel } from './HSLListPanel'
import { ToneListPanel } from './ToneListPanel'

type Section = 'tone' | 'color' | 'hsl'

export type ScrubFieldId =
  | { kind: 'tone'; key: keyof ToneValue }
  | { kind: 'color'; key: keyof ColorValue }
  | { kind: 'hsl'; band: HSLBandId; key: keyof HSLBandShift }

type AdjustListPanelProps = {
  tone: ToneValue
  color: ColorValue
  selectiveColor: HSLToolValue | undefined
  onToneChange: (patch: Partial<ToneValue>) => void
  onColorChange: (patch: Partial<ColorValue>) => void
  onSelectiveColorChange: (
    band: HSLBandId,
    shift: Partial<HSLBandShift>,
  ) => void
  onToneReset: () => void
  onColorReset: () => void
  onSelectiveColorReset: () => void
  onScrubChange: (field: ScrubFieldId | null) => void
  scrubbing?: boolean
}

const SECTIONS: {
  id: Section
  labelKey: 'raw.adjust.tone' | 'raw.adjust.color' | 'raw.adjust.hsl'
}[] = [
  { id: 'tone', labelKey: 'raw.adjust.tone' },
  { id: 'color', labelKey: 'raw.adjust.color' },
  { id: 'hsl', labelKey: 'raw.adjust.hsl' },
]

export function AdjustListPanel(props: AdjustListPanelProps) {
  const { t } = useI18n()
  const [section, setSection] = useState<Section>('tone')
  const prefersReduced = useReducedMotion() ?? false
  // Per-instance id so multiple AdjustListPanels (e.g. a future side-by-side)
  // animate their own indicators rather than fighting over a shared layoutId.
  const indicatorLayoutId = useId()

  const isNeutral =
    section === 'tone'
      ? isToneNeutral(props.tone)
      : section === 'color'
        ? isColorNeutral(props.color)
        : isHSLNeutral(props.selectiveColor)
  const resetLabel =
    section === 'tone'
      ? t('raw.tone.reset')
      : section === 'color'
        ? t('raw.color.reset')
        : t('raw.hsl.reset')
  const onSectionReset =
    section === 'tone'
      ? props.onToneReset
      : section === 'color'
        ? props.onColorReset
        : props.onSelectiveColorReset

  const scrubbing = props.scrubbing === true

  const selectSection = (next: Section) => {
    if (next === section) return
    props.onScrubChange(null)
    setSection(next)
  }

  return (
    <div
      role="region"
      aria-label={t('raw.mobile.adjustList.aria')}
      data-scrubbing={scrubbing || undefined}
      className="flex h-full flex-col gap-2"
    >
      <div
        data-adjust-section-chrome
        className={clsxm(
          // Header in a flex column — never overlaps the slider list, so
          // we don't need an opaque "obscurer" bg. The slider list lives
          // in its own scroll region beneath and cannot reach the chrome.
          'shrink-0',
          // Negative x margin extends the bar edge-to-edge of the dock's
          // padding-box, covering the px-3.5 lateral gutters; matching
          // px-3.5 restores the inner content position.
          '-mx-3.5 px-3.5',
          'grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2',
          'border-b border-lf-on-photo-bord-soft',
          // Delicate frosted glass over the photo above the dock. Because
          // no content can scroll behind it (internal scroll lives below
          // in its own region), the alpha can stay low without leaking —
          // and the bar reads as part of the dock's transparent-to-dark
          // gradient instead of a separate dark slab pasted on top.
          'bg-[oklch(0.118_0.006_255/0.40)] backdrop-blur-xl',
          // 1px inset top highlight — soft "edge of light" matching the
          // segmented-chrome lift language on the desktop.
          'shadow-[inset_0_1px_0_oklch(0.96_0.006_255/0.10)]',
          'transition-opacity duration-150',
          // Dim, do not delete: the section you are in is context a
          // photographer keeps reading while a value moves.
          scrubbing && 'pointer-events-none opacity-45',
        )}
      >
        <div
          role="tablist"
          aria-label={t('raw.adjust.title')}
          className="inline-flex min-h-11 items-stretch gap-5 px-0.5"
        >
          {SECTIONS.map((s) => {
            const isActive = s.id === section
            return (
              <button
                key={s.id}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => selectSection(s.id)}
                className={clsxm(
                  'relative inline-flex min-h-11 items-center px-1 text-[0.86rem] font-medium leading-none tracking-normal transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lf-green/80',
                  isActive
                    ? 'font-semibold text-lf-on-photo-ink'
                    : 'text-lf-on-photo-ink/62 hover:text-lf-on-photo-ink/88',
                )}
              >
                {t(s.labelKey)}
                {isActive && (
                  <m.span
                    aria-hidden="true"
                    layoutId={prefersReduced ? undefined : indicatorLayoutId}
                    transition={DOCK_SPRING}
                    className="absolute inset-x-1 -bottom-px h-0.5 rounded-lf-pill bg-lf-amber"
                  />
                )}
              </button>
            )
          })}
        </div>
        <button
          type="button"
          onClick={onSectionReset}
          disabled={isNeutral}
          aria-label={resetLabel}
          className="-mr-1 inline-flex min-h-11 min-w-11 items-center justify-center rounded-md bg-transparent text-lf-on-photo-ink/82 transition-colors hover:bg-[oklch(0.96_0.006_255/0.08)] hover:text-lf-amber-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lf-green/80 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-lf-on-photo-ink/82"
        >
          <RotateCcw
            aria-hidden="true"
            className="size-[18px] stroke-current"
          />
        </button>
      </div>
      <div
        data-adjust-list-scroll
        // Independent scroll region — slider list scrolls here, never
        // crosses the chrome above. -mx-3.5 lets rows + the dirty-row
        // amber border bleed edge-to-edge of the dock padding-box.
        className="-mx-3.5 min-h-0 flex-1 overflow-y-auto px-3.5"
      >
        <AnimatePresence mode="wait" initial={false}>
          {section === 'tone' ? (
            <m.div
              key="tone"
              data-adjust-list-section="tone"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={surfaceFade}
            >
              <ToneListPanel
                tone={props.tone}
                onChange={props.onToneChange}
                onScrubChange={(field) =>
                  props.onScrubChange(
                    field ? { kind: 'tone', key: field.key } : null,
                  )
                }
              />
            </m.div>
          ) : section === 'color' ? (
            <m.div
              key="color"
              data-adjust-list-section="color"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={surfaceFade}
            >
              <ColorListPanel
                color={props.color}
                onChange={props.onColorChange}
                onScrubChange={(field) =>
                  props.onScrubChange(
                    field ? { kind: 'color', key: field.key } : null,
                  )
                }
              />
            </m.div>
          ) : (
            <m.div
              key="hsl"
              data-adjust-list-section="hsl"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={surfaceFade}
            >
              <HSLListPanel
                value={props.selectiveColor}
                onChange={props.onSelectiveColorChange}
                onScrubChange={(field) =>
                  props.onScrubChange(
                    field
                      ? { kind: 'hsl', band: field.band, key: field.key }
                      : null,
                  )
                }
              />
            </m.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}
