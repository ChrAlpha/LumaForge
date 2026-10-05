import { SegmentGroup, SegmentItem } from '~/components/ui/segment'
import { cn } from '~/lib/cn'
import { useI18n } from '~/lib/i18n'

import { LOOK_INTENSITY_PRESETS } from '../../services/look/style-system'
import {
  SEGMENTED_FOCUS_RING,
  SEGMENTED_ITEM_TEXT,
  SEGMENTED_ITEM_TEXT_ACTIVE,
  SEGMENTED_THUMB_ACTIVE_VIA_PARENT,
  SEGMENTED_TRACK,
} from './segmented-chrome'

const LEVELS = ['off', 'light', 'standard', 'strong'] as const

type StrengthLevel = (typeof LEVELS)[number]
export type StrengthControlSize = 'sm' | 'md'

const LEVEL_AMOUNT: Record<StrengthLevel, number> = {
  off: 0,
  ...LOOK_INTENSITY_PRESETS,
}

function isStrengthLevel(value: string): value is StrengthLevel {
  return (LEVELS as readonly string[]).includes(value)
}

/** The segment an amount reads as; none between the presets. */
function levelForAmount(amount: number): StrengthLevel | '' {
  return LEVELS.find((level) => LEVEL_AMOUNT[level] === amount) ?? ''
}

const TRACK_BASE = cn('w-full', SEGMENTED_TRACK)

const ITEM_BASE = cn(
  'flex-1',
  SEGMENTED_ITEM_TEXT,
  SEGMENTED_ITEM_TEXT_ACTIVE,
  SEGMENTED_THUMB_ACTIVE_VIA_PARENT,
  SEGMENTED_FOCUS_RING,
)

const SIZE_TRACK = {
  sm: 'h-9',
  md: 'h-11',
} as const

const SIZE_ITEM = {
  sm: 'text-[0.76rem]',
  md: 'text-lf-control',
} as const

export function StrengthControl({
  value,
  onChange,
  disabled,
  size = 'sm',
  className,
  itemClassName,
  ariaDescribedBy,
}: {
  /** How much of the look reaches the photo, 0..1. */
  value: number
  onChange: (value: number) => void
  disabled: boolean
  size?: StrengthControlSize
  className?: string
  itemClassName?: string
  /** Id of text that explains the control, e.g. why it is disabled. */
  ariaDescribedBy?: string
}) {
  const { t } = useI18n()
  const labels: Record<StrengthLevel, string> = {
    off: t('raw.strength.off'),
    light: t('raw.strength.light'),
    standard: t('raw.strength.standard'),
    strong: t('raw.strength.strong'),
  }

  return (
    <div aria-disabled={disabled} className={disabled ? 'opacity-50' : ''}>
      <SegmentGroup
        value={levelForAmount(value)}
        onValueChanged={(next) => {
          if (isStrengthLevel(next)) {
            onChange(LEVEL_AMOUNT[next])
          }
        }}
        aria-label={t('raw.strength.title')}
        aria-describedby={ariaDescribedBy}
        disabled={disabled}
        className={cn(TRACK_BASE, SIZE_TRACK[size], className)}
      >
        {LEVELS.map((level) => (
          <SegmentItem
            key={level}
            value={level}
            label={labels[level]}
            className={cn(ITEM_BASE, SIZE_ITEM[size], itemClassName)}
          />
        ))}
      </SegmentGroup>
    </div>
  )
}
