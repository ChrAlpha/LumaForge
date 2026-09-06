import { useState } from 'react'

import { useI18n } from '~/lib/i18n'

import type { ColorValue } from '../color-fields'
import { COLOR_FIELDS, formatColorValueShort } from '../color-fields'
import {
  saturationTrack,
  temperatureTrack,
  tintTrack,
  vibranceTrack,
} from '../tools/slider-tracks'
import { AdjustSliderRow } from './AdjustSliderRow'

type ColorListPanelProps = {
  color: ColorValue
  onChange: (patch: Partial<ColorValue>) => void
  onScrubChange: (field: { key: keyof ColorValue } | null) => void
}

const COLOR_FIELD_TRACK: Record<keyof ColorValue, string> = {
  userTemperature: temperatureTrack(),
  userTint: tintTrack(),
  userSaturation: saturationTrack(),
  userVibrance: vibranceTrack(),
}

export function ColorListPanel(props: ColorListPanelProps) {
  const { t } = useI18n()
  const [scrubbingKey, setScrubbingKey] = useState<keyof ColorValue | null>(
    null,
  )
  const { onScrubChange: notifyParent } = props

  return (
    <div
      role="group"
      aria-label={t('raw.mobile.adjustList.colorListAria')}
      className="grid gap-0.5"
    >
      {COLOR_FIELDS.map((field) => {
        const label = t(field.labelKey)
        const isActive = scrubbingKey === field.key
        const isSibling = scrubbingKey !== null && !isActive

        return (
          <AdjustSliderRow
            key={field.key}
            label={label}
            value={props.color[field.key]}
            min={field.min}
            max={field.max}
            step={field.step}
            track={COLOR_FIELD_TRACK[field.key]}
            formatValue={(v) => formatColorValueShort(field.key, v)}
            resetAriaLabel={t('raw.adjust.fieldResetAria', {
              label,
            })}
            activeScrub={isActive}
            siblingScrubbing={isSibling}
            onChange={(value) => props.onChange({ [field.key]: value })}
            onScrubChange={(scrubbing) => {
              const next = scrubbing ? field.key : null
              setScrubbingKey(next)
              notifyParent(next ? { key: next } : null)
            }}
          />
        )
      })}
    </div>
  )
}
