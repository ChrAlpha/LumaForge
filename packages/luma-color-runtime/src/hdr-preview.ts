import { HDR_GAIN_MAP_GAMUT } from './hdr-gain-map'
import { HDR_NOMINAL_PEAK_LINEAR } from './hdr-reference'
import { getGamutMatrix } from './matrix'

/**
 * What a preview shows of the HDR rendition a gain-map export carries, on a
 * display of any range. Each view is drawn from the scene values the gain
 * map is computed from (linear ProPhoto: the scene the look renders), through the
 * same clip to the nominal peak in BT.2020, so it shows what the export
 * records rather than an estimate of it.
 *
 * - `above-sdr`: the SDR picture as dim gray, with every pixel the HDR
 *   rendition lifts above SDR white tinted from amber, just above white, to
 *   magenta at the nominal peak.
 * - `stop-down`: the HDR rendition divided by the nominal peak, so its peak
 *   lands on SDR white and the highlights the SDR picture clips show their
 *   detail.
 */
export const HDR_PREVIEW_VIEWS = ['above-sdr', 'stop-down'] as const

export type HdrPreviewView = (typeof HDR_PREVIEW_VIEWS)[number]

/** How bright the SDR picture stays under the above-SDR tint. */
export const HDR_ABOVE_SDR_BASE_SCALE = 0.35

/** Stops above SDR white over which the tint fades in, so it has no edge. */
export const HDR_ABOVE_SDR_FADE_STOPS = 0.25

/** Linear sRGB tint just above SDR white (amber). */
export const HDR_ABOVE_SDR_LOW_TINT = [1, 0.6, 0.04] as const

/** Linear sRGB tint at the nominal peak (magenta). */
export const HDR_ABOVE_SDR_HIGH_TINT = [0.82, 0.04, 0.6] as const

const LOG2_PEAK = Math.log2(HDR_NOMINAL_PEAK_LINEAR)

const [H0, H1, H2, H3, H4, H5, H6, H7, H8] = getGamutMatrix(
  'prophoto-rgb',
  HDR_GAIN_MAP_GAMUT,
)
const [D0, D1, D2, D3, D4, D5, D6, D7, D8] = getGamutMatrix(
  HDR_GAIN_MAP_GAMUT,
  'srgb-rec709',
)

/** BT.709 luminance weights over linear sRGB. */
const LUMA_R = 0.2126
const LUMA_G = 0.7152
const LUMA_B = 0.0722

function clampHdr(value: number) {
  if (value > HDR_NOMINAL_PEAK_LINEAR) return HDR_NOMINAL_PEAK_LINEAR
  return value > 0 ? value : 0
}

function clamp01(value: number) {
  if (value > 1) return 1
  return value > 0 ? value : 0
}

function srgbDecode(encoded: number) {
  return encoded <= 0.04045
    ? encoded / 12.92
    : Math.pow((encoded + 0.055) / 1.055, 2.4)
}

const SRGB_BYTE_TO_LINEAR = Float64Array.from({ length: 256 }, (_, code) =>
  srgbDecode(code / 255),
)

function toSrgbByte(linear: number) {
  const value = clamp01(linear)
  const encoded =
    value <= 0.0031308
      ? value * 12.92
      : 1.055 * Math.pow(value, 1 / 2.4) - 0.055
  return Math.round(encoded * 255)
}

/**
 * Preview bytes (sRGB, three per pixel) for rows whose look scene values and
 * SDR bytes the graph already produced. `scene` and `sdr` hold `length`
 * values; `out` receives as many.
 */
export function encodeHdrPreviewRows(
  scene: Float32Array,
  sdr: Uint8Array,
  view: HdrPreviewView,
  out: Uint8Array,
  length: number,
): void {
  const [lowR, lowG, lowB] = HDR_ABOVE_SDR_LOW_TINT
  const [highR, highG, highB] = HDR_ABOVE_SDR_HIGH_TINT
  for (let index = 0; index < length; index += 3) {
    const sceneR = scene[index]
    const sceneG = scene[index + 1]
    const sceneB = scene[index + 2]
    const hdrR = clampHdr(H0 * sceneR + H1 * sceneG + H2 * sceneB)
    const hdrG = clampHdr(H3 * sceneR + H4 * sceneG + H5 * sceneB)
    const hdrB = clampHdr(H6 * sceneR + H7 * sceneG + H8 * sceneB)

    if (view === 'stop-down') {
      out[index] = toSrgbByte(
        (D0 * hdrR + D1 * hdrG + D2 * hdrB) / HDR_NOMINAL_PEAK_LINEAR,
      )
      out[index + 1] = toSrgbByte(
        (D3 * hdrR + D4 * hdrG + D5 * hdrB) / HDR_NOMINAL_PEAK_LINEAR,
      )
      out[index + 2] = toSrgbByte(
        (D6 * hdrR + D7 * hdrG + D8 * hdrB) / HDR_NOMINAL_PEAK_LINEAR,
      )
      continue
    }

    const peak = Math.max(hdrR, hdrG, hdrB)
    const stops = peak > 1 ? Math.log2(peak) : 0
    const toward = clamp01(stops / LOG2_PEAK)
    const weight = clamp01(stops / HDR_ABOVE_SDR_FADE_STOPS)
    const gray =
      HDR_ABOVE_SDR_BASE_SCALE *
      (LUMA_R * SRGB_BYTE_TO_LINEAR[sdr[index]] +
        LUMA_G * SRGB_BYTE_TO_LINEAR[sdr[index + 1]] +
        LUMA_B * SRGB_BYTE_TO_LINEAR[sdr[index + 2]])
    out[index] = toSrgbByte(
      gray + (lowR + (highR - lowR) * toward - gray) * weight,
    )
    out[index + 1] = toSrgbByte(
      gray + (lowG + (highG - lowG) * toward - gray) * weight,
    )
    out[index + 2] = toSrgbByte(
      gray + (lowB + (highB - lowB) * toward - gray) * weight,
    )
  }
}

const wgslMatrix = (matrix: ArrayLike<number>) =>
  `mat3x3f(${[0, 3, 6, 1, 4, 7, 2, 5, 8].map((index) => matrix[index]).join(', ')})`

/**
 * The same views for the WGSL preview, plus the HDR rendition as extended
 * linear sRGB for a display that shows values above SDR white. The host
 * supplies the scene the look renders and the SDR picture as linear sRGB.
 */
export const LUMA_COLOR_HDR_PREVIEW_WGSL = /* wgsl */ `
const HDR_NOMINAL_PEAK: f32 = ${HDR_NOMINAL_PEAK_LINEAR};
const HDR_LOG2_PEAK: f32 = ${LOG2_PEAK};
const HDR_PROPHOTO_TO_REC2020: mat3x3f = ${wgslMatrix(getGamutMatrix('prophoto-rgb', HDR_GAIN_MAP_GAMUT))};
const HDR_REC2020_TO_SRGB: mat3x3f = ${wgslMatrix(getGamutMatrix(HDR_GAIN_MAP_GAMUT, 'srgb-rec709'))};
const HDR_ABOVE_SDR_BASE_SCALE: f32 = ${HDR_ABOVE_SDR_BASE_SCALE};
const HDR_ABOVE_SDR_FADE_STOPS: f32 = ${HDR_ABOVE_SDR_FADE_STOPS};
const HDR_ABOVE_SDR_LOW_TINT: vec3f = vec3f(${HDR_ABOVE_SDR_LOW_TINT.join(', ')});
const HDR_ABOVE_SDR_HIGH_TINT: vec3f = vec3f(${HDR_ABOVE_SDR_HIGH_TINT.join(', ')});

const HDR_SRGB_TO_PROPHOTO: mat3x3f = ${wgslMatrix(getGamutMatrix('srgb-rec709', 'prophoto-rgb'))};

// The scene a LUT look with an HDR rendition renders: the edited scene mixed
// by the look strength with the LUT's light (sRGB primaries, unclamped).
fn hdrLutLookSceneLinearProPhoto(editedScene: vec3f, lutOutputDisplayLinear: vec3f, intensity: f32) -> vec3f {
  return mix(editedScene, HDR_SRGB_TO_PROPHOTO * lutOutputDisplayLinear, intensity);
}

fn hdrRenditionRec2020(scene: vec3f) -> vec3f {
  return clamp(HDR_PROPHOTO_TO_REC2020 * scene, vec3f(0.0), vec3f(HDR_NOMINAL_PEAK));
}

fn hdrRenditionDisplayLinear(scene: vec3f) -> vec3f {
  return HDR_REC2020_TO_SRGB * hdrRenditionRec2020(scene);
}

fn hdrStopDownDisplayLinear(scene: vec3f) -> vec3f {
  return hdrRenditionDisplayLinear(scene) / HDR_NOMINAL_PEAK;
}

fn hdrAboveSdrDisplayLinear(scene: vec3f, sdrDisplayLinear: vec3f) -> vec3f {
  let hdr = hdrRenditionRec2020(scene);
  let peak = max(max(hdr.r, hdr.g), hdr.b);
  let stops = select(0.0, log2(peak), peak > 1.0);
  let toward = clamp(stops / HDR_LOG2_PEAK, 0.0, 1.0);
  let weight = clamp(stops / HDR_ABOVE_SDR_FADE_STOPS, 0.0, 1.0);
  let sdr = clamp(sdrDisplayLinear, vec3f(0.0), vec3f(1.0));
  let gray = HDR_ABOVE_SDR_BASE_SCALE * dot(sdr, vec3f(0.2126, 0.7152, 0.0722));
  let tint = mix(HDR_ABOVE_SDR_LOW_TINT, HDR_ABOVE_SDR_HIGH_TINT, toward);
  return mix(vec3f(gray), tint, weight);
}
`
