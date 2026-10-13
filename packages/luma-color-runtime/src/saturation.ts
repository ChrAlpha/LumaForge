import { linearProPhotoToOklab, oklabToLinearProPhoto } from './oklab'

export interface LumaColorSaturationParams {
  readonly userSaturation: number
  readonly userVibrance: number
}

export const USER_SATURATION_MIN = -100
export const USER_SATURATION_MAX = 100
export const USER_VIBRANCE_MIN = -100
export const USER_VIBRANCE_MAX = 100

export const USER_SATURATION_MAX_FACTOR = 1.0
export const USER_VIBRANCE_MAX_FACTOR = 0.5
export const VIBRANCE_CHROMA_REF = 0.25
export const SKIN_HUE_CENTER_DEG = 50
export const SKIN_HUE_SIGMA_DEG = 20
export const SKIN_PROTECT_STRENGTH = 0.5

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

function finiteOrDefault(value: unknown, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export function normalizeSaturationParams(
  input?: Partial<LumaColorSaturationParams> | null,
): LumaColorSaturationParams {
  return {
    userSaturation: clamp(
      finiteOrDefault(input?.userSaturation, 0),
      USER_SATURATION_MIN,
      USER_SATURATION_MAX,
    ),
    userVibrance: clamp(
      finiteOrDefault(input?.userVibrance, 0),
      USER_VIBRANCE_MIN,
      USER_VIBRANCE_MAX,
    ),
  }
}

const RAD_TO_DEG = 180 / Math.PI

function wrapHueDeg(h: number): number {
  return (((h % 360) + 540) % 360) - 180
}

const oklabScratch = new Float32Array(3)
const rgbScratch = new Float32Array(3)

export function applyUserSaturationTo(
  scratch: Float32Array,
  offset: number,
  saturation: number,
  vibrance: number,
): void {
  if (saturation === 0 && vibrance === 0) return

  rgbScratch[0] = scratch[offset]
  rgbScratch[1] = scratch[offset + 1]
  rgbScratch[2] = scratch[offset + 2]

  linearProPhotoToOklab(rgbScratch, oklabScratch)
  const L = oklabScratch[0]
  const a = oklabScratch[1]
  const b = oklabScratch[2]
  const C = Math.sqrt(a * a + b * b)

  const gC_boost = Math.min(
    1,
    Math.max(0, (VIBRANCE_CHROMA_REF - C) / VIBRANCE_CHROMA_REF),
  )
  const gC_cut = Math.min(1, Math.max(0, C / VIBRANCE_CHROMA_REF))
  const gC = vibrance >= 0 ? gC_boost : gC_cut

  const hueDeg = Math.atan2(b, a) * RAD_TO_DEG
  const deltaHue = wrapHueDeg(hueDeg - SKIN_HUE_CENTER_DEG)
  const t = deltaHue / SKIN_HUE_SIGMA_DEG
  const gSkin = 1 - SKIN_PROTECT_STRENGTH * Math.exp(-t * t)

  const satFactor = Math.min(
    2,
    Math.max(0, 1 + (saturation / 100) * USER_SATURATION_MAX_FACTOR),
  )
  const vibFactor = 1 + (vibrance / 100) * USER_VIBRANCE_MAX_FACTOR * gC * gSkin
  const chromaFactor = Math.max(0, satFactor * vibFactor)

  oklabScratch[0] = L
  oklabScratch[1] = a * chromaFactor
  oklabScratch[2] = b * chromaFactor

  oklabToLinearProPhoto(oklabScratch, rgbScratch)
  scratch[offset] = rgbScratch[0]
  scratch[offset + 1] = rgbScratch[1]
  scratch[offset + 2] = rgbScratch[2]
}
