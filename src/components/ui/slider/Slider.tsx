import * as SliderPrimitive from '@radix-ui/react-slider'
import * as React from 'react'

import { clsxm } from '~/lib/cn'

type SliderRootProps = React.ComponentPropsWithoutRef<
  typeof SliderPrimitive.Root
>

export type SliderProps = SliderRootProps & {
  variant?: 'primary' | 'secondary'
  thumbAriaLabel?: string
  thumbAriaLabelledBy?: string
  /**
   * CSS `background` for the Track. When provided, replaces the default
   * dim cool-slate wash. Use `slider-tracks` helpers for directional cues
   * (temperature, tint, HSL hue/sat/light).
   */
  track?: string
  /**
   * CSS `background` for the Range fill. When provided, overrides the
   * default. Defaults are determined by `variant` and `bipolar`.
   */
  range?: string
  /**
   * When true, the Range fill anchors at 0 (i.e. the centre of a
   * symmetric [-N, N] domain) and extends toward the current value.
   * Mirrors LrC's "offset from neutral" idiom. Requires a single-thumb
   * slider with a fixed numeric domain; multi-thumb sliders fall back
   * to the default Radix Range behaviour.
   */
  bipolar?: boolean
  ref?: React.Ref<React.ElementRef<typeof SliderPrimitive.Root> | null>
}

function clampPct(pct: number): number {
  if (Number.isNaN(pct)) return 0
  if (pct < 0) return 0
  if (pct > 100) return 100
  return pct
}

function computeBipolar(
  value: readonly number[] | undefined,
  min: number,
  max: number,
): { start: number; width: number } | null {
  if (!value || value.length !== 1) return null
  const span = max - min
  if (span <= 0) return null
  const current = value[0]
  if (typeof current !== 'number' || Number.isNaN(current)) return null
  const centerPct = clampPct(((0 - min) / span) * 100)
  const valuePct = clampPct(((current - min) / span) * 100)
  const start = Math.min(centerPct, valuePct)
  const width = Math.abs(valuePct - centerPct)
  return { start, width }
}

export const Slider = ({
  ref,
  className,
  thumbAriaLabel,
  thumbAriaLabelledBy,
  variant = 'primary',
  track,
  range,
  bipolar = false,
  ...props
}: SliderProps) => {
  const min = props.min ?? 0
  const max = props.max ?? 100
  const liveValue = (props.value ?? props.defaultValue) as
    | readonly number[]
    | undefined

  const bipolarOverlay = bipolar ? computeBipolar(liveValue, min, max) : null

  // Default Range/Track backgrounds when caller doesn't override.
  const defaultBipolarRangeBg = track
    ? 'oklch(from var(--color-lf-amber) l c h / 0.30)'
    : 'oklch(from var(--color-lf-amber) l c h / 0.55)'

  return (
    <SliderPrimitive.Root
      ref={ref}
      data-slot="slider-root"
      data-bipolar={bipolar ? '' : undefined}
      className={clsxm(
        'group relative flex w-full touch-none select-none items-center data-[disabled]:cursor-not-allowed data-[disabled]:opacity-70',
        "before:absolute before:inset-x-0 before:-inset-y-[19px] before:content-['']",
        className,
      )}
      {...props}
    >
      <SliderPrimitive.Track
        data-slot="slider-track"
        style={track ? { background: track } : undefined}
        className={clsxm(
          'relative h-[5px] w-full grow overflow-hidden rounded-full transition-colors duration-150',
          // Default dim wash; only used when no `track` is provided. Brightens
          // slightly on row hover via the parent `group`.
          !track &&
            'bg-[oklch(from_var(--color-lf-on-surface)_l_c_h_/_0.10)] group-hover:bg-[oklch(from_var(--color-lf-on-surface)_l_c_h_/_0.13)]',
          'group-data-[disabled]:bg-[oklch(from_var(--color-lf-on-surface)_l_c_h_/_0.06)]',
        )}
      >
        {bipolarOverlay ? (
          <div
            data-slot="slider-range"
            data-bipolar=""
            aria-hidden="true"
            style={{
              left: `${bipolarOverlay.start}%`,
              width: `${bipolarOverlay.width}%`,
              background: range ?? defaultBipolarRangeBg,
            }}
            className="pointer-events-none absolute top-0 h-full group-data-[disabled]:opacity-50"
          />
        ) : (
          <SliderPrimitive.Range
            data-slot="slider-range"
            style={range ? { background: range } : undefined}
            className={clsxm(
              'absolute h-full',
              !range &&
                variant === 'primary' &&
                'bg-lf-green-deep/55 group-data-[disabled]:bg-[oklch(from_var(--color-lf-on-surface)_l_c_h_/_0.15)]',
              !range &&
                variant === 'secondary' &&
                'bg-[oklch(from_var(--color-lf-on-surface)_l_c_h_/_0.25)]',
            )}
          />
        )}
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb
        data-slot="slider-thumb"
        aria-label={thumbAriaLabel}
        aria-labelledby={thumbAriaLabelledBy}
        className={clsxm(
          'block size-[15px] rounded-full bg-lf-surface transition-[transform,box-shadow] duration-150',
          // Cool-tone halo + drop shadow — aligned with segmented-chrome
          // language so the thumb reads as one of the chrome's lifts.
          'shadow-[0_1px_2px_oklch(0.18_0.018_76/0.28),0_0_0_1px_oklch(0.96_0.006_255/0.18)]',
          'hover:scale-[1.06] hover:shadow-[0_2px_4px_oklch(0.18_0.018_76/0.34),0_0_0_1px_oklch(0.96_0.006_255/0.32)]',
          'active:scale-[1.04]',
          // Unified focus ring (segmented-chrome contract).
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lf-green/80',
          'disabled:pointer-events-none disabled:opacity-50',
          'data-[disabled]:bg-lf-surface-sunk data-[disabled]:hover:scale-100 data-[disabled]:shadow-[0_0_0_1px_oklch(from_var(--color-lf-on-surface)_l_c_h_/_0.10)]',
        )}
      />
    </SliderPrimitive.Root>
  )
}
Slider.displayName = SliderPrimitive.Root.displayName
