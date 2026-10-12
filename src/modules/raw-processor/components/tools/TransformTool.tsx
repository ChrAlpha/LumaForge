import { Grid3x3, RotateCcw, Ruler, TriangleAlert } from 'lucide-react'
import type { ReactNode } from 'react'
import { memo, useCallback, useEffect, useRef } from 'react'

import { Checkbox } from '~/components/ui/checkbox'
import { clsxm } from '~/lib/cn'
import { useI18n } from '~/lib/i18n'
import type { UprightMode } from '~/lib/transform/geometry/types'
import type { ManualTransform } from '~/lib/transform/transform-types'

import type { RawTransformFeature } from '../../hooks/useRawTransformFeature'
import type { ToolAvailability } from '../../services/surface/derive-tool-availability'
import {
  SEGMENTED_FOCUS_RING,
  SEGMENTED_ITEM_TEXT,
  SEGMENTED_THUMB_BG,
  SEGMENTED_TRACK,
} from '../shared/segmented-chrome'
import type { TransformField, TransformGroup } from '../transform-fields'
import {
  applyTransformSlider,
  formatTransformValue,
  isTransformDirty,
  resolveTransformMessage,
  TRANSFORM_GROUP_LABEL,
  transformFieldsIn,
  transformSliderValue,
  UPRIGHT_MODES,
  uprightModeLabelKey,
} from '../transform-fields'
import { DesktopAdjustRow } from './DesktopAdjustRow'

/**
 * Transform on the desktop rail.
 *
 * Three bands, densest first: the upright mode is the decision, one line
 * reports the state of that decision, and the manual geometry sits below in
 * the same Adjust rows the Tone and Color cards use (grab anywhere, Shift for
 * fine, click the amber value to reset the field).
 *
 * Each control is off exactly where the shared action policy refuses its
 * Transform action; Reset is also off for an intent with nothing to reset.
 */
export function TransformTool({
  feature,
  availability,
}: {
  feature: RawTransformFeature
  availability: Pick<
    ToolAvailability,
    'transformGeometry' | 'transformOverlay' | 'transformReset'
  >
}) {
  const { t } = useI18n()
  const { preview, observe } = feature
  useEffect(() => observe(), [observe])
  // The feature is a new object on every workflow render; the rows and mode
  // buttons hold these instead, which read it when they are called.
  const featureRef = useRef(feature)
  featureRef.current = feature
  const selectMode = useCallback(
    (mode: UprightMode) => featureRef.current.setMode(mode),
    [],
  )
  const changeField = useCallback((field: TransformField, next: number) => {
    const current = featureRef.current
    current.setManual(applyTransformSlider(field, current.preview.manual, next))
  }, [])

  const message = resolveTransformMessage(feature)
  const controlsDisabled = !availability.transformGeometry.available
  const viewDisabled = !availability.transformOverlay.available
  const dirty =
    isTransformDirty(preview.mode, preview.manual) || !preview.constrainCrop

  return (
    <div data-raw-transform-tool className="grid min-w-0 gap-3">
      <div
        role="group"
        aria-label={t('transform.modes')}
        className={clsxm('grid grid-cols-5 gap-0.5', SEGMENTED_TRACK)}
      >
        {UPRIGHT_MODES.map((mode) => (
          <ModeButton
            key={mode}
            mode={mode}
            active={preview.mode === mode}
            disabled={controlsDisabled}
            onSelect={selectMode}
          />
        ))}
      </div>

      <p
        role={message.tone === 'alert' ? 'alert' : 'status'}
        data-raw-transform-message={message.tone}
        className={clsxm(
          // Two lines are reserved so switching mode does not shuffle the
          // slider stack under the pointer.
          'flex min-h-8 items-start gap-1.5 px-1.5 text-[0.72rem] leading-snug',
          message.tone === 'alert'
            ? 'text-lf-amber-soft'
            : 'text-lf-on-surface/56',
        )}
      >
        {message.tone === 'alert' && (
          <TriangleAlert size={13} aria-hidden className="mt-px shrink-0" />
        )}
        {t(message.key)}
      </p>

      <div className="flex items-center justify-between gap-1">
        <div
          role="group"
          aria-label={t('raw.transform.overlays')}
          className="flex min-w-0 items-center gap-0.5"
        >
          <ToggleButton
            icon={<Ruler size={13} aria-hidden />}
            label={t('transform.lines')}
            pressed={feature.showLines}
            disabled={viewDisabled}
            onToggle={() => feature.setShowLines(!feature.showLines)}
          />
          <ToggleButton
            icon={<Grid3x3 size={13} aria-hidden />}
            label={t('transform.grid')}
            pressed={feature.showGrid}
            disabled={viewDisabled}
            onToggle={() => feature.setShowGrid(!feature.showGrid)}
          />
        </div>
        <button
          type="button"
          onClick={feature.reset}
          disabled={!availability.transformReset.available || !dirty}
          className={clsxm(
            'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-[0.72rem] font-medium transition-colors duration-150',
            'text-lf-on-surface/72 hover:bg-[oklch(0.96_0.006_255/0.06)] hover:text-lf-amber-soft',
            SEGMENTED_FOCUS_RING,
            'disabled:pointer-events-none disabled:opacity-40',
          )}
        >
          <RotateCcw size={13} aria-hidden />
          {t('transform.reset')}
        </button>
      </div>

      <FieldGroup
        group="perspective"
        manual={preview.manual}
        disabled={controlsDisabled}
        onFieldChange={changeField}
      />
      <FieldGroup
        group="frame"
        manual={preview.manual}
        disabled={controlsDisabled}
        onFieldChange={changeField}
      >
        <label className="flex min-h-9 cursor-pointer items-center gap-2.5 px-1.5 text-[0.8rem] text-lf-on-surface/80">
          <Checkbox
            checked={preview.constrainCrop}
            onCheckedChange={(value) =>
              feature.setConstrainCrop(value === true)
            }
            disabled={controlsDisabled}
            className="size-4 border border-[oklch(0.96_0.006_255/0.24)] bg-[oklch(0.96_0.006_255/0.06)] data-[state=checked]:border-lf-green data-[state=checked]:bg-lf-green data-[state=checked]:text-lf-surface"
          />
          {t('transform.crop')}
        </label>
      </FieldGroup>
    </div>
  )
}

const ModeButton = memo(
  ({
    mode,
    active,
    disabled,
    onSelect,
  }: {
    mode: UprightMode
    active: boolean
    disabled: boolean
    onSelect: (mode: UprightMode) => void
  }) => {
    const { t } = useI18n()
    return (
      <button
        type="button"
        data-testid={`mode-${mode}`}
        aria-pressed={active}
        disabled={disabled}
        onClick={() => onSelect(mode)}
        className={clsxm(
          // Five segments share a 292px rail at its narrowest, so the label
          // scale is set by the longest mode ("Vertical") rather than by the
          // rail's usual 0.74rem control text.
          'inline-flex h-9 min-w-0 items-center justify-center rounded-[6px] px-0.5 text-[0.68rem] transition-colors duration-150',
          SEGMENTED_ITEM_TEXT,
          SEGMENTED_FOCUS_RING,
          'disabled:pointer-events-none disabled:opacity-45',
          active && `${SEGMENTED_THUMB_BG} font-semibold text-lf-on-surface`,
        )}
      >
        <span className="truncate">{t(uprightModeLabelKey(mode))}</span>
      </button>
    )
  },
)

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
        'inline-flex h-8 min-w-0 items-center gap-1.5 rounded-md px-2 text-[0.72rem] font-medium transition-colors duration-150',
        pressed
          ? `${SEGMENTED_THUMB_BG} text-lf-on-surface`
          : 'text-lf-on-surface/72 hover:bg-[oklch(0.96_0.006_255/0.06)] hover:text-lf-on-surface',
        SEGMENTED_FOCUS_RING,
        'disabled:pointer-events-none disabled:opacity-40',
      )}
    >
      {icon}
      <span className="truncate">{label}</span>
    </button>
  )
}

function FieldGroup({
  group,
  manual,
  disabled,
  onFieldChange,
  children,
}: {
  group: TransformGroup
  manual: ManualTransform
  disabled: boolean
  onFieldChange: (field: TransformField, next: number) => void
  children?: ReactNode
}) {
  const { t } = useI18n()
  const label = t(TRANSFORM_GROUP_LABEL[group])

  return (
    <section
      aria-label={label}
      data-raw-transform-group={group}
      className="grid gap-1.5 border-t border-[oklch(0.96_0.006_255/0.08)] pt-2.5"
    >
      <h3 className="px-1.5 text-[0.68rem] font-semibold uppercase tracking-[0.04em] text-lf-on-surface/50">
        {label}
      </h3>
      {transformFieldsIn(group).map((field) => (
        <TransformFieldRow
          key={field.key}
          field={field}
          label={t(field.labelKey)}
          value={transformSliderValue(field, manual)}
          disabled={disabled}
          onFieldChange={onFieldChange}
        />
      ))}
      {children}
    </section>
  )
}

// A row takes its own slider value, so a scrub rerenders the one row that
// moves rather than every geometry control.
const TransformFieldRow = memo(
  ({
    field,
    label,
    value,
    disabled,
    onFieldChange,
  }: {
    field: TransformField
    label: string
    value: number
    disabled: boolean
    onFieldChange: (field: TransformField, next: number) => void
  }) => {
    return (
      <DesktopAdjustRow
        label={label}
        value={value}
        min={field.min}
        max={field.max}
        step={field.step}
        disabled={disabled}
        formatValue={(next) => formatTransformValue(field, next)}
        valueText={formatTransformValue(field, value)}
        onChange={(next) => onFieldChange(field, next)}
      />
    )
  },
)
