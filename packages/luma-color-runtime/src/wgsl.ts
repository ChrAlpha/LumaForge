import {
  LINEAR_PROPHOTO_LUMINANCE,
  USER_CONTRAST_PIVOT,
  USER_REGIONAL_TONE_PIVOT,
} from './tone'

export { LUMA_COLOR_OKLAB_WGSL } from './oklab-wgsl'
export { LUMA_COLOR_USER_SATURATION_WGSL } from './saturation-wgsl'
export { LUMA_COLOR_SELECTIVE_COLOR_WGSL } from './selective-color-wgsl'
export {
  LUT_RANGE_UNIFORMS,
  LUT_ROLE_UNIFORMS,
  LUT_TRANSFER_UNIFORMS,
} from './shader-uniforms'
export { LUMA_COLOR_TRANSFER_WGSL } from './transfer-wgsl'

// Host shader ABI: `params` supplies LUT size/domain/role/range/transfer values,
// gamut matrices and selective-color chroma clamps. `lutTexture`/`lutSampler`
// bind the 3D LUT; `linearProPhotoToLinearSrgb` is supplied by the host.
export const LUMA_COLOR_RANGE_WGSL = /* wgsl */ `
const LUT_RANGE_FULL: i32 = 0;
const LUT_RANGE_LEGAL: i32 = 1;
const LUT_RANGE_UNKNOWN: i32 = 2;

fn applySignalRangeForLutInput(color: vec3f, range: i32) -> vec3f {
  if (range == LUT_RANGE_LEGAL) {
    return color * ((940.0 - 64.0) / 1023.0) + vec3f(64.0 / 1023.0);
  }
  return color;
}

fn removeSignalRangeFromLutOutput(color: vec3f, range: i32) -> vec3f {
  if (range == LUT_RANGE_LEGAL) {
    return (color - vec3f(64.0 / 1023.0)) * (1023.0 / (940.0 - 64.0));
  }
  return color;
}
`

export const LUMA_COLOR_BALANCE_WGSL = /* wgsl */ `
fn applyUserColorBalance(color: vec3f, gain: vec3f) -> vec3f {
  return color * gain;
}
`

export const LUMA_COLOR_LUT_WGSL = /* wgsl */ `
const LUT_ROLE_DISPLAY_LOOK: i32 = 0;
const LUT_ROLE_SCENE_CREATIVE: i32 = 1;
const LUT_ROLE_COMBINED_LOOK_OUTPUT: i32 = 2;
const LUT_ROLE_TECHNICAL_OUTPUT: i32 = 3;

fn isSceneCreativeLut() -> bool {
  return params.lutRole == LUT_ROLE_SCENE_CREATIVE;
}

fn isOutputLut() -> bool {
  return params.lutRole == LUT_ROLE_COMBINED_LOOK_OUTPUT || params.lutRole == LUT_ROLE_TECHNICAL_OUTPUT;
}

fn normalizeLutInputChannel(value: f32, domainMin: f32, domainMax: f32) -> f32 {
  let span = domainMax - domainMin;
  if (value != value || span != span || abs(value) > 3.4e38 || abs(span) > 3.4e38 || span <= 0.0) {
    return 0.0;
  }
  return max((value - domainMin) / span, 0.0);
}

fn lutTextureCoordinate(normalizedColor: vec3f) -> vec3f {
  let size = max(params.lutSize, 1.0);
  return (normalizedColor * (size - 1.0) + vec3f(0.5)) / size;
}

fn compressLutInputToDomain(color: vec3f) -> vec3f {
  let normalizedColor = vec3f(
    normalizeLutInputChannel(color.r, params.lutDomainMin.r, params.lutDomainMax.r),
    normalizeLutInputChannel(color.g, params.lutDomainMin.g, params.lutDomainMax.g),
    normalizeLutInputChannel(color.b, params.lutDomainMin.b, params.lutDomainMax.b)
  );
  let peak = max(max(normalizedColor.r, normalizedColor.g), normalizedColor.b);
  // Keep both black and in-domain pixels finite without an eager 1 / 0.
  let scale = 1.0 / max(peak, 1.0);
  let compressedColor = normalizedColor * scale;
  return params.lutDomainMin + compressedColor * (params.lutDomainMax - params.lutDomainMin);
}

fn applyLut(color: vec3f) -> vec3f {
  let domainColor = compressLutInputToDomain(color);
  var normalizedColor = vec3f(
    normalizeLutInputChannel(domainColor.r, params.lutDomainMin.r, params.lutDomainMax.r),
    normalizeLutInputChannel(domainColor.g, params.lutDomainMin.g, params.lutDomainMax.g),
    normalizeLutInputChannel(domainColor.b, params.lutDomainMin.b, params.lutDomainMax.b)
  );
  normalizedColor = clamp(normalizedColor, vec3f(0.0), vec3f(1.0));
  return textureSampleLevel(lutTexture, lutSampler, lutTextureCoordinate(normalizedColor), 0.0).rgb;
}

fn applyDisplayLut(sceneLinearProPhoto: vec3f) -> vec3f {
  let displayLinear = max(linearProPhotoToLinearSrgb(sceneLinearProPhoto), vec3f(0.0));
  let lutInputEncoded = encodeTransfer(displayLinear, params.lutInputTransfer);
  let lutInput = applySignalRangeForLutInput(lutInputEncoded, params.lutInputRange);
  let lutOutputEncoded = removeSignalRangeFromLutOutput(applyLut(lutInput), params.lutOutputRange);
  let displayLinearOutput = decodeTransfer(lutOutputEncoded, params.lutOutputTransfer);
  return linearToSrgb(displayLinearOutput);
}

fn applySceneLutToDisplayLinear(sceneLinearProPhoto: vec3f) -> vec3f {
  let lutInputLinear = params.inputToLutGamut * sceneLinearProPhoto;
  let lutInputEncoded = applySignalRangeForLutInput(encodeTransfer(lutInputLinear, params.lutInputTransfer), params.lutInputRange);
  let lutOutputEncoded = removeSignalRangeFromLutOutput(applyLut(lutInputEncoded), params.lutOutputRange);
  let lutOutputLinear = decodeTransfer(lutOutputEncoded, params.lutOutputTransfer);
  return max(params.lutOutputToDisplayGamut * lutOutputLinear, vec3f(0.0));
}

fn applyCombinedOutputLut(sceneLinearProPhoto: vec3f) -> vec3f {
  let lutInputLinear = params.inputToLutGamut * sceneLinearProPhoto;
  let lutInputEncoded = applySignalRangeForLutInput(encodeTransfer(lutInputLinear, params.lutInputTransfer), params.lutInputRange);
  let lutOutputEncoded = removeSignalRangeFromLutOutput(applyLut(lutInputEncoded), params.lutOutputRange);
  let displayLinear = max(params.lutOutputToDisplayGamut * decodeTransfer(lutOutputEncoded, params.lutOutputTransfer), vec3f(0.0));
  return linearToSrgb(displayLinear);
}
`

export const LUMA_COLOR_TONE_WGSL = /* wgsl */ `
const LINEAR_PROPHOTO_LUMINANCE: vec3f = vec3f(${LINEAR_PROPHOTO_LUMINANCE.join(', ')});
const USER_CONTRAST_PIVOT: f32 = ${USER_CONTRAST_PIVOT};
const USER_REGIONAL_TONE_PIVOT: f32 = ${USER_REGIONAL_TONE_PIVOT};

fn applyUserExposure(sceneLinear: vec3f, exposureMultiplier: f32) -> vec3f {
  return sceneLinear * exposureMultiplier;
}

fn applyUserContrast(exposedSceneLinear: vec3f, contrastAmount: f32, contrastFactor: f32) -> vec3f {
  if (contrastAmount == 0.0) {
    return exposedSceneLinear;
  }
  let contrastInput = max(exposedSceneLinear, vec3f(0.0));
  let y = dot(contrastInput, LINEAR_PROPHOTO_LUMINANCE);
  if (y <= 0.0) {
    return vec3f(0.0);
  }
  let targetY = USER_CONTRAST_PIVOT * pow(y / USER_CONTRAST_PIVOT, contrastFactor);
  return contrastInput * (targetY / y);
}

fn regionalAmountToEv(amount: f32, maxAbsEv: f32) -> f32 {
  return (amount / 100.0) * maxAbsEv;
}

fn regionalToneEvFromLuminance(luminance: f32, highlights: f32, shadows: f32, whites: f32, blacks: f32) -> f32 {
  if (highlights == 0.0 && shadows == 0.0 && whites == 0.0 && blacks == 0.0) {
    return 0.0;
  }
  if (luminance <= 0.0) {
    return 0.0;
  }
  let logLuminance = log2(luminance / USER_REGIONAL_TONE_PIVOT);
  let highlightsMask = smoothstep(-1.0, 3.0, logLuminance);
  let shadowsMask = 1.0 - smoothstep(-4.0, 1.0, logLuminance);
  let whitesMask = smoothstep(2.0, 5.5, logLuminance);
  let blacksMask = 1.0 - smoothstep(-8.0, -3.0, logLuminance);
  return
    highlightsMask * regionalAmountToEv(highlights, 1.25) +
    shadowsMask * regionalAmountToEv(shadows, 1.25) +
    whitesMask * regionalAmountToEv(whites, 1.0) +
    blacksMask * regionalAmountToEv(blacks, 1.0);
}

fn applyUserRegionalTone(contrastedSceneLinear: vec3f, highlights: f32, shadows: f32, whites: f32, blacks: f32) -> vec3f {
  if (highlights == 0.0 && shadows == 0.0 && whites == 0.0 && blacks == 0.0) {
    return contrastedSceneLinear;
  }
  let regionalInput = max(contrastedSceneLinear, vec3f(0.0));
  let y = dot(regionalInput, LINEAR_PROPHOTO_LUMINANCE);
  if (y <= 0.0) {
    return vec3f(0.0);
  }
  let ev = regionalToneEvFromLuminance(y, highlights, shadows, whites, blacks);
  return regionalInput * exp2(ev);
}

fn applyUserTone(sceneLinear: vec3f, exposureMultiplier: f32, contrastAmount: f32, contrastFactor: f32, highlights: f32, shadows: f32, whites: f32, blacks: f32) -> vec3f {
  return applyUserRegionalTone(
    applyUserContrast(
      applyUserExposure(sceneLinear, exposureMultiplier),
      contrastAmount,
      contrastFactor
    ),
    highlights,
    shadows,
    whites,
    blacks
  );
}
`
