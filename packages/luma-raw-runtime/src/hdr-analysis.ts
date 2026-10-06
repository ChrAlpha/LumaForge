import type { LumaRawMetadata } from './types'

/**
 * Level-derived range facts read from RAW metadata alone, plus a coarse
 * SDR/HDR label. `engineeringDynamicRange` is the stops between white and
 * black level, `sensorUtilization` the share of that span the frame's peak
 * reaches, and `highlightHeadroom` the stops left between that peak and white.
 *
 * @deprecated Kept only so existing imports keep compiling. Nothing in
 * LumaForge reads it, and its `recommendation` drives neither preview nor
 * export, which are SDR JPEG paths. It may be removed in a future major
 * version; do not build new behaviour on it.
 */
export type RawDynamicRangeInfo = {
  engineeringDynamicRange: number | null
  sensorUtilization: number | null
  highlightHeadroom: number | null
  effectiveBitDepth: number | null
  perChannelBlack: [number, number, number, number] | null
  sensorSaturation: number | null
  recommendation: 'sdr' | 'hdr-capable' | 'hdr-recommended'
}

function stopsAbove(a: number, b: number): number {
  if (a <= 0 || b <= 0 || a <= b) return 0
  return Math.log2(a / b)
}

function effectiveBits(whiteLevel: number): number {
  if (whiteLevel <= 0) return 0
  return Math.floor(Math.log2(whiteLevel)) + 1
}

function recommendationFromFacts(facts: {
  engineeringDr: number | null
  sensorUtilization: number | null
  highlightHeadroom: number | null
}): RawDynamicRangeInfo['recommendation'] {
  const { engineeringDr, sensorUtilization, highlightHeadroom } = facts

  if (
    engineeringDr !== null &&
    engineeringDr >= 12 &&
    sensorUtilization !== null &&
    sensorUtilization >= 0.25 &&
    highlightHeadroom !== null &&
    highlightHeadroom <= 4
  ) {
    return 'hdr-recommended'
  }

  if (engineeringDr !== null && engineeringDr >= 10) {
    return 'hdr-capable'
  }

  return 'sdr'
}

/**
 * Derives {@link RawDynamicRangeInfo} from metadata black, white, peak, and
 * per-channel black levels without decoding pixels. Facts are null when the
 * black level is missing or zero, or white does not sit above black.
 *
 * @deprecated Kept only so existing callers keep compiling and get the same
 * results. Nothing in LumaForge calls it, and its recommendation drives
 * neither preview nor export. It may be removed in a future major version;
 * do not build new behaviour on it.
 */
export function analyzeRawDynamicRange(
  metadata: LumaRawMetadata,
): RawDynamicRangeInfo {
  const { blackLevel, whiteLevel, dataMaximum, perChannelBlack } = metadata

  const hasUsableLevels =
    blackLevel !== undefined &&
    whiteLevel !== undefined &&
    blackLevel > 0 &&
    whiteLevel > blackLevel

  const engineeringDynamicRange = hasUsableLevels
    ? stopsAbove(whiteLevel!, Math.max(blackLevel!, 1))
    : null

  const sensorUtilization =
    hasUsableLevels && dataMaximum !== undefined && dataMaximum > blackLevel!
      ? (dataMaximum - blackLevel!) / (whiteLevel! - blackLevel!)
      : null

  const highlightHeadroom =
    hasUsableLevels && dataMaximum !== undefined && dataMaximum > 0
      ? stopsAbove(whiteLevel!, Math.max(dataMaximum, 1))
      : null

  const effectiveBitDepth = hasUsableLevels ? effectiveBits(whiteLevel!) : null

  const normalizedPerChannelBlack =
    perChannelBlack && perChannelBlack.length === 4
      ? (perChannelBlack as [number, number, number, number])
      : null

  const sensorSaturation = hasUsableLevels ? whiteLevel! - blackLevel! : null

  const recommendation = recommendationFromFacts({
    engineeringDr: engineeringDynamicRange,
    sensorUtilization,
    highlightHeadroom,
  })

  return {
    engineeringDynamicRange,
    sensorUtilization,
    highlightHeadroom,
    effectiveBitDepth,
    perChannelBlack: normalizedPerChannelBlack,
    sensorSaturation,
    recommendation,
  }
}
