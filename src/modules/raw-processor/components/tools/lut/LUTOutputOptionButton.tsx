import { Monitor } from 'lucide-react'

import { clsxm } from '~/lib/cn'
import { useI18n } from '~/lib/i18n'

import type { LUTOutputOption } from '../../../services/look/lut-output-options'

export type LUTOutputOptionButtonSize = 'comfortable' | 'touch'
export type LUTOutputOptionButtonSurface = 'paper' | 'on-photo'

export function LUTOutputOptionButton({
  option,
  activeOptionId,
  onSelect,
  highlighted = false,
  size = 'comfortable',
  surface = 'paper',
}: {
  option: LUTOutputOption
  activeOptionId?: string
  onSelect: (option: LUTOutputOption) => void
  highlighted?: boolean
  size?: LUTOutputOptionButtonSize
  surface?: LUTOutputOptionButtonSurface
}) {
  const { t } = useI18n()
  const isActive = activeOptionId === option.id
  const isTouch = size === 'touch'
  const isOnPhoto = surface === 'on-photo'

  return (
    <button
      type="button"
      aria-label={t('raw.lutContract.useOutput', { label: option.label })}
      aria-pressed={isActive}
      onClick={() => onSelect(option)}
      className={clsxm(
        'group/lut-row relative grid w-full min-w-0 items-center rounded-md text-left transition-colors duration-150 ease-out',
        isOnPhoto ? 'text-lf-on-photo-ink/76' : 'text-lf-on-surface/75',
        isOnPhoto
          ? 'hover:bg-lf-on-photo-bg-strong hover:text-lf-on-photo-ink'
          : 'hover:bg-[oklch(from_var(--color-lf-on-surface)_l_c_h_/_0.045)] hover:text-lf-on-surface/90',
        'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-lf-green',
        isTouch
          ? 'min-h-[44px] grid-cols-[28px_minmax(0,1fr)] gap-2.5 px-2 py-2'
          : 'grid-cols-[22px_minmax(0,1fr)] gap-2 px-1.5 py-1.5',
        highlighted &&
          !isActive &&
          (isOnPhoto
            ? 'bg-lf-amber/10 text-lf-amber-soft'
            : 'bg-[oklch(from_var(--color-lf-amber)_l_c_h_/_0.10)] text-lf-on-surface/90'),
        isActive &&
          (isOnPhoto
            ? 'bg-lf-on-photo-bg-strong text-lf-green-soft'
            : 'bg-[oklch(from_var(--color-lf-green)_l_c_h_/_0.12)] text-lf-green-deep'),
      )}
      data-raw-lut="contract-option"
      data-raw-lut-size={size}
    >
      <span
        aria-hidden="true"
        className={clsxm(
          'inline-grid place-items-center rounded-md transition-colors duration-150',
          isTouch ? 'size-[28px]' : 'size-[22px]',
          isActive
            ? isOnPhoto
              ? 'bg-lf-green/20 text-lf-green-soft'
              : 'bg-[oklch(from_var(--color-lf-green)_l_c_h_/_0.18)] text-lf-green-deep'
            : highlighted
              ? isOnPhoto
                ? 'bg-lf-amber/15 text-lf-amber-soft'
                : 'bg-[oklch(from_var(--color-lf-amber)_l_c_h_/_0.16)] text-lf-on-surface/70'
              : isOnPhoto
                ? 'bg-lf-on-photo-bg text-lf-on-photo-ink/45 group-hover/lut-row:bg-lf-on-photo-bg-strong group-hover/lut-row:text-lf-on-photo-ink/70'
                : 'bg-[oklch(from_var(--color-lf-on-surface)_l_c_h_/_0.05)] text-lf-on-surface/45 group-hover/lut-row:bg-[oklch(from_var(--color-lf-on-surface)_l_c_h_/_0.08)] group-hover/lut-row:text-lf-on-surface/65',
        )}
      >
        <Monitor
          className={clsxm(
            isTouch ? 'size-[14px]' : 'size-[12px]',
            'stroke-[1.75]',
          )}
        />
      </span>
      <span
        className={clsxm(
          'block min-w-0 break-words leading-[1.35]',
          isTouch ? 'text-[0.82rem]' : 'text-[0.74rem]',
          isActive ? 'font-semibold' : 'font-normal',
        )}
      >
        {option.label}
      </span>
    </button>
  )
}
