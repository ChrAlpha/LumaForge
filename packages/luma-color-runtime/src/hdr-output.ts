import {
  HDR_NOMINAL_PEAK_LINEAR,
  HDR_NOMINAL_PEAK_NITS,
  HDR_REFERENCE_WHITE_NITS,
  HLG_SYSTEM_GAMMA,
} from './hdr-reference'
import type { HdrTransferFunctionId } from './log-encoding'
import {
  HLG_REFERENCE_WHITE_SCENE,
  hlgDecode,
  pqDecode,
  pqEncode,
} from './log-encoding'
import type { Mat3 } from './matrix'

/**
 * The light a LUT's HDR output signal (PQ or HLG) stands for, and the SDR
 * picture drawn from it.
 *
 * Display light is linear, with 1.0 at HDR Reference White, through the
 * BT.2100 EOTF of the reference display (the nominal peak, black at zero):
 * PQ is absolute, and HLG applies the reference display's OOTF to its scene
 * light, `L_W · Y_S^(γ - 1) · E` with γ the HLG system gamma. `Y_S` is the
 * luminance of that scene light, read in BT.709 weights after the LUT output
 * matrix carries it to sRGB primaries, so any declared output gamut weighs
 * its own primaries.
 *
 * The SDR picture maps that light onto SDR white with the ITU-R BT.2390
 * EETF: in PQ, from the nominal peak down to HDR Reference White (the SDR
 * export's white), applied to the largest of the three sRGB channels and
 * scaled into all three, so a color keeps its hue and saturation as it
 * rolls off. Light up to the knee (about 88 cd/m²) passes unchanged; light
 * at or above the nominal peak lands on SDR white.
 */

/** The SDR picture of an HDR LUT output. */
export const HDR_TO_SDR_TONE_MAP = 'bt2390-eetf-maxrgb' as const

/** HLG scene light at the reference display's peak, over reference white. */
const HLG_DISPLAY_SCALE = HDR_NOMINAL_PEAK_NITS / HDR_REFERENCE_WHITE_NITS

/** BT.709 luminance weights over linear sRGB. */
const LUMA_R = 0.2126
const LUMA_G = 0.7152
const LUMA_B = 0.0722

/** The nominal peak in PQ: the EETF's source white. */
const EETF_SOURCE_PEAK = pqEncode(HDR_NOMINAL_PEAK_LINEAR)

/** Reference white over the source range, both in PQ: the EETF's target. */
const EETF_TARGET_PEAK = pqEncode(1) / EETF_SOURCE_PEAK

/** Where the EETF's roll-off starts, over the source range in PQ. */
const EETF_KNEE = 1.5 * EETF_TARGET_PEAK - 0.5

/** The knee as display light: below it the SDR picture is the HDR one. */
export const HDR_TO_SDR_KNEE_LINEAR = pqDecode(EETF_KNEE * EETF_SOURCE_PEAK)

/** BT.2390 EETF of display light (1.0: reference white) onto SDR white. */
function eetf(linear: number) {
  const source = pqEncode(linear) / EETF_SOURCE_PEAK
  const e1 = source < 1 ? source : 1
  const t = (e1 - EETF_KNEE) / (1 - EETF_KNEE)
  const t2 = t * t
  const t3 = t2 * t
  const e2 =
    (2 * t3 - 3 * t2 + 1) * EETF_KNEE +
    (t3 - 2 * t2 + t) * (1 - EETF_KNEE) +
    (-2 * t3 + 3 * t2) * EETF_TARGET_PEAK
  return pqDecode(e2 * EETF_SOURCE_PEAK)
}

type MutableRgb = [number, number, number]

/**
 * Display light of an HDR signal, written to `out` in the LUT output gamut.
 * `toSrgb` is the LUT output matrix to linear sRGB, which the HLG OOTF
 * reads its luminance through.
 */
export type HdrDisplayLightDecoder = (
  encodedR: number,
  encodedG: number,
  encodedB: number,
  out: MutableRgb,
) => void

export function createHdrDisplayLightDecoder(
  transfer: HdrTransferFunctionId,
  toSrgb: Mat3,
): HdrDisplayLightDecoder {
  if (transfer === 'pq') {
    return (encodedR, encodedG, encodedB, out) => {
      out[0] = pqDecode(encodedR)
      out[1] = pqDecode(encodedG)
      out[2] = pqDecode(encodedB)
    }
  }
  const weightR = LUMA_R * toSrgb[0] + LUMA_G * toSrgb[3] + LUMA_B * toSrgb[6]
  const weightG = LUMA_R * toSrgb[1] + LUMA_G * toSrgb[4] + LUMA_B * toSrgb[7]
  const weightB = LUMA_R * toSrgb[2] + LUMA_G * toSrgb[5] + LUMA_B * toSrgb[8]
  return (encodedR, encodedG, encodedB, out) => {
    const sceneR = hlgDecode(encodedR) * HLG_REFERENCE_WHITE_SCENE
    const sceneG = hlgDecode(encodedG) * HLG_REFERENCE_WHITE_SCENE
    const sceneB = hlgDecode(encodedB) * HLG_REFERENCE_WHITE_SCENE
    const luminance = weightR * sceneR + weightG * sceneG + weightB * sceneB
    const scale =
      luminance > 0
        ? HLG_DISPLAY_SCALE * Math.pow(luminance, HLG_SYSTEM_GAMMA - 1)
        : 0
    out[0] = sceneR * scale
    out[1] = sceneG * scale
    out[2] = sceneB * scale
  }
}

/**
 * The SDR picture of display light in linear sRGB, each channel at or above
 * zero: `out` at or below SDR white, with the hue of the input.
 */
export function toneMapHdrToSdr(
  r: number,
  g: number,
  b: number,
  out: MutableRgb,
): MutableRgb {
  const peak = r > g ? (r > b ? r : b) : g > b ? g : b
  if (peak <= HDR_TO_SDR_KNEE_LINEAR) {
    out[0] = r
    out[1] = g
    out[2] = b
    return out
  }
  const scale = eetf(peak) / peak
  out[0] = r * scale
  out[1] = g * scale
  out[2] = b * scale
  return out
}

/**
 * The same display light and SDR picture for the WGSL preview. The host
 * supplies `decodeTransfer` and `encodeTransfer` (`LUMA_COLOR_TRANSFER_WGSL`).
 */
export const LUMA_COLOR_HDR_OUTPUT_WGSL = /* wgsl */ `
const HDR_OUTPUT_HLG_REFERENCE_WHITE_SCENE: f32 = ${HLG_REFERENCE_WHITE_SCENE};
const HDR_OUTPUT_HLG_DISPLAY_SCALE: f32 = ${HLG_DISPLAY_SCALE};
const HDR_OUTPUT_HLG_SYSTEM_GAMMA: f32 = ${HLG_SYSTEM_GAMMA};
const HDR_TO_SDR_SOURCE_PEAK: f32 = ${EETF_SOURCE_PEAK};
const HDR_TO_SDR_TARGET_PEAK: f32 = ${EETF_TARGET_PEAK};
const HDR_TO_SDR_KNEE: f32 = ${EETF_KNEE};
const HDR_TO_SDR_KNEE_LINEAR: f32 = ${HDR_TO_SDR_KNEE_LINEAR};

fn isHdrOutputTransfer(transfer: i32) -> bool {
  return transfer == TRANSFER_PQ || transfer == TRANSFER_HLG;
}

// Display light of an HDR signal in the LUT output gamut (1.0: reference
// white). The HLG OOTF reads luminance after toSrgb.
fn hdrSignalDisplayLight(encoded: vec3f, transfer: i32, toSrgb: mat3x3f) -> vec3f {
  if (transfer == TRANSFER_PQ) {
    return decodeTransfer(encoded, TRANSFER_PQ);
  }
  let scene = decodeTransfer(encoded, TRANSFER_HLG) * HDR_OUTPUT_HLG_REFERENCE_WHITE_SCENE;
  let luminance = dot(toSrgb * scene, vec3f(0.2126, 0.7152, 0.0722));
  if (luminance <= 0.0) {
    return vec3f(0.0);
  }
  return scene * (HDR_OUTPUT_HLG_DISPLAY_SCALE * pow(luminance, HDR_OUTPUT_HLG_SYSTEM_GAMMA - 1.0));
}

fn hdrToSdrEetf(linear: f32) -> f32 {
  let e1 = min(encodeTransferChannel(linear, TRANSFER_PQ) / HDR_TO_SDR_SOURCE_PEAK, 1.0);
  let t = (e1 - HDR_TO_SDR_KNEE) / (1.0 - HDR_TO_SDR_KNEE);
  let t2 = t * t;
  let t3 = t2 * t;
  let e2 =
    (2.0 * t3 - 3.0 * t2 + 1.0) * HDR_TO_SDR_KNEE +
    (t3 - 2.0 * t2 + t) * (1.0 - HDR_TO_SDR_KNEE) +
    (-2.0 * t3 + 3.0 * t2) * HDR_TO_SDR_TARGET_PEAK;
  return decodeTransferChannel(e2 * HDR_TO_SDR_SOURCE_PEAK, TRANSFER_PQ);
}

// The SDR picture of display light in linear sRGB at or above zero.
fn hdrToSdrDisplayLinear(displayLinear: vec3f) -> vec3f {
  let peak = max(max(displayLinear.r, displayLinear.g), displayLinear.b);
  if (peak <= HDR_TO_SDR_KNEE_LINEAR) {
    return displayLinear;
  }
  return displayLinear * (hdrToSdrEetf(peak) / peak);
}
`
