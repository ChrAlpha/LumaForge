import { RotateCcw } from 'lucide-react'
import { memo } from 'react'

import { Button } from '~/components/ui/button'
import { useI18n } from '~/lib/i18n'

import type { ColorValue } from '../color-fields'
import {
  COLOR_FIELDS,
  formatColorValueShort,
  isColorNeutral,
} from '../color-fields'
import {
  saturationTrack,
  temperatureTrack,
  tintTrack,
  vibranceTrack,
} from '../shared/slider-tracks'
import { DesktopAdjustRow } from './DesktopAdjustRow'

const COLOR_TRACK: Record<keyof ColorValue, string> = {
  userTemperature: temperatureTrack(),
  userTint: tintTrack(),
  userSaturation: saturationTrack(),
  userVibrance: vibranceTrack(),
}

// A row takes its own value, not the whole color record, so a scrub
// rerenders the one row that moves.
const ColorFieldRow = memo(
  ({
    field,
    label,
    value,
    disabled,
    onChange,
  }: {
    field: (typeof COLOR_FIELDS)[number]
    label: string
    value: number
    disabled: boolean
    onChange: (value: Partial<ColorValue>) => void
  }) => {
    return (
      <DesktopAdjustRow
        label={label}
        value={value}
        min={field.min}
        max={field.max}
        step={field.step}
        disabled={disabled}
        track={COLOR_TRACK[field.key]}
        formatValue={(next) => formatColorValueShort(field.key, next)}
        onChange={(next) => onChange({ [field.key]: next })}
        rowProps={{ 'data-color-field': field.key }}
      />
    )
  },
)

export const ColorTool = memo(
  ({
    value,
    disabled,
    onChange,
    onReset,
  }: {
    value: ColorValue
    disabled: boolean
    onChange: (value: Partial<ColorValue>) => void
    onReset: () => void
  }) => {
    const { t } = useI18n()
    const isNeutral = isColorNeutral(value)

    return (
      <div className="grid gap-3">
        <div className="grid gap-2.5">
          {COLOR_FIELDS.map((field) => (
            <ColorFieldRow
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
          {t('raw.color.note')}
        </p>
        {!isNeutral && (
          <p className="text-[0.78rem] leading-relaxed text-lf-on-surface/72">
            {t('raw.color.preserved')}
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
          {t('raw.color.reset')}
        </Button>
      </div>
    )
  },
)
