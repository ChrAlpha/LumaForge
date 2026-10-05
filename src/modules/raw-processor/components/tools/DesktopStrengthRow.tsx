import { useId } from 'react'

import { useI18n } from '~/lib/i18n'

import {
  formatStrengthPercent,
  intensityToStrengthPercent,
  STRENGTH_DETENTS,
  STRENGTH_FIELD,
  strengthPercentToIntensity,
  strengthTickMarks,
} from '../strength-field'
import { DesktopAdjustRow } from './DesktopAdjustRow'

/**
 * How much of the applied LUT reaches the photo, on the desktop rail. It is
 * an Adjust row: grab anywhere to scrub (Shift for one tenth), arrows step
 * 1% and Shift+arrows 10%, and the amber value or a double-click returns it
 * to Standard. Light, Standard and Strong are detents the scrub sticks to.
 */
export function DesktopStrengthRow(props: {
  /** 0..1 */
  intensity: number
  onIntensityChange: (value: number) => void
  disabled: boolean
  /** No LUT applied: the row says why it is off. */
  noLut: boolean
}) {
  const { t } = useI18n()
  const reasonId = useId()
  const percent = intensityToStrengthPercent(props.intensity)
  const format = (value: number) => formatStrengthPercent(value, t)
  return (
    <div data-raw-desktop-strength="row">
      <DesktopAdjustRow
        label={t('raw.strength.title')}
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
        describedBy={props.noLut ? reasonId : undefined}
        onChange={(next) =>
          props.onIntensityChange(strengthPercentToIntensity(next))
        }
      />
      {props.noLut && (
        <span id={reasonId} className="sr-only">
          {t('raw.strength.reason')}
        </span>
      )}
    </div>
  )
}
