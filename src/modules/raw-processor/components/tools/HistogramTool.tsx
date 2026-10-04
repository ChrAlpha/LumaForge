import type {
  PreviewHistogramState,
  ReadyPreviewHistogram,
} from '@lumaforge/luma-color-runtime'
import { scaleLinear } from '@visx/scale'
import { AreaClosed, LinePath } from '@visx/shape'
import { useMemo } from 'react'

import type { Translate } from '~/lib/i18n'
import { useI18n } from '~/lib/i18n'

import { histogramClippingLabels } from './histogram-clipping'

const VIEWBOX_WIDTH = 128
const VIEWBOX_HEIGHT = 88
const PLOT_PADDING = 3
const BASELINE_Y = VIEWBOX_HEIGHT - PLOT_PADDING
const GRID_X = [32, 64, 96] as const
const GRID_Y = [24, 44, 64] as const

function binsToPoints(bins: Uint32Array) {
  let max = 1
  for (const value of bins) {
    max = Math.max(max, value)
  }

  const xScale = scaleLinear({
    domain: [0, bins.length - 1],
    range: [0, VIEWBOX_WIDTH],
  })
  const yScale = scaleLinear({
    domain: [0, max],
    range: [BASELINE_Y, PLOT_PADDING],
  })

  return {
    points: Array.from(bins, (value, index) => ({
      x: xScale(index),
      y: yScale(value),
    })),
    yScale,
  }
}

function hasNonZeroBins(bins: Uint32Array) {
  return bins.some((value) => value > 0)
}

function sourceLabel(source: ReadyPreviewHistogram['source'], t: Translate) {
  return source === 'bounded-hq'
    ? t('raw.histogram.hq')
    : t('raw.histogram.quick')
}

function readyHistogram(
  histogram: PreviewHistogramState,
): ReadyPreviewHistogram | null {
  if (histogram.state === 'ready') {
    return histogram
  }

  if (histogram.state === 'stale' || histogram.state === 'computing') {
    return histogram.previous
  }

  return null
}

function statusLabel(histogram: PreviewHistogramState, t: Translate) {
  if (histogram.state === 'ready') {
    return sourceLabel(histogram.source, t)
  }

  if (histogram.state === 'computing') {
    return t('raw.histogram.computing')
  }

  if (histogram.state === 'stale') {
    return t('raw.histogram.stale')
  }

  if (histogram.state === 'unsupported') {
    return t('raw.histogram.unsupported')
  }

  return histogram.reason === 'embedded-only'
    ? t('raw.histogram.embeddedOnly')
    : t('raw.histogram.notLoaded')
}

function statusReason(histogram: PreviewHistogramState, t: Translate) {
  if (histogram.state === 'unsupported') {
    return histogram.reason
  }

  if (histogram.state === 'unavailable') {
    return histogram.reason === 'embedded-only'
      ? t('raw.histogram.requiresRendered')
      : t('raw.histogram.chooseRaw')
  }

  return null
}

function HistogramPlot({
  bins,
  ariaLabel,
}: {
  bins: ReadyPreviewHistogram['bins']
  ariaLabel: string
}) {
  const series = useMemo(
    () => ({
      red: binsToPoints(bins.red),
      green: binsToPoints(bins.green),
      blue: binsToPoints(bins.blue),
      luma: binsToPoints(bins.luma),
    }),
    [bins],
  )

  return (
    <svg
      role="img"
      aria-label={ariaLabel}
      className="raw-histogram-plot block h-[108px] w-full overflow-hidden rounded-md"
      viewBox={`0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}`}
      preserveAspectRatio="none"
    >
      <g className="raw-histogram-grid" aria-hidden="true">
        {GRID_X.map((x) => (
          <line
            key={`x-${x}`}
            x1={x}
            x2={x}
            y1={PLOT_PADDING}
            y2={BASELINE_Y}
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {GRID_Y.map((y) => (
          <line
            key={`y-${y}`}
            x1="0"
            x2={VIEWBOX_WIDTH}
            y1={y}
            y2={y}
            vectorEffect="non-scaling-stroke"
          />
        ))}
        <line
          className="raw-histogram-baseline"
          x1="0"
          x2={VIEWBOX_WIDTH}
          y1={BASELINE_Y}
          y2={BASELINE_Y}
          vectorEffect="non-scaling-stroke"
        />
      </g>
      <AreaClosed
        className="raw-histogram-channel-fill raw-histogram-channel-fill-red"
        data={series.red.points}
        x={(d) => d.x}
        y={(d) => d.y}
        yScale={series.red.yScale}
      />
      <AreaClosed
        className="raw-histogram-channel-fill raw-histogram-channel-fill-green"
        data={series.green.points}
        x={(d) => d.x}
        y={(d) => d.y}
        yScale={series.green.yScale}
      />
      <AreaClosed
        className="raw-histogram-channel-fill raw-histogram-channel-fill-blue"
        data={series.blue.points}
        x={(d) => d.x}
        y={(d) => d.y}
        yScale={series.blue.yScale}
      />
      {hasNonZeroBins(bins.red) && (
        <LinePath
          className="raw-histogram-channel-line raw-histogram-channel-line-red"
          data={series.red.points}
          x={(d) => d.x}
          y={(d) => d.y}
        />
      )}
      {hasNonZeroBins(bins.green) && (
        <LinePath
          className="raw-histogram-channel-line raw-histogram-channel-line-green"
          data={series.green.points}
          x={(d) => d.x}
          y={(d) => d.y}
        />
      )}
      {hasNonZeroBins(bins.blue) && (
        <LinePath
          className="raw-histogram-channel-line raw-histogram-channel-line-blue"
          data={series.blue.points}
          x={(d) => d.x}
          y={(d) => d.y}
        />
      )}
      <LinePath
        className="raw-histogram-luma"
        data={series.luma.points}
        x={(d) => d.x}
        y={(d) => d.y}
      />
    </svg>
  )
}

export function HistogramTool({
  histogram,
  heading = false,
}: {
  histogram: PreviewHistogramState
  /**
   * Render the "Histogram" title in the card itself. Desktop leaves it off
   * because its tool card trigger already carries the title; the floating
   * mobile card has no trigger, so without this the source label read as the
   * title.
   */
  heading?: boolean
}) {
  const { t } = useI18n()
  const ready = readyHistogram(histogram)
  const label = statusLabel(histogram, t)
  const reason = statusReason(histogram, t)
  const clipping = ready ? histogramClippingLabels(ready, t) : null

  return (
    <div className="grid gap-3">
      <div className="grid gap-1">
        <div className="flex items-baseline justify-between gap-2">
          {heading && (
            <h2 className="m-0 text-[0.82rem] font-semibold leading-tight text-lf-on-surface">
              {t('raw.histogram.title')}
            </h2>
          )}
          {/* Source (Quick / HQ preview) or pipeline state, as meta. */}
          <span
            data-histogram-source
            className="text-[0.68rem] font-medium text-lf-on-surface/56"
          >
            {label}
          </span>
        </div>
        {reason && (
          <p className="m-0 text-[0.78rem] leading-snug text-lf-on-surface/72">
            {reason}
          </p>
        )}
      </div>
      {ready && clipping ? (
        <>
          <HistogramPlot
            bins={ready.bins}
            ariaLabel={t('raw.histogram.aria')}
          />
          {/* Clipping as a share of sampled pixels; raw counts said nothing
              without the total. */}
          <div
            data-histogram-clipping
            className="flex flex-wrap gap-x-3 gap-y-1 text-[0.72rem] tabular-nums text-lf-on-surface/76"
          >
            <span>{clipping.shadows}</span>
            <span>{clipping.highlights}</span>
          </div>
        </>
      ) : null}
    </div>
  )
}
