import type {
  ExportColorGraphDescriptor,
  ExportColorGraphStep,
} from './color-graph'
import {
  EXPORT_LUT_STEP_KINDS,
  EXPORT_PLAIN_STEP_KINDS,
  resolveEffectiveLUTOutputTransfer,
} from './color-graph'
import { HDR_NOMINAL_PEAK_LINEAR } from './hdr-reference'
import { isSceneLogTransfer } from './log-encoding'
import { getGamutMatrix } from './matrix'
import type { LUTColorProfile } from './registry'

/**
 * The HDR rendition a gain-map export carries, and the gain map (ISO 21496-1)
 * that lifts the SDR export onto it. The SDR export stays the base image,
 * unchanged; the gain map adds the HDR rendition on top of it.
 *
 * The HDR rendition is the scene the look renders, in linear BT.2020, where
 * 1.0 is HDR Reference White (203 cd/m², the SDR export's white): the scene
 * after every user step, or for a scene-creative LUT that scene mixed by the
 * look strength with the LUT's output decoded back to scene light. Each
 * channel clips to [0, the nominal peak]. An in-gamut color below SDR white
 * is the same in both renditions, so its gain is zero.
 *
 * The gain map records, per channel, log2((hdr + offset) / (base + offset)),
 * with the base converted to BT.2020. Every map uses the same fixed range, so
 * a gain of zero is an exact code and the decoder metadata is constant.
 */

/** The alternate (HDR) rendition's primaries; the gain map applies here. */
export const HDR_GAIN_MAP_GAMUT = 'rec2020'

/** k_base and k_alternate: keep log2 finite at black. */
export const HDR_GAIN_MAP_OFFSET = 1 / 64

export const HDR_GAIN_MAP_GAMMA = 1

/** The base image is SDR: a display with no headroom shows it unchanged. */
export const HDR_GAIN_MAP_BASE_HEADROOM = 0

/** The alternate rendition peaks at the nominal peak over reference white. */
export const HDR_GAIN_MAP_ALTERNATE_HEADROOM = Math.log2(
  HDR_NOMINAL_PEAK_LINEAR,
)

const GAIN_MAP_CODE_MAX = 255

/** HDR black over SDR white: the lowest gain the rendition can need. */
const GAIN_FLOOR = Math.log2(HDR_GAIN_MAP_OFFSET / (1 + HDR_GAIN_MAP_OFFSET))

/** HDR peak over SDR black: the highest gain the rendition can need. */
const GAIN_CEILING = Math.log2(
  (HDR_NOMINAL_PEAK_LINEAR + HDR_GAIN_MAP_OFFSET) / HDR_GAIN_MAP_OFFSET,
)

/**
 * The code that stands for no gain. SDR-range pixels and the geometry matte
 * carry it, so the HDR rendition reproduces the base there exactly.
 */
export const HDR_GAIN_MAP_NEUTRAL_CODE = Math.round(
  (GAIN_MAP_CODE_MAX * -GAIN_FLOOR) / (GAIN_CEILING - GAIN_FLOOR),
)

/** log2 gain per code step, wide enough for both the floor and the ceiling. */
const GAIN_STEP = Math.max(
  -GAIN_FLOOR / HDR_GAIN_MAP_NEUTRAL_CODE,
  GAIN_CEILING / (GAIN_MAP_CODE_MAX - HDR_GAIN_MAP_NEUTRAL_CODE),
)

/** The gain code 0 stands for, in log2. */
export const HDR_GAIN_MAP_LOG2_MIN = -HDR_GAIN_MAP_NEUTRAL_CODE * GAIN_STEP

/** The gain code 255 stands for, in log2. */
export const HDR_GAIN_MAP_LOG2_MAX =
  (GAIN_MAP_CODE_MAX - HDR_GAIN_MAP_NEUTRAL_CODE) * GAIN_STEP

/** Float slack on the range gate; far below one code step. */
const GAIN_RANGE_TOLERANCE = 1e-4

export type HdrGainMapSupport =
  | { supported: true }
  | {
      supported: false
      /**
       * `lut-display-output`: the LUT outputs a display signal graded for
       * SDR, and nothing defines how it continues above SDR white.
       */
      reason: 'unsupported-pipeline' | 'lut-display-output'
    }

/**
 * Whether a LUT's output still holds the scene above SDR white: a
 * scene-creative LUT that outputs a scene-referred log encoding maps scene
 * light to scene light, so its output decodes to the HDR highlights. Every
 * other LUT outputs a display signal for an SDR screen.
 */
export function lutHasHdrRendition(profile: LUTColorProfile): boolean {
  const outputTransfer = resolveEffectiveLUTOutputTransfer(profile)
  return (
    profile.role === 'scene-creative' &&
    outputTransfer !== undefined &&
    isSceneLogTransfer(outputTransfer)
  )
}

function hasStepKinds(
  steps: readonly ExportColorGraphStep[],
  kinds: readonly ExportColorGraphStep['kind'][],
) {
  return (
    steps.length === kinds.length &&
    steps.every((step, index) => step.kind === kinds[index])
  )
}

/**
 * Whether a graph has an HDR rendition: a supported graph without a LUT, or
 * one whose LUT keeps the scene (`lutHasHdrRendition`). Its scene values
 * above SDR white are the HDR highlights.
 */
export function resolveHdrGainMapSupport(
  graph: ExportColorGraphDescriptor,
): HdrGainMapSupport {
  if (!graph.supported) {
    return { supported: false, reason: 'unsupported-pipeline' }
  }
  const { lutProfile, steps } = graph
  if (lutProfile === null) {
    return hasStepKinds(steps, EXPORT_PLAIN_STEP_KINDS)
      ? { supported: true }
      : { supported: false, reason: 'unsupported-pipeline' }
  }
  if (!lutHasHdrRendition(lutProfile)) {
    return { supported: false, reason: 'lut-display-output' }
  }
  const output = steps.find((step) => step.kind === 'lut-output-to-srgb')
  return hasStepKinds(steps, EXPORT_LUT_STEP_KINDS) &&
    output?.role === 'scene-creative' &&
    isSceneLogTransfer(output.transfer)
    ? { supported: true }
    : { supported: false, reason: 'unsupported-pipeline' }
}

/** The log2 gain a code stands for, as an ISO 21496-1 decoder reads it. */
export function hdrGainMapLog2FromCode(code: number): number {
  return (
    HDR_GAIN_MAP_LOG2_MIN +
    ((HDR_GAIN_MAP_LOG2_MAX - HDR_GAIN_MAP_LOG2_MIN) * code) / GAIN_MAP_CODE_MAX
  )
}

function srgbDecode(encoded: number) {
  return encoded <= 0.04045
    ? encoded / 12.92
    : Math.pow((encoded + 0.055) / 1.055, 2.4)
}

const SRGB_BYTE_TO_LINEAR = Float64Array.from({ length: 256 }, (_, code) =>
  srgbDecode(code / 255),
)

/** Clips to [0, peak]; a value that is not a number stays one for the gate. */
function clampHdr(value: number) {
  if (value > HDR_NOMINAL_PEAK_LINEAR) return HDR_NOMINAL_PEAK_LINEAR
  return value < 0 ? 0 : value
}

/**
 * Ratios that round to the neutral code, kept just inside half a step so the
 * shortcut agrees with the full computation at the edges.
 */
const NEUTRAL_RATIO_LOW = 2 ** (-0.499 * GAIN_STEP)
const NEUTRAL_RATIO_HIGH = 2 ** (0.499 * GAIN_STEP)

function encodeGain(hdr: number, base: number) {
  const ratio = (hdr + HDR_GAIN_MAP_OFFSET) / (base + HDR_GAIN_MAP_OFFSET)
  // Most of a photo sits inside the SDR range, where no log is needed.
  if (ratio > NEUTRAL_RATIO_LOW && ratio < NEUTRAL_RATIO_HIGH) {
    return HDR_GAIN_MAP_NEUTRAL_CODE
  }
  const gain = Math.log2(ratio)
  // The gate before compression: a gain outside the fixed range (or not a
  // number) cannot be recorded, and clamping it would change the rendition.
  if (
    !(
      gain >= HDR_GAIN_MAP_LOG2_MIN - GAIN_RANGE_TOLERANCE &&
      gain <= HDR_GAIN_MAP_LOG2_MAX + GAIN_RANGE_TOLERANCE
    )
  ) {
    throw new Error('HDR_GAIN_MAP_OUT_OF_RANGE')
  }
  const code = HDR_GAIN_MAP_NEUTRAL_CODE + Math.round(gain / GAIN_STEP)
  if (code < 0) return 0
  return code > GAIN_MAP_CODE_MAX ? GAIN_MAP_CODE_MAX : code
}

const [H0, H1, H2, H3, H4, H5, H6, H7, H8] = getGamutMatrix(
  'prophoto-rgb',
  HDR_GAIN_MAP_GAMUT,
)
const [B0, B1, B2, B3, B4, B5, B6, B7, B8] = getGamutMatrix(
  'srgb-rec709',
  HDR_GAIN_MAP_GAMUT,
)

/**
 * Gain map codes for rows whose scene values (linear ProPhoto: the scene the
 * look renders) and SDR bytes the graph already produced.
 */
export function encodeHdrGainMapRows(
  scene: Float32Array,
  sdr: Uint8Array,
  gainMap: Uint8Array,
  length: number,
): void {
  for (let index = 0; index < length; index += 3) {
    const sceneR = scene[index]
    const sceneG = scene[index + 1]
    const sceneB = scene[index + 2]
    const baseR = SRGB_BYTE_TO_LINEAR[sdr[index]]
    const baseG = SRGB_BYTE_TO_LINEAR[sdr[index + 1]]
    const baseB = SRGB_BYTE_TO_LINEAR[sdr[index + 2]]
    gainMap[index] = encodeGain(
      clampHdr(H0 * sceneR + H1 * sceneG + H2 * sceneB),
      B0 * baseR + B1 * baseG + B2 * baseB,
    )
    gainMap[index + 1] = encodeGain(
      clampHdr(H3 * sceneR + H4 * sceneG + H5 * sceneB),
      B3 * baseR + B4 * baseG + B5 * baseB,
    )
    gainMap[index + 2] = encodeGain(
      clampHdr(H6 * sceneR + H7 * sceneG + H8 * sceneB),
      B6 * baseR + B7 * baseG + B8 * baseB,
    )
  }
}
