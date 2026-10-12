import { RotateCcw } from 'lucide-react'
import { memo } from 'react'

import { Button } from '~/components/ui/button'
import { useI18n } from '~/lib/i18n'

import type { ToneValue } from '../tone-fields'
import { formatToneValue, isToneNeutral, TONE_FIELDS } from '../tone-fields'
import { DesktopAdjustRow } from './DesktopAdjustRow'

const BASIC_FIELDS = TONE_FIELDS.filter((field) => field.group === 'basic')
const FINE_FIELDS = TONE_FIELDS.filter((field) => field.group === 'fine')

// A row takes its own value, not the whole tone record, so a scrub
// rerenders the one row that moves.
const ToneFieldRow = memo(
  ({
    field,
    label,
    value,
    disabled,
    onChange,
  }: {
    field: (typeof TONE_FIELDS)[number]
    label: string
    value: number
    disabled: boolean
    onChange: (value: Partial<ToneValue>) => void
  }) => {
    return (
      <DesktopAdjustRow
        label={label}
        value={value}
        min={field.min}
        max={field.max}
        step={field.step}
        disabled={disabled}
        formatValue={(next) => formatToneValue(field.key, next)}
        onChange={(next) => onChange({ [field.key]: next })}
        rowProps={{ 'data-tone-field': field.key }}
      />
    )
  },
)

export const ToneTool = memo(
  ({
    value,
    disabled,
    onChange,
    onReset,
  }: {
    value: ToneValue
    disabled: boolean
    onChange: (value: Partial<ToneValue>) => void
    onReset: () => void
  }) => {
    const { t } = useI18n()
    const isNeutral = isToneNeutral(value)

    return (
      <div className="grid gap-3">
        <div className="grid gap-2.5">
          {BASIC_FIELDS.map((field) => (
            <ToneFieldRow
              key={field.key}
              field={field}
              label={t(field.labelKey)}
              value={value[field.key]}
              disabled={disabled}
              onChange={onChange}
            />
          ))}
        </div>
        <div className="grid gap-2.5">
          {FINE_FIELDS.map((field) => (
            <ToneFieldRow
              key={field.key}
              field={field}
              label={t(field.labelKey)}
              value={value[field.key]}
              disabled={disabled}
              onChange={onChange}
            />
          ))}
        </div>
        <p className="text-[0.78rem] leading-relaxed text-lf-on-surface/72">
          {t('raw.tone.note')}
        </p>
        {!isNeutral && (
          <p className="text-[0.78rem] leading-relaxed text-lf-on-surface/72">
            {t('raw.tone.preserved')}
          </p>
        )}
        <Button
          variant="light"
          size="sm"
          disabled={disabled || isNeutral}
          onClick={onReset}
          className="self-start [&_svg]:size-3.5"
        >
          <RotateCcw aria-hidden="true" />
          {t('raw.tone.reset')}
        </Button>
      </div>
    )
  },
)
