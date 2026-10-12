import { useState } from 'react'

import { useI18n } from '~/lib/i18n'

import type { ToneValue } from '../tone-fields'
import { formatToneValue, TONE_FIELDS } from '../tone-fields'
import { AdjustSliderRow } from './AdjustSliderRow'
import { useAdjustRowHandlers } from './useAdjustRowHandlers'

type ToneListPanelProps = {
  tone: ToneValue
  onChange: (patch: Partial<ToneValue>) => void
  onScrubChange: (field: { key: keyof ToneValue } | null) => void
}

const TONE_FORMAT = Object.fromEntries(
  TONE_FIELDS.map((field) => [
    field.key,
    (value: number) => formatToneValue(field.key, value),
  ]),
) as Record<keyof ToneValue, (value: number) => string>

export function ToneListPanel(props: ToneListPanelProps) {
  const { t } = useI18n()
  const [scrubbingKey, setScrubbingKey] = useState<keyof ToneValue | null>(null)
  const handlersFor = useAdjustRowHandlers<keyof ToneValue>({
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
      aria-label={t('raw.mobile.adjustList.toneListAria')}
      className="grid gap-0.5"
    >
      {TONE_FIELDS.map((field) => {
        const label = t(field.labelKey)
        const isActive = scrubbingKey === field.key
        const isSibling = scrubbingKey !== null && !isActive

        return (
          <AdjustSliderRow
            key={field.key}
            label={label}
            value={props.tone[field.key]}
            min={field.min}
            max={field.max}
            step={field.step}
            formatValue={TONE_FORMAT[field.key]}
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
