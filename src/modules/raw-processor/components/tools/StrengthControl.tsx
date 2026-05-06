import * as ToggleGroup from '@radix-ui/react-toggle-group'

import { useI18n } from '~/lib/i18n'

const LEVELS = ['off', 'light', 'standard', 'strong'] as const

export type StrengthLevel = (typeof LEVELS)[number]

export function StrengthControl({
  value,
  onChange,
  disabled,
}: {
  value: StrengthLevel
  onChange: (value: StrengthLevel) => void
  disabled: boolean
}) {
  const { t } = useI18n()
  const labels: Record<StrengthLevel, string> = {
    off: t('raw.strength.off'),
    light: t('raw.strength.light'),
    standard: t('raw.strength.standard'),
    strong: t('raw.strength.strong'),
  }

  return (
    <ToggleGroup.Root
      type="single"
      value={value}
      onValueChange={(v) => {
        if (v) onChange(v as StrengthLevel)
      }}
      disabled={disabled}
      aria-label={t('raw.strength.title')}
      className="grid grid-cols-4 overflow-hidden rounded-lg border border-[color:--color-raw-hairline]"
    >
      {LEVELS.map((level) => (
        <ToggleGroup.Item
          key={level}
          value={level}
          disabled={disabled}
          className={[
            'min-h-[34px] min-w-0 border-0 border-r border-[color:--color-raw-hairline] bg-[color:--color-raw-paper] text-[0.76rem] font-medium text-[color:--color-raw-ink-soft] transition-colors duration-150 last:border-r-0',
            'hover:not-disabled:bg-[color:--color-raw-green-soft] hover:not-disabled:text-[color:--color-raw-ink]',
            'data-[state=on]:border-[color:--color-raw-green] data-[state=on]:bg-[color:--color-raw-green-soft] data-[state=on]:text-[color:--color-raw-ink]',
            'disabled:cursor-not-allowed disabled:opacity-50',
            'focus-visible:outline-2 focus-visible:outline-[color:--color-raw-green] focus-visible:outline-offset-2',
          ].join(' ')}
        >
          {labels[level]}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  )
}
