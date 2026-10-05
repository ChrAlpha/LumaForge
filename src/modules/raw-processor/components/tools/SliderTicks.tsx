import { clsxm } from '~/lib/cn'

export interface SliderTickMark {
  value: number
  label: string
}

function tickPercent(value: number, min: number, max: number) {
  const span = max - min
  if (!(span > 0)) return 0
  return Math.min(100, Math.max(0, ((value - min) / span) * 100))
}

/**
 * Detent marks drawn on a slider's track. Render it before the Slider in a
 * `relative` wrapper whose padding centres the track: positioned in tree
 * order, the marks paint under the track's thumb and poke out above and
 * below the 5px track. They sit at the track's own percent mapping, the one
 * the scrub model's tap capture uses.
 */
export function SliderTickMarks(props: {
  ticks: readonly SliderTickMark[]
  min: number
  max: number
  disabled?: boolean
}) {
  return (
    <span aria-hidden="true" data-slider-ticks className="contents">
      {props.ticks.map((tick) => (
        <span
          key={tick.value}
          data-slider-tick={tick.value}
          style={{
            left: `calc(${tickPercent(tick.value, props.min, props.max)}% - 0.5px)`,
          }}
          className={clsxm(
            'pointer-events-none absolute top-1/2 h-[9px] w-px -translate-y-1/2 rounded-full',
            // A hairline on the cool lift hue; dimmer while the row is off.
            props.disabled
              ? 'bg-[oklch(0.96_0.006_255/0.16)]'
              : 'bg-[oklch(0.96_0.006_255/0.36)]',
          )}
        />
      ))}
    </span>
  )
}

/**
 * The tick names under a slider's track: centred under their marks, with
 * a mark at either end of the track aligned to that end so its name never
 * leaves the row.
 */
export function SliderTickLabels(props: {
  ticks: readonly SliderTickMark[]
  min: number
  max: number
  className?: string
}) {
  return (
    <div
      aria-hidden="true"
      data-slider-tick-labels
      className={clsxm(
        'relative h-2.5 text-[0.6rem] leading-none text-lf-on-photo-ink/52',
        props.className,
      )}
    >
      {props.ticks.map((tick) => {
        const percent = tickPercent(tick.value, props.min, props.max)
        const edge = percent >= 100 ? 'end' : percent <= 0 ? 'start' : null
        return (
          <span
            key={tick.value}
            data-slider-tick-label={tick.value}
            style={
              edge === 'end'
                ? { right: 0 }
                : edge === 'start'
                  ? { left: 0 }
                  : { left: `${percent}%` }
            }
            className={clsxm(
              'absolute top-0 whitespace-nowrap',
              !edge && '-translate-x-1/2',
            )}
          >
            {tick.label}
          </span>
        )
      })}
    </div>
  )
}
