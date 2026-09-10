import { LUT_SIZE } from './selective-color'

// Assumes LUMA_COLOR_OKLAB_WGSL is concatenated ahead of this string by the
// shader template so linearProPhotoToOklab / oklabToLinearProPhoto are in
// scope. The module-level binding `selectiveColorTexture` and the uniform
// `params.selectiveColorChromaClamp` are declared in the host shader.
// Identifiers and algorithm mirror applySelectiveColorRow (selective-color.ts)
// to preserve the CPU algorithm; GPU f32 precision is validated separately.
export const LUMA_COLOR_SELECTIVE_COLOR_WGSL = /* wgsl */ `
fn sampleSelectiveColorLut(hNorm: f32) -> vec4f {
  let x = fract(hNorm) * ${LUT_SIZE.toFixed(1)};
  let i0f = floor(x);
  let t = x - i0f;
  let i0 = u32(i0f);
  let i1 = (i0 + 1u) % ${LUT_SIZE}u;
  let a = textureLoad(selectiveColorTexture, vec2u(i0, 0u), 0);
  let b = textureLoad(selectiveColorTexture, vec2u(i1, 0u), 0);
  return mix(a, b, vec4f(t));
}

fn applyUserSelectiveColor(rgbProPhoto: vec3f) -> vec3f {
  let lab = linearProPhotoToOklab(rgbProPhoto);
  let L = lab.x;
  let a_val = lab.y;
  let b_val = lab.z;

  let C = sqrt(a_val * a_val + b_val * b_val);
  let h = atan2(b_val, a_val);
  let TWO_PI = 6.28318530717958647692;
  let hNorm = fract(h / TWO_PI + 1.0);

  let strength = smoothstep(params.selectiveColorChromaClamp.x, params.selectiveColorChromaClamp.y, C);
  let lutSample = sampleSelectiveColorLut(hNorm);

  let delta = strength * lutSample.r;
  let scale = mix(1.0, lutSample.g, strength);
  let addL = strength * lutSample.b;

  let cosD = cos(delta);
  let sinD = sin(delta);

  let aOut = (a_val * cosD - b_val * sinD) * scale;
  let bOut = (a_val * sinD + b_val * cosD) * scale;
  let LOut = L + addL;

  return oklabToLinearProPhoto(vec3f(LOut, aOut, bOut));
}
`
