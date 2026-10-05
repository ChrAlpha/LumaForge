import { useI18n } from '~/lib/i18n'

import {
  formatStrengthPercent,
  intensityToStrengthPercent,
  STRENGTH_DETENTS,
  STRENGTH_FIELD,
  strengthPercentToIntensity,
  strengthTickMarks,
} from '../strength-field'
import { AdjustSliderRow } from './AdjustSliderRow'

/**
 * The Look deck's Strength row: how much of the applied LUT reaches the
 * photo, scrubbed like an Adjust row. It answers a press the same way
 * (grab anywhere, precision from vertical distance, the HUD in the topbar
 * band), sticks at Light, Standard and Strong, and the amber value returns
 * it to Standard. Compact, so the deck is about as tall as it was with the
 * four-way segmented control this replaced.
 */
export function MobileLookStrength(props: {
  /** 0..1 */
  value: number
  onChange?: (value: number) => void
  disabled: boolean
  /** Id of the text that says why the control is disabled. */
  describedBy?: string
  /** A press on the disabled control asks for its reason. */
  onBlockedPress?: () => void
  /** This row is the scrub in progress. */
  activeScrub?: boolean
  onScrubChange?: (scrubbing: boolean) => void
}) {
  const { t } = useI18n()
  const label = t('raw.strength.title')
  const percent = intensityToStrengthPercent(props.value)
  const format = (value: number) => formatStrengthPercent(value, t)
  return (
    <div data-mobile-look-strength className="relative">
      <AdjustSliderRow
        density="compact"
        label={label}
        value={percent}
        min={STRENGTH_FIELD.min}
        max={STRENGTH_FIELD.max}
        step={STRENGTH_FIELD.step}
        neutral={STRENGTH_FIELD.neutral}
        detents={STRENGTH_DETENTS}
        ticks={strengthTickMarks(t)}
        disabled={props.disabled}
        formatValue={format}
        valueText={format(percent)}
        resetAriaLabel={t('raw.adjust.fieldResetAria', { label })}
        describedBy={props.disabled ? props.describedBy : undefined}
        activeScrub={props.activeScrub}
        onChange={(next) => props.onChange?.(strengthPercentToIntensity(next))}
        onScrubChange={(scrubbing) => props.onScrubChange?.(scrubbing)}
      />
      {/* A disabled row takes no press; this catches one so the deck can
          say why the control is off. */}
      {props.disabled && props.onBlockedPress && (
        <span
          aria-hidden="true"
          data-strength-blocked-catcher
          className="absolute inset-0"
          onPointerDown={props.onBlockedPress}
        />
      )}
    </div>
  )
}
