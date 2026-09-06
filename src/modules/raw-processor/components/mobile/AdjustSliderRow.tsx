import { useSetAtom } from 'jotai'

import { Slider } from '~/components/ui/slider/Slider'
import { clsxm } from '~/lib/cn'
import { useI18n } from '~/lib/i18n'

import { scrubGainBandAtom } from '../../state/scrub.atoms'
import { GAIN_LABEL_KEY } from '../tools/scrub-gain-copy'
import { useSliderScrub } from '../tools/useSliderScrub'

type AdjustSliderRowProps = {
  label: string
  value: number
  min: number
  max: number
  step: number
  formatValue: (v: number) => string
  resetAriaLabel: string
  activeScrub?: boolean
  siblingScrubbing?: boolean
  /**
   * Optional directional gradient for the Slider track (temperature, tint,
   * HSL hue/sat/light). When omitted the Slider falls back to its dim wash.
   */
  track?: string
  /**
   * When true (default) the Slider renders a bipolar Range anchored at 0,
   * so the dirty fill reads as "offset from neutral". Set false for
   * unipolar domains (e.g. 0..1 strength meters).
   */
  bipolar?: boolean
  onChange: (value: number) => void
  onScrubChange: (scrubbing: boolean) => void
}

export function AdjustSliderRow(props: AdjustSliderRowProps) {
  const dirty = props.value !== 0
  const formatted = props.formatValue(props.value)
  const activeScrub = props.activeScrub === true
  const siblingScrubbing = props.siblingScrubbing === true
  const bipolar = props.bipolar !== false
  const setGainBand = useSetAtom(scrubGainBandAtom)
  const { t } = useI18n()
  const { onChange } = props

  // The row owns pointer interaction (direction lock, gain bands, sticky
  // zero); the Radix Slider inside stays the visual + keyboard layer.
  const scrub = useSliderScrub({
    value: props.value,
    min: props.min,
    max: props.max,
    step: props.step,
    onChange,
    onScrubChange: props.onScrubChange,
    onGainChange: setGainBand,
    onReset: () => onChange(0),
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
        'grid gap-1 rounded-md px-3 py-1.5 transition-[opacity,background-color] duration-150',
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
      <div className="flex min-h-6 items-center justify-between gap-2 [text-shadow:0_1px_2px_oklch(0_0_0/0.45)]">
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
            disabled={!dirty}
            aria-label={props.resetAriaLabel}
            onClick={() => onChange(0)}
            className={clsxm(
              '-my-1.5 inline-flex min-h-9 items-center justify-end rounded-md px-1 text-right text-[0.82rem] font-semibold tabular-nums transition-colors',
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
          'py-1.5',
          '[&_[data-slot=slider-thumb]]:size-5 [&_[data-slot=slider-thumb]]:transition-[width,height,transform,box-shadow] [&_[data-slot=slider-thumb]]:duration-150',
          activeScrub &&
            '[&_[data-slot=slider-thumb]]:size-6 [&_[data-slot=slider-thumb]]:shadow-[0_2px_6px_oklch(0.18_0.018_76/0.4),0_0_0_1px_oklch(0.96_0.006_255/0.36)]',
        )}
      >
        <Slider
          thumbAriaLabel={props.label}
          value={[props.value]}
          min={props.min}
          max={props.max}
          step={props.step}
          bipolar={bipolar}
          track={props.track}
          onValueChange={([next]) => {
            // Keyboard path (arrow keys on the Radix thumb).
            if (next !== undefined) {
              onChange(next)
            }
          }}
        />
      </div>
    </div>
  )
}
