import clsx from 'clsx'
import type { HTMLAttributes } from 'react'

type ChipTone = 'neutral' | 'amber'
type ChipSurface = 'paper' | 'on-photo'

interface ChipProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: ChipTone
  surface?: ChipSurface
}

const TONE_PAPER: Record<ChipTone, string> = {
  neutral: 'bg-lf-surface-sunk text-lf-on-surface-soft border-lf-hairline',
  amber: 'bg-lf-amber-soft text-lf-on-surface border-lf-amber',
}

const TONE_ON_PHOTO: Record<ChipTone, string> = {
  neutral:
    'bg-lf-on-photo-bg text-lf-on-photo-ink border-lf-on-photo-bord-soft',
  amber: 'bg-lf-on-photo-bg-strong text-lf-amber border-lf-amber/55',
}

export function Chip({
  tone = 'neutral',
  surface = 'paper',
  className,
  children,
  ...rest
}: ChipProps) {
  const tonePalette = surface === 'on-photo' ? TONE_ON_PHOTO : TONE_PAPER
  return (
    <span
      {...rest}
      className={clsx(
        'inline-flex items-center gap-1 rounded-lf-pill border font-medium whitespace-nowrap',
        'h-6 px-2 text-lf-label tracking-wide uppercase',
        tonePalette[tone],
        className,
      )}
    >
      {children}
    </span>
  )
}

export type { ChipProps, ChipSurface, ChipTone }
