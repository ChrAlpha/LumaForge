import { Grid3x3, RotateCcw, Ruler, TriangleAlert } from 'lucide-react'
import { AnimatePresence, m, useReducedMotion } from 'motion/react'
import type { ReactNode } from 'react'
import { useEffect, useId, useState } from 'react'

import { Checkbox } from '~/components/ui/checkbox'
import { clsxm } from '~/lib/cn'
import { useI18n } from '~/lib/i18n'
import { surfaceFade } from '~/lib/spring'
import type { UprightMode } from '~/modules/transform-demo/geometry/types'
import type { ManualTransform } from '~/modules/transform-demo/transform-types'

import type { RawTransformFeature } from '../../hooks/useRawTransformFeature'
import { DOCK_SPRING } from '../../motion'
import {
  SEGMENTED_FOCUS_RING,
  SEGMENTED_ITEM_TEXT,
  SEGMENTED_THUMB_BG,
  SEGMENTED_TRACK,
} from '../tools/segmented-chrome'
import type { TransformField, TransformGroup } from '../transform-fields'
import {
  applyTransformSlider,
  formatTransformValue,
  isTransformDirty,
  isTransformGroupNeutral,
  resetTransformGroup,
  resolveTransformMessage,
  TRANSFORM_GROUP_LABEL,
  transformFieldsIn,
  transformSliderValue,
  UPRIGHT_MODES,
  uprightModeLabelKey,
} from '../transform-fields'
import type { ScrubFieldId } from './AdjustListPanel'
import { AdjustSliderRow } from './AdjustSliderRow'

type Section = 'upright' | TransformGroup

const SECTIONS: Section[] = ['upright', 'perspective', 'frame']

function sectionLabelKey(section: Section) {
  return section === 'upright'
    ? ('raw.transform.group.upright' as const)
    : TRANSFORM_GROUP_LABEL[section]
}

/**
 * Transform inside the mobile dock.
 *
 * Same anatomy as the Adjust list: a fixed section bar over an independently
 * scrolling body, so the photograph above the dock stays the thing you read.
 * Upright is one tap away at all times; the manual geometry is disclosed by
 * section instead of stacking seven sliders into a 264px box.
 */
export function TransformListPanel({
  feature,
  scrubbing = false,
  onScrubChange,
}: {
  feature: RawTransformFeature
  scrubbing?: boolean
  onScrubChange: (field: ScrubFieldId | null) => void
}) {
  const { t } = useI18n()
  const { demo, observe } = feature
  useEffect(() => observe(), [observe])

  const [section, setSection] = useState<Section>('upright')
  const prefersReduced = useReducedMotion() ?? false
  const indicatorLayoutId = useId()

  const message = resolveTransformMessage(feature)
  const controlsDisabled =
    !feature.available ||
    !demo.ready ||
    feature.captureError ||
    feature.isProcessing
  const viewDisabled = !feature.current || feature.isProcessing

  const sectionLabel = t(sectionLabelKey(section))
  const resetDisabled =
    feature.isProcessing ||
    (section === 'upright'
      ? !isTransformDirty(demo.mode, demo.manual) && demo.constrainCrop
      : isTransformGroupNeutral(section, demo.manual) &&
        (section !== 'frame' || demo.constrainCrop))
  const onSectionReset = () => {
    if (section === 'upright') {
      feature.reset()
      return
    }
    if (section === 'frame' && !demo.constrainCrop) {
      feature.setConstrainCrop(true)
    }
    feature.setManual(resetTransformGroup(section, demo.manual))
  }

  return (
    <div
      role="region"
      aria-label={t('raw.mobile.transformList.aria')}
      data-mobile-transform-panel
      // Both viewports answer to one Transform-surface hook so shared
      // validation does not need a per-viewport selector.
      data-raw-transform-tool
      data-scrubbing={scrubbing || undefined}
      className="flex h-full flex-col gap-2"
    >
      <div
        data-transform-section-chrome
        className={clsxm(
          'shrink-0',
          '-mx-3.5 px-3.5',
          'grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2',
          // Flush under the deck's top hairline, like Adjust: one seam.
          'border-b border-lf-on-photo-bord-soft',
          'transition-opacity duration-150',
          scrubbing && 'pointer-events-none opacity-45',
        )}
      >
        <div
          role="tablist"
          aria-label={t('raw.transform.title')}
          className="inline-flex min-h-11 items-stretch gap-5 px-0.5"
        >
          {SECTIONS.map((entry) => {
            const isActive = entry === section
            return (
              <button
                key={entry}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => {
                  if (entry === section) return
                  // A section swap unmounts the row under the thumb; leaving
                  // the scrub reported would strand the HUD on a dead field.
                  onScrubChange(null)
                  setSection(entry)
                }}
                className={clsxm(
                  'relative inline-flex min-h-11 items-center px-1 text-[0.86rem] font-medium leading-none transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lf-green/80',
                  isActive
                    ? 'font-semibold text-lf-on-photo-ink'
                    : 'text-lf-on-photo-ink/62 hover:text-lf-on-photo-ink/88',
                )}
              >
                {t(sectionLabelKey(entry))}
                {isActive && (
                  <m.span
                    aria-hidden="true"
                    layoutId={prefersReduced ? undefined : indicatorLayoutId}
                    transition={DOCK_SPRING}
                    className="absolute inset-x-1 -bottom-px h-0.5 rounded-lf-pill bg-[oklch(0.96_0.006_255/0.85)]"
                  />
                )}
              </button>
            )
          })}
        </div>
        <button
          type="button"
          onClick={onSectionReset}
          disabled={resetDisabled}
          aria-label={t('raw.adjust.fieldResetAria', { label: sectionLabel })}
          className="-mr-1 inline-flex min-h-11 min-w-11 items-center justify-center rounded-md bg-transparent text-lf-on-photo-ink/82 transition-colors hover:bg-[oklch(0.96_0.006_255/0.08)] hover:text-lf-on-photo-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lf-green/80 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-lf-on-photo-ink/82"
        >
          <RotateCcw
            aria-hidden="true"
            className="size-[18px] stroke-current"
          />
        </button>
      </div>

      <div
        data-transform-list-scroll
        className="-mx-3.5 min-h-0 flex-1 overflow-y-auto px-3.5"
      >
        {(message.tone === 'alert' || section === 'upright') && (
          <p
            role={message.tone === 'alert' ? 'alert' : 'status'}
            data-raw-transform-message={message.tone}
            className={clsxm(
              'flex items-start gap-1.5 px-3 pb-2 text-[0.74rem] leading-snug [text-shadow:0_1px_2px_oklch(0_0_0/0.45)]',
              message.tone === 'alert'
                ? 'text-lf-amber-soft'
                : 'text-lf-on-photo-ink/62',
            )}
          >
            {message.tone === 'alert' && (
              <TriangleAlert size={14} aria-hidden className="mt-px shrink-0" />
            )}
            {t(message.key)}
          </p>
        )}

        <AnimatePresence mode="wait" initial={false}>
          {section === 'upright' ? (
            <m.div
              key="upright"
              data-transform-list-section="upright"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={surfaceFade}
              className="grid gap-2 px-1 pb-1"
            >
              <div
                role="group"
                aria-label={t('transform.modes')}
                className={clsxm('grid grid-cols-5 gap-0.5', SEGMENTED_TRACK)}
              >
                {UPRIGHT_MODES.map((mode) => (
                  <ModeButton
                    key={mode}
                    mode={mode}
                    active={demo.mode === mode}
                    disabled={controlsDisabled}
                    onSelect={feature.setMode}
                  />
                ))}
              </div>
              <div
                role="group"
                aria-label={t('raw.transform.overlays')}
                className="grid grid-cols-2 gap-2"
              >
                <ToggleButton
                  icon={<Ruler size={15} aria-hidden />}
                  label={t('transform.lines')}
                  pressed={feature.showLines}
                  disabled={viewDisabled}
                  onToggle={() => feature.setShowLines(!feature.showLines)}
                />
                <ToggleButton
                  icon={<Grid3x3 size={15} aria-hidden />}
                  label={t('transform.grid')}
                  pressed={feature.showGrid}
                  disabled={viewDisabled}
                  onToggle={() => feature.setShowGrid(!feature.showGrid)}
                />
              </div>
            </m.div>
          ) : (
            <m.div
              key={section}
              data-transform-list-section={section}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={surfaceFade}
            >
              <TransformFieldList
                fields={transformFieldsIn(section)}
                manual={demo.manual}
                disabled={controlsDisabled}
                onChange={feature.setManual}
                onScrubChange={onScrubChange}
              />
              {section === 'frame' && (
                <label className="mt-1 flex min-h-11 cursor-pointer items-center gap-3 px-3 text-[0.82rem] font-medium text-lf-on-photo-ink [text-shadow:0_1px_2px_oklch(0_0_0/0.45)]">
                  <Checkbox
                    checked={demo.constrainCrop}
                    onCheckedChange={(value) =>
                      feature.setConstrainCrop(value === true)
                    }
                    disabled={controlsDisabled}
                    className="size-[22px] border border-[oklch(0.96_0.006_255/0.24)] bg-[oklch(0.96_0.006_255/0.06)] data-[state=checked]:border-lf-green data-[state=checked]:bg-lf-green data-[state=checked]:text-lf-surface"
                  />
                  {t('transform.crop')}
                </label>
              )}
            </m.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}

function TransformFieldList({
  fields,
  manual,
  disabled,
  onChange,
  onScrubChange,
}: {
  fields: TransformField[]
  manual: ManualTransform
  disabled: boolean
  onChange: (manual: ManualTransform) => void
  onScrubChange: (field: ScrubFieldId | null) => void
}) {
  const { t } = useI18n()
  const [scrubbingKey, setScrubbingKey] = useState<string | null>(null)

  return (
    <div className="grid gap-0.5">
      {fields.map((field) => {
        const label = t(field.labelKey)
        const isActive = scrubbingKey === field.key
        return (
          <AdjustSliderRow
            key={field.key}
            label={label}
            value={transformSliderValue(field, manual)}
            min={field.min}
            max={field.max}
            step={field.step}
            disabled={disabled}
            formatValue={(value) => formatTransformValue(field, value)}
            valueText={formatTransformValue(
              field,
              transformSliderValue(field, manual),
            )}
            resetAriaLabel={t('raw.adjust.fieldResetAria', { label })}
            activeScrub={isActive}
            siblingScrubbing={scrubbingKey !== null && !isActive}
            onChange={(value) =>
              onChange(applyTransformSlider(field, manual, value))
            }
            onScrubChange={(scrubbing) => {
              setScrubbingKey(scrubbing ? field.key : null)
              onScrubChange(
                scrubbing ? { kind: 'transform', key: field.key } : null,
              )
            }}
          />
        )
      })}
    </div>
  )
}

function ModeButton({
  mode,
  active,
  disabled,
  onSelect,
}: {
  mode: UprightMode
  active: boolean
  disabled: boolean
  onSelect: (mode: UprightMode) => void
}) {
  const { t } = useI18n()
  return (
    <button
      type="button"
      data-testid={`mode-${mode}`}
      aria-pressed={active}
      disabled={disabled}
      onClick={() => onSelect(mode)}
      className={clsxm(
        'inline-flex min-h-11 min-w-0 items-center justify-center rounded-[6px] px-1 text-[0.72rem] transition-colors duration-150',
        SEGMENTED_ITEM_TEXT,
        SEGMENTED_FOCUS_RING,
        'disabled:pointer-events-none disabled:opacity-45',
        active && `${SEGMENTED_THUMB_BG} font-semibold text-lf-on-photo-ink`,
      )}
    >
      <span className="truncate">{t(uprightModeLabelKey(mode))}</span>
    </button>
  )
}

function ToggleButton({
  icon,
  label,
  pressed,
  disabled,
  onToggle,
}: {
  icon: ReactNode
  label: string
  pressed: boolean
  disabled: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onToggle}
      className={clsxm(
        'inline-flex min-h-11 min-w-0 items-center justify-center gap-2 rounded-md px-2 text-[0.78rem] font-medium transition-colors duration-150',
        pressed
          ? `${SEGMENTED_THUMB_BG} text-lf-on-photo-ink`
          : 'bg-[oklch(0.96_0.006_255/0.05)] text-lf-on-photo-ink/72',
        SEGMENTED_FOCUS_RING,
        'disabled:pointer-events-none disabled:opacity-40',
      )}
    >
      {icon}
      <span className="truncate">{label}</span>
    </button>
  )
}
