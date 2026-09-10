import {
  SKIN_HUE_CENTER_DEG,
  SKIN_HUE_SIGMA_DEG,
  SKIN_PROTECT_STRENGTH,
  USER_SATURATION_MAX_FACTOR,
  USER_VIBRANCE_MAX_FACTOR,
  VIBRANCE_CHROMA_REF,
} from './saturation'

export const LUMA_COLOR_USER_SATURATION_WGSL = /* wgsl */ `
const USER_SAT_MAX: f32 = ${USER_SATURATION_MAX_FACTOR.toFixed(6)};
const USER_VIB_MAX: f32 = ${USER_VIBRANCE_MAX_FACTOR.toFixed(6)};
const VIBRANCE_CHROMA_REF_K: f32 = ${VIBRANCE_CHROMA_REF.toFixed(6)};
const SKIN_HUE_CENTER: f32 = ${SKIN_HUE_CENTER_DEG.toFixed(6)};
const SKIN_HUE_SIGMA: f32 = ${SKIN_HUE_SIGMA_DEG.toFixed(6)};
const SKIN_PROTECT_STR: f32 = ${SKIN_PROTECT_STRENGTH.toFixed(6)};

fn applyUserSaturation(colorProPhoto: vec3f, saturation: f32, vibrance: f32) -> vec3f {
  if (saturation == 0.0 && vibrance == 0.0) {
    return colorProPhoto;
  }
  let oklab = linearProPhotoToOklab(colorProPhoto);
  let L = oklab.x;
  let ab = oklab.yz;
  let C = length(ab);

  let gC_boost = clamp((VIBRANCE_CHROMA_REF_K - C) / VIBRANCE_CHROMA_REF_K, 0.0, 1.0);
  let gC_cut   = clamp(C / VIBRANCE_CHROMA_REF_K, 0.0, 1.0);
  let gC       = select(gC_cut, gC_boost, vibrance >= 0.0);

  let RAD_TO_DEG = 180.0 / 3.14159265358979323846;
  let hueDeg   = atan2(ab.y, ab.x) * RAD_TO_DEG;
  let rawDelta = hueDeg - SKIN_HUE_CENTER + 540.0;
  let deltaHue = rawDelta - floor(rawDelta / 360.0) * 360.0 - 180.0;
  let t        = deltaHue / SKIN_HUE_SIGMA;
  let gSkin    = 1.0 - SKIN_PROTECT_STR * exp(-t * t);

  let satFactor    = clamp(1.0 + (saturation / 100.0) * USER_SAT_MAX, 0.0, 2.0);
  let vibFactor    = 1.0 + (vibrance / 100.0) * USER_VIB_MAX * gC * gSkin;
  let chromaFactor = max(0.0, satFactor * vibFactor);

  return oklabToLinearProPhoto(vec3f(L, ab * chromaFactor));
}
`
