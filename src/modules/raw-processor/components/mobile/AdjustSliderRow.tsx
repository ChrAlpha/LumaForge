import { useSetAtom } from 'jotai'

import { Slider } from '~/components/ui/slider/Slider'
import { clsxm } from '~/lib/cn'

import { scrubGainBandAtom } from '../../state/scrub.atoms'
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

  return (
    <div
      data-adjust-slider-row
      data-active-scrub={activeScrub || undefined}
      data-sibling-scrubbing={siblingScrubbing || undefined}
      data-scrubbing={scrub.scrubbing || undefined}
      className={clsxm(
        'grid min-h-11 grid-cols-[92px_minmax(0,1fr)_46px] items-center gap-2.5 rounded-md border border-transparent px-3 transition-[opacity,background-color,border-color] duration-150',
        activeScrub && 'border-lf-amber/55 bg-lf-on-photo-bg-strong',
        // Siblings step fully out of the way while another row scrubs so
        // the photo is the only thing behind the HUD and the active row.
        siblingScrubbing && 'pointer-events-none opacity-0',
      )}
    >
      <span
        className={clsxm(
          'truncate text-[0.8rem] font-semibold leading-tight [text-shadow:0_1px_2px_oklch(0_0_0/0.45)]',
          dirty ? 'text-lf-amber-soft' : 'text-lf-on-photo-ink',
        )}
      >
        {props.label}
      </span>
      <div
        data-testid="adjust-slider-row-scrub"
        // pan-y hands vertical intent back to the list scroll; the hook's
        // direction lock decides horizontal scrub vs vertical scroll.
        className={clsxm(
          'py-2.5 touch-none',
          // The row owns the entire touch gesture. Chromium locks a pan the
          // moment a `pan-y` surface sees vertical travel, which would eat
          // the precision excursion the gain bands are built on, so the hook
          // takes the gesture and forwards vertical intent to the list scroll
          // itself (momentum included).
          '[&_[data-slot=slider-thumb]]:size-5 [&_[data-slot=slider-thumb]]:transition-[width,height,transform,box-shadow] [&_[data-slot=slider-thumb]]:duration-150',
          activeScrub &&
            '[&_[data-slot=slider-thumb]]:size-6 [&_[data-slot=slider-thumb]]:shadow-[0_2px_6px_oklch(0.18_0.018_76/0.4),0_0_0_1px_oklch(0.96_0.006_255/0.36)]',
        )}
        {...scrub.bind}
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
      {dirty ? (
        <button
          type="button"
          aria-label={props.resetAriaLabel}
          onClick={() => onChange(0)}
          className="inline-flex h-11 items-center justify-end rounded-md px-1 text-right text-[0.82rem] font-semibold tabular-nums text-lf-amber-soft transition-colors [text-shadow:0_1px_2px_oklch(0_0_0/0.45)] hover:text-lf-on-photo-ink"
        >
          {formatted}
        </button>
      ) : (
        <span className="inline-flex h-11 items-center justify-end px-1 text-right text-[0.82rem] font-semibold tabular-nums text-lf-on-photo-ink/92 [text-shadow:0_1px_2px_oklch(0_0_0/0.45)]">
          {formatted}
        </span>
      )}
    </div>
  )
}
