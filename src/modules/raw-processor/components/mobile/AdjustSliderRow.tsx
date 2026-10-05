import { useSetAtom } from 'jotai'
import { useRef } from 'react'

import { Slider } from '~/components/ui/slider/Slider'
import { clsxm } from '~/lib/cn'
import { useI18n } from '~/lib/i18n'

import { scrubGainBandAtom } from '../../state/scrub.atoms'
import { GAIN_LABEL_KEY } from '../tools/scrub-gain-copy'
import type { SliderTickMark } from '../tools/SliderTicks'
import { SliderTickLabels, SliderTickMarks } from '../tools/SliderTicks'
import { useSliderScrub } from '../tools/useSliderScrub'

type AdjustSliderRowProps = {
  label: string
  value: number
  min: number
  max: number
  step: number
  disabled?: boolean
  formatValue: (v: number) => string
  valueText?: string
  resetAriaLabel: string
  activeScrub?: boolean
  siblingScrubbing?: boolean
  /**
   * Optional directional gradient for the Slider track (temperature, tint,
   * HSL hue/sat/light). When omitted the Slider falls back to its dim wash.
   */
  track?: string
  /**
   * When true (default) the Slider renders a bipolar Range anchored at the
   * neutral, so the dirty fill reads as "offset from neutral". Set false
   * for unipolar domains.
   */
  bipolar?: boolean
  /**
   * The value the field rests at and resets to. Defaults to 0; the value
   * reads amber (and is the reset) whenever it is anywhere else.
   */
  neutral?: number
  /** Values the scrub sticks to; defaults to the neutral alone. */
  detents?: readonly number[]
  /** Marks on the track with tiny names under it. */
  ticks?: readonly SliderTickMark[]
  /**
   * `list` for the Adjust lists; `compact` for a single row set inside a
   * deck, which drops the list padding so the row is about one touch
   * target tall.
   */
  density?: 'list' | 'compact'
  /** Id of text that explains the slider, e.g. why it is disabled. */
  describedBy?: string
  onChange: (value: number) => void
  onScrubChange: (scrubbing: boolean) => void
}

export function AdjustSliderRow(props: AdjustSliderRowProps) {
  const neutral = props.neutral ?? 0
  const compact = props.density === 'compact'
  const dirty = props.value !== neutral
  const formatted = props.formatValue(props.value)
  const activeScrub = props.activeScrub === true
  const siblingScrubbing = props.siblingScrubbing === true
  const bipolar = props.bipolar !== false
  const setGainBand = useSetAtom(scrubGainBandAtom)
  const { t } = useI18n()
  const disabled = props.disabled === true
  const disabledRef = useRef(disabled)
  disabledRef.current = disabled
  const onChange = (next: number) => {
    if (!disabledRef.current) props.onChange(next)
  }

  // The row owns pointer interaction (direction lock, gain bands, sticky
  // zero); the Radix Slider inside stays the visual + keyboard layer.
  const scrub = useSliderScrub({
    value: props.value,
    min: props.min,
    max: props.max,
    step: props.step,
    neutral,
    detents: props.detents,
    disabled,
    onChange,
    onScrubChange: props.onScrubChange,
    onGainChange: setGainBand,
    onReset: () => onChange(neutral),
  })
  const gainLabel =
    scrub.scrubbing && scrub.gain !== 'full'
      ? t(GAIN_LABEL_KEY[scrub.gain])
      : null

  return (
    <div
      data-adjust-slider-row
      data-active-scrub={activeScrub || undefined}
      data-sibling-scrubbing={siblingScrubbing || undefined}
      data-scrubbing={scrub.scrubbing || undefined}
      className={clsxm(
        'grid rounded-md transition-[opacity,background-color] duration-150',
        compact ? '-mx-1.5 px-1.5' : 'gap-1 px-3 py-1.5',
        // Two lines, the same anatomy the desktop rail uses: label and value
        // above, a full-width track below. On a 393px viewport that takes the
        // track from ~181px to ~341px, so the coarse pointer finally gets more
        // resolution than the mouse instead of 58% of it.
        // The whole row is the scrub surface: a press on the label or the
        // readout grabs the value too, and one `touch-none` surface means one
        // set of scroll physics across the row. Chromium locks a pan the
        // moment a `pan-y` surface sees vertical travel, which would eat the
        // precision excursion the gain bands are built on, so the hook takes
        // the gesture and forwards vertical intent to the list scroll itself
        // (momentum included).
        'touch-none',
        // Scrub-active uses the cool lift wash, the same mark desktop uses.
        // Amber is reserved for "this band is open" in the HSL list, and the
        // two states can coexist on one row.
        activeScrub && 'bg-[oklch(0.96_0.006_255/0.06)]',
        // Neighbours dim rather than disappear: the tonal neighbourhood is
        // what a photographer reads while a value moves, and behind them in
        // the default layout is the dock, not the photograph.
        siblingScrubbing && 'pointer-events-none opacity-45',
      )}
      {...scrub.bind}
    >
      <div
        className={clsxm(
          'flex items-center justify-between gap-2 [text-shadow:0_1px_2px_oklch(0_0_0/0.45)]',
          compact ? 'min-h-4' : 'min-h-6',
        )}
      >
        <span
          className={clsxm(
            'truncate text-[0.82rem] font-semibold leading-tight',
            dirty ? 'text-lf-amber-soft' : 'text-lf-on-photo-ink',
          )}
        >
          {props.label}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {/* The precision band reads beside the value, under the thumb,
              rather than at the far end of the screen. */}
          {gainLabel && (
            <span className="text-[0.62rem] font-semibold uppercase tracking-[0.12em] text-lf-on-photo-ink/72">
              {gainLabel}
            </span>
          )}
          {/* One element across states: swapping button for span on reset
              would unmount the focused control and drop focus to the body.
              Negative block margin keeps the 36px target from growing the
              row. */}
          <button
            type="button"
            disabled={disabled || !dirty}
            aria-label={props.resetAriaLabel}
            onClick={() => onChange(neutral)}
            className={clsxm(
              'inline-flex min-h-9 items-center justify-end rounded-md px-1 text-right text-[0.82rem] font-semibold tabular-nums transition-colors',
              compact ? '-my-2.5' : '-my-1.5',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lf-green/80',
              dirty
                ? 'text-lf-amber-soft hover:text-lf-on-photo-ink'
                : 'cursor-default text-lf-on-photo-ink/92',
            )}
          >
            {formatted}
          </button>
        </span>
      </div>
      <div
        data-testid="adjust-slider-row-scrub"
        className={clsxm(
          'relative',
          compact ? 'py-2' : 'py-1.5',
          '[&_[data-slot=slider-thumb]]:size-5 [&_[data-slot=slider-thumb]]:transition-[width,height,transform,box-shadow] [&_[data-slot=slider-thumb]]:duration-150',
          activeScrub &&
            '[&_[data-slot=slider-thumb]]:size-6 [&_[data-slot=slider-thumb]]:shadow-[0_2px_6px_oklch(0.18_0.018_76/0.4),0_0_0_1px_oklch(0.96_0.006_255/0.36)]',
        )}
      >
        {props.ticks && (
          <SliderTickMarks
            ticks={props.ticks}
            min={props.min}
            max={props.max}
            disabled={disabled}
          />
        )}
        <Slider
          thumbAriaLabel={props.label}
          thumbAriaValueText={props.valueText}
          thumbAriaDescribedBy={props.describedBy}
          value={[props.value]}
          min={props.min}
          max={props.max}
          step={props.step}
          disabled={disabled}
          bipolar={bipolar}
          bipolarAnchor={neutral}
          track={props.track}
          onValueChange={([next]) => {
            // Keyboard path (arrow keys on the Radix thumb).
            if (next !== undefined) {
              onChange(next)
            }
          }}
        />
      </div>
      {props.ticks && (
        <SliderTickLabels ticks={props.ticks} min={props.min} max={props.max} />
      )}
    </div>
  )
}
