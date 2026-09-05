import type { Metrics } from '../schemas/results'

const HISTOGRAM_BINS = 16
const CLIP_HIGH = 250 / 255
const CLIP_LOW = 5 / 255

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}

function percentile(sorted: Float32Array, p: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor((sorted.length - 1) * p)),
  )
  return sorted[index]
}

export function computeImageMetrics(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  options: { maxSamples?: number; approximate?: boolean } = {},
): Metrics {
  const pixels = width * height
  const maxSamples = options.maxSamples ?? 250_000
  const step = Math.max(1, Math.floor(pixels / maxSamples))
  const sampleCount = Math.floor((pixels - 1) / step) + 1
  const luma = new Float32Array(sampleCount)
  const histogram = Array.from({ length: HISTOGRAM_BINS }).fill(0)
  let clippedHigh = 0
  let clippedLow = 0
  let saturationSum = 0
  let rgSum = 0
  let ybSum = 0
  let rgSq = 0
  let ybSq = 0
  let lumaSum = 0

  let sample = 0
  for (let p = 0; p < pixels; p += step, sample += 1) {
    const o = p * 4
    const r = rgba[o] / 255
    const g = rgba[o + 1] / 255
    const b = rgba[o + 2] / 255
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b
    luma[sample] = y
    lumaSum += y
    histogram[Math.min(HISTOGRAM_BINS - 1, Math.floor(y * HISTOGRAM_BINS))] += 1
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    if (max >= CLIP_HIGH) clippedHigh += 1
    if (max <= CLIP_LOW) clippedLow += 1
    saturationSum += max > 0 ? (max - min) / max : 0
    const rg = (r - g) * 255
    const yb = (0.5 * (r + g) - b) * 255
    rgSum += rg
    ybSum += yb
    rgSq += rg * rg
    ybSq += yb * yb
  }

  const n = Math.max(1, sampleCount)
  const rgMean = rgSum / n
  const ybMean = ybSum / n
  const rgStd = Math.sqrt(Math.max(0, rgSq / n - rgMean * rgMean))
  const ybStd = Math.sqrt(Math.max(0, ybSq / n - ybMean * ybMean))
  const colorfulness =
    Math.sqrt(rgStd * rgStd + ybStd * ybStd) +
    0.3 * Math.sqrt(rgMean * rgMean + ybMean * ybMean)
  const sorted = luma.slice().sort()

  return {
    schema: 'lmfg.metrics.v1',
    width,
    height,
    sampled_pixels: sampleCount,
    luma: {
      mean: round(lumaSum / n),
      p1: round(percentile(sorted, 0.01)),
      p50: round(percentile(sorted, 0.5)),
      p99: round(percentile(sorted, 0.99)),
      clipped_highlight_ratio: round(clippedHigh / n),
      clipped_shadow_ratio: round(clippedLow / n),
    },
    chroma: {
      mean_saturation: round(saturationSum / n),
      colorfulness: round(colorfulness),
    },
    histogram: { bins: HISTOGRAM_BINS, luma: histogram },
    approximate: options.approximate ?? false,
  }
}
