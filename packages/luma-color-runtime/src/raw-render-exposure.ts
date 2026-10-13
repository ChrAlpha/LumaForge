const UINT16_MAX = 65535
const AUTO_EV_LIMIT = 3
const TARGET_P95_LUMINANCE = 0.75
const TARGET_P99_LUMINANCE = 0.65
const MIN_USABLE_LUMINANCE = 1 / UINT16_MAX

export const RAW_RENDER_EXPOSURE_SOURCES = [
  'dng-baseline',
  'image-statistics',
  'identity',
  'user',
] as const

export type RawRenderExposureSource =
  (typeof RAW_RENDER_EXPOSURE_SOURCES)[number]

export type RawRenderExposure = {
  ev: number
  multiplier: number
  source: RawRenderExposureSource
}

export type RawRenderExposureMetadata = {
  baselineExposure?: number
}

export type RawRenderExposureImage = {
  data: Uint16Array
  width: number
  height: number
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

function finiteOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function isValidImageDimension(value: number) {
  return Number.isSafeInteger(value) && value > 0
}

export function exposureMultiplierFromEv(ev: number) {
  return Math.pow(2, ev)
}

function exposure(
  ev: number,
  source: RawRenderExposureSource,
): RawRenderExposure {
  const clampedEv = clamp(ev, -AUTO_EV_LIMIT, AUTO_EV_LIMIT)
  return {
    ev: clampedEv,
    multiplier: exposureMultiplierFromEv(clampedEv),
    source,
  }
}

function percentile(sorted: number[], p: number) {
  const index = clamp(Math.floor((sorted.length - 1) * p), 0, sorted.length - 1)
  return sorted[index] ?? 0
}

export function estimateRawRenderExposureFromRgbU16(
  image: RawRenderExposureImage,
): RawRenderExposure {
  if (
    !isValidImageDimension(image.width) ||
    !isValidImageDimension(image.height)
  ) {
    return exposure(0, 'identity')
  }

  const sampleCount = image.width * image.height
  const expectedDataLength = sampleCount * 3
  if (
    !Number.isSafeInteger(sampleCount) ||
    !Number.isSafeInteger(expectedDataLength) ||
    image.data.length !== expectedDataLength
  ) {
    return exposure(0, 'identity')
  }

  const step = Math.max(1, Math.floor(sampleCount / 4096))
  const luminance: number[] = []
  for (let pixel = 0; pixel < sampleCount; pixel += step) {
    const offset = pixel * 3
    const r = (image.data[offset] ?? 0) / UINT16_MAX
    const g = (image.data[offset + 1] ?? 0) / UINT16_MAX
    const b = (image.data[offset + 2] ?? 0) / UINT16_MAX
    const y = 0.2880402 * r + 0.7118741 * g + 0.0000857 * b
    if (Number.isFinite(y) && y > MIN_USABLE_LUMINANCE) {
      luminance.push(y)
    }
  }

  if (luminance.length === 0) return exposure(0, 'identity')

  luminance.sort((left, right) => left - right)
  const p95 = percentile(luminance, 0.95)
  if (p95 <= MIN_USABLE_LUMINANCE) return exposure(0, 'identity')

  const p95Ev = Math.log2(TARGET_P95_LUMINANCE / p95)
  const p99 = percentile(luminance, 0.99)
  const p99Ev =
    p99 > p95 ? Math.max(0, Math.log2(TARGET_P99_LUMINANCE / p99)) : p95Ev

  return exposure(Math.min(p95Ev, p99Ev), 'image-statistics')
}

export function resolveRawRenderExposure(input: {
  metadata: RawRenderExposureMetadata
  image: RawRenderExposureImage | null
}): RawRenderExposure {
  const baselineExposure = finiteOrUndefined(input.metadata.baselineExposure)
  if (baselineExposure !== undefined) {
    return exposure(baselineExposure, 'dng-baseline')
  }

  if (input.image) return estimateRawRenderExposureFromRgbU16(input.image)

  return exposure(0, 'identity')
}
