import { useSetAtom } from 'jotai'
import type { ReactNode } from 'react'
import { useId } from 'react'

import { Slider } from '~/components/ui/slider'
import { clsxm } from '~/lib/cn'
import { useI18n } from '~/lib/i18n'

import { scrubGainBandAtom } from '../../state/scrub.atoms'
import { useSliderScrub } from './useSliderScrub'

export interface DesktopAdjustRowProps {
  label: string
  /** Screen-reader prefix when the visible label is not the full field name. */
  labelPrefix?: string
  value: number
  min: number
  max: number
  step: number
  disabled: boolean
  formatValue: (value: number) => string
  onChange: (value: number) => void
  /** Directional gradient for the track; see `slider-tracks`. */
  track?: string
  /** Small mark rendered before the label (HSL band swatch). */
  leading?: ReactNode
  /**
   * Accessible name for the slider itself. Defaults to the visible label.
   * HSL passes the axis name here: the eight rows on an axis tab are named
   * by band through the row group, and the slider carries the axis.
   */
  sliderLabel?: string
  /** Expose the row as a labelled group (HSL band rows). */
  asGroup?: boolean
  rowProps?: Record<string, string | undefined>
}

/**
 * One Adjust field on the desktop tool rail: label, live readout, and a
 * directional slider.
 *
 * Shares `useSliderScrub` with the mobile Adjust list so both surfaces have
 * the same gesture contract: press-and-drag from anywhere on the row, Shift
 * for one-tenth speed, double-click or a click on the amber value to reset,
 * and a `data-scrubbing` hook the chrome can style instead of leaning on
 * `:hover`.
 */
export function DesktopAdjustRow({
  label,
  labelPrefix,
  value,
  min,
  max,
  step,
  disabled,
  formatValue,
  onChange,
  track,
  leading,
  sliderLabel,
  asGroup,
  rowProps,
}: DesktopAdjustRowProps) {
  const { t } = useI18n()
  const labelId = useId()
  const dirty = value !== 0
  const setGainBand = useSetAtom(scrubGainBandAtom)
  const reset = () => onChange(0)
  const scrub = useSliderScrub({
    value,
    min,
    max,
    step,
    disabled,
    onChange,
    onGainChange: setGainBand,
    onReset: reset,
  })
  const fine = scrub.scrubbing && scrub.gain === 'fine'
  const formatted = formatValue(value)

  return (
    <div
      {...rowProps}
      role={asGroup ? 'group' : undefined}
      aria-labelledby={asGroup ? labelId : undefined}
      data-adjust-row
      data-dirty={dirty ? '' : undefined}
      data-scrubbing={scrub.scrubbing || undefined}
      data-scrub-gain={scrub.scrubbing ? scrub.gain : undefined}
      className={clsxm(
        'grid gap-1.5 rounded-md px-1.5 py-0.5 transition-colors duration-150',
        disabled
          ? 'cursor-not-allowed'
          : 'cursor-ew-resize hover:bg-[oklch(0.96_0.006_255/0.04)]',
        // Scrub-active is a state, not a hover: the pointer often leaves the
        // row while dragging, and the mobile surface marks the same moment.
        scrub.scrubbing && 'bg-[oklch(0.96_0.006_255/0.06)]',
        // Grow the thumb the way the mobile row does, one step smaller for
        // mouse density.
        '[&_[data-slot=slider-thumb]]:transition-[width,height,transform,box-shadow] [&_[data-slot=slider-thumb]]:duration-150',
        scrub.scrubbing && '[&_[data-slot=slider-thumb]]:size-[17px]',
      )}
      {...scrub.bind}
    >
      <div className="flex items-center justify-between gap-2 text-[0.8rem]">
        <span className="flex min-w-0 items-center gap-2">
          {leading}
          <label
            id={labelId}
            className={clsxm(
              'truncate font-medium transition-colors duration-150',
              dirty ? 'text-lf-amber-soft' : 'text-lf-on-surface/80',
            )}
          >
            {labelPrefix && <span className="sr-only">{labelPrefix}: </span>}
            {label}
          </label>
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          {fine && (
            <span className="text-[0.62rem] font-semibold uppercase tracking-[0.12em] text-lf-on-surface/56">
              {t('raw.adjust.gain.fine')}
            </span>
          )}
          {dirty && !disabled ? (
            <button
              type="button"
              aria-label={t('raw.adjust.fieldResetAria', { label })}
              onClick={reset}
              // The Slider root expands its hit area by 19px vertically so the
              // whole row is draggable. That pseudo-element covers this value,
              // so the reset has to sit above it to stay clickable.
              className="relative z-10 rounded-sm px-0.5 font-medium tabular-nums text-lf-amber-soft transition-colors hover:text-lf-on-surface focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-lf-green/80"
            >
              {formatted}
            </button>
          ) : (
            <output
              aria-hidden="true"
              className={clsxm(
                'px-0.5 font-medium tabular-nums transition-colors duration-150',
                dirty ? 'text-lf-amber-soft' : 'text-lf-on-surface/80',
              )}
            >
              {formatted}
            </output>
          )}
        </span>
      </div>
      <Slider
        thumbAriaLabel={sliderLabel}
        thumbAriaLabelledBy={sliderLabel ? undefined : labelId}
        value={[value]}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        bipolar
        track={track}
        onValueChange={([next]) => {
          if (next !== undefined) {
            onChange(next)
          }
        }}
      />
    </div>
  )
}
