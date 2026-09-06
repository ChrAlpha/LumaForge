import { useState } from 'react'

import { useI18n } from '~/lib/i18n'

import type { ToneValue } from '../tone-fields'
import { formatToneValueShort, TONE_FIELDS } from '../tone-fields'
import { AdjustSliderRow } from './AdjustSliderRow'

type ToneListPanelProps = {
  tone: ToneValue
  onChange: (patch: Partial<ToneValue>) => void
  onScrubChange: (field: { key: keyof ToneValue } | null) => void
}

export function ToneListPanel(props: ToneListPanelProps) {
  const { t } = useI18n()
  const [scrubbingKey, setScrubbingKey] = useState<keyof ToneValue | null>(null)
  const { onScrubChange: notifyParent } = props

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
            formatValue={(v) => formatToneValueShort(field.key, v)}
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
