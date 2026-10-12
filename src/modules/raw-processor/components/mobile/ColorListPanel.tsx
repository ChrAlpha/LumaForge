import { useState } from 'react'

import { useI18n } from '~/lib/i18n'

import type { ColorValue } from '../color-fields'
import { COLOR_FIELDS, formatColorValueShort } from '../color-fields'
import {
  saturationTrack,
  temperatureTrack,
  tintTrack,
  vibranceTrack,
} from '../shared/slider-tracks'
import { AdjustSliderRow } from './AdjustSliderRow'
import { useAdjustRowHandlers } from './useAdjustRowHandlers'

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

const COLOR_FORMAT = Object.fromEntries(
  COLOR_FIELDS.map((field) => [
    field.key,
    (value: number) => formatColorValueShort(field.key, value),
  ]),
) as Record<keyof ColorValue, (value: number) => string>

export function ColorListPanel(props: ColorListPanelProps) {
  const { t } = useI18n()
  const [scrubbingKey, setScrubbingKey] = useState<keyof ColorValue | null>(
    null,
  )
  const handlersFor = useAdjustRowHandlers<keyof ColorValue>({
    onChange: (key, value) => props.onChange({ [key]: value }),
    onScrubChange: (key, scrubbing) => {
      const next = scrubbing ? key : null
      setScrubbingKey(next)
      props.onScrubChange(next ? { key: next } : null)
    },
  })

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
            formatValue={COLOR_FORMAT[field.key]}
            resetAriaLabel={t('raw.adjust.fieldResetAria', {
              label,
            })}
            activeScrub={isActive}
            siblingScrubbing={isSibling}
            onChange={handlersFor(field.key).onChange}
            onScrubChange={handlersFor(field.key).onScrubChange}
          />
        )
      })}
    </div>
  )
}
