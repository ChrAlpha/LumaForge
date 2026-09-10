import {
  LUMA_COLOR_BALANCE_WGSL,
  LUMA_COLOR_LUT_WGSL,
  LUMA_COLOR_OKLAB_WGSL,
  LUMA_COLOR_RANGE_WGSL,
  LUMA_COLOR_SELECTIVE_COLOR_WGSL,
  LUMA_COLOR_TONE_WGSL,
  LUMA_COLOR_TRANSFER_WGSL,
  LUMA_COLOR_USER_SATURATION_WGSL,
} from '@lumaforge/luma-color-runtime/wgsl'

import type { ShaderSpecialization } from './specialization'
import { specializeProcessShader } from './specialization'

export const UNIFORM_BUFFER_STRUCT = /* wgsl */ `
struct ProcessUniforms {
  inputToLutGamut: mat3x3f,
  lutOutputToDisplayGamut: mat3x3f,

  lutDomainMin: vec3f,
  intensity: f32,
  lutDomainMax: vec3f,
  rawRenderExposureMultiplier: f32,
  userColorBalanceGain: vec3f,
  userExposureMultiplier: f32,

  userContrastAmount: f32,
  userContrastFactor: f32,
  userHighlights: f32,
  userShadows: f32,
  userWhites: f32,
  userBlacks: f32,
  userSaturation: f32,
  userVibrance: f32,
  compareSplit: f32,
  lutSize: f32,
  selectiveColorChromaClamp: vec2f,

  viewMode: i32,
  styleKind: i32,
  builtinPreset: i32,
  useLut: i32,
  lutInputTransfer: i32,
  lutOutputTransfer: i32,
  lutRole: i32,
  lutInputRange: i32,
  lutOutputRange: i32,
  selectiveColorActive: i32,
  _pad0: i32,
  _pad1: i32,
}
`

// One oversized triangle has no diagonal seam and needs no vertex buffer.
export const VERTEX_SHADER = /* wgsl */ `
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) texCoord: vec2f,
}
@vertex
fn main(@builtin(vertex_index) index: u32) -> VertexOutput {
  let uv = vec2f(f32((index << 1u) & 2u), f32(index & 2u));
  var out: VertexOutput;
  out.position = vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0);
  out.texCoord = uv;
  return out;
}
`

const PROCESS_FRAGMENT_HEADER = /* wgsl */ `
${UNIFORM_BUFFER_STRUCT}

@group(0) @binding(0) var<uniform> params: ProcessUniforms;
@group(1) @binding(0) var inputTexture: texture_2d<f32>;
@group(1) @binding(1) var inputSampler: sampler;
@group(2) @binding(0) var lutTexture: texture_3d<f32>;
@group(2) @binding(1) var lutSampler: sampler;
@group(3) @binding(0) var selectiveColorTexture: texture_2d<f32>;
`

const PROCESS_FRAGMENT_HEADER_U16 = /* wgsl */ `
${UNIFORM_BUFFER_STRUCT}

@group(0) @binding(0) var<uniform> params: ProcessUniforms;
@group(1) @binding(0) var inputTexture: texture_2d<u32>;
@group(1) @binding(1) var inputSampler: sampler;
@group(2) @binding(0) var lutTexture: texture_3d<f32>;
@group(2) @binding(1) var lutSampler: sampler;
@group(3) @binding(0) var selectiveColorTexture: texture_2d<f32>;
`

const PROCESS_FRAGMENT_BODY = /* wgsl */ `
const VIEW_MODE_PROCESSED: i32 = 0;
const VIEW_MODE_ORIGINAL: i32 = 1;
const VIEW_MODE_COMPARE: i32 = 2;
const STYLE_NONE: i32 = 0;
const STYLE_BUILTIN: i32 = 1;
const STYLE_CUSTOM: i32 = 2;

${LUMA_COLOR_TRANSFER_WGSL}
${LUMA_COLOR_RANGE_WGSL}
${LUMA_COLOR_LUT_WGSL}
${LUMA_COLOR_BALANCE_WGSL}
${LUMA_COLOR_TONE_WGSL}
${LUMA_COLOR_OKLAB_WGSL}
${LUMA_COLOR_SELECTIVE_COLOR_WGSL}
${LUMA_COLOR_USER_SATURATION_WGSL}

fn luminance709(color: vec3f) -> f32 {
  return dot(color, vec3f(0.2126, 0.7152, 0.0722));
}

fn adjustSaturationBuiltin(color: vec3f, amount: f32) -> vec3f {
  let luma = luminance709(color);
  return max(mix(vec3f(luma), color, amount), vec3f(0.0));
}

fn adjustContrastBuiltin(color: vec3f, amount: f32, pivot: f32) -> vec3f {
  return max((color - vec3f(pivot)) * amount + vec3f(pivot), vec3f(0.0));
}

fn applyWarmCool(color: vec3f, balance: vec3f) -> vec3f {
  return max(color * balance, vec3f(0.0));
}

fn applyBuiltinStyle(displayColor: vec3f) -> vec3f {
  var color = srgbToLinear(displayColor);
  if (params.builtinPreset == 1) {
    color = applyWarmCool(color, vec3f(1.07, 1.01, 0.94));
    color = adjustContrastBuiltin(color, 1.05, 0.18);
    color = adjustSaturationBuiltin(color, 1.06);
  } else if (params.builtinPreset == 2) {
    color = applyWarmCool(color, vec3f(0.94, 1.01, 1.09));
    color = adjustContrastBuiltin(color, 1.04, 0.18);
    color = adjustSaturationBuiltin(color, 1.04);
  } else if (params.builtinPreset == 3) {
    color = applyWarmCool(color, vec3f(1.03, 1.00, 0.98));
    color = adjustContrastBuiltin(color, 0.94, 0.18);
    color = adjustSaturationBuiltin(color, 0.95);
    color += vec3f(0.012) * (vec3f(1.0) - smoothstep(vec3f(0.0), vec3f(0.26), color));
  } else if (params.builtinPreset == 4) {
    color = adjustContrastBuiltin(color, 1.18, 0.18);
    color = adjustSaturationBuiltin(color, 1.08);
    color = pow(max(color, vec3f(0.0)), vec3f(0.96));
  } else if (params.builtinPreset == 5) {
    let luma = luminance709(color);
    let shadowTint = vec3f(0.93, 1.02, 1.10);
    let highlightTint = vec3f(1.08, 1.02, 0.94);
    color *= mix(shadowTint, highlightTint, smoothstep(0.18, 0.75, luma));
    color = adjustContrastBuiltin(color, 1.1, 0.18);
    color = adjustSaturationBuiltin(color, 0.92);
  } else if (params.builtinPreset == 6) {
    color = adjustContrastBuiltin(color, 0.86, 0.18);
    color = adjustSaturationBuiltin(color, 0.88);
    color = color * 0.94 + vec3f(0.026);
  } else if (params.builtinPreset == 7) {
    let luma = luminance709(color);
    color = vec3f(luma);
    color = adjustContrastBuiltin(color, 1.12, 0.18);
  } else {
    color = adjustContrastBuiltin(color, 1.02, 0.18);
    color = adjustSaturationBuiltin(color, 1.01);
  }
  return linearToSrgb(color);
}

fn processColor(technicalBaseSceneLinearProPhoto: vec3f, texCoord: vec2f) -> vec4f {
  let colorBalancedSceneLinearProPhoto = applyUserColorBalance(
    technicalBaseSceneLinearProPhoto,
    params.userColorBalanceGain
  );
  var editedBaseSceneLinearProPhoto = applyUserTone(
    colorBalancedSceneLinearProPhoto,
    params.userExposureMultiplier,
    params.userContrastAmount,
    params.userContrastFactor,
    params.userHighlights,
    params.userShadows,
    params.userWhites,
    params.userBlacks
  );
  editedBaseSceneLinearProPhoto = applyUserSaturation(
    editedBaseSceneLinearProPhoto,
    params.userSaturation,
    params.userVibrance
  );
  if (params.selectiveColorActive != 0) {
    editedBaseSceneLinearProPhoto = applyUserSelectiveColor(editedBaseSceneLinearProPhoto);
  }
  let technicalBaseDisplayLinear =
    max(linearProPhotoToLinearSrgb(technicalBaseSceneLinearProPhoto), vec3f(0.0));
  let editedBaseDisplayLinear =
    max(linearProPhotoToLinearSrgb(editedBaseSceneLinearProPhoto), vec3f(0.0));
  let technicalBaseDisplayColor = linearToSrgb(technicalBaseDisplayLinear);
  let editedBaseDisplayColor = linearToSrgb(editedBaseDisplayLinear);
  var styledColor = editedBaseDisplayColor;
  let intensity = clamp(params.intensity, 0.0, 1.0);

  if (params.styleKind == STYLE_BUILTIN) {
    styledColor = mix(editedBaseDisplayColor, applyBuiltinStyle(editedBaseDisplayColor), intensity);
  } else if (params.styleKind == STYLE_CUSTOM && params.useLut != 0) {
    if (isSceneCreativeLut()) {
      let styledDisplayLinear = applySceneLutToDisplayLinear(editedBaseSceneLinearProPhoto);
      let mixedDisplayLinear = mix(editedBaseDisplayLinear, styledDisplayLinear, intensity);
      styledColor = linearToSrgb(mixedDisplayLinear);
    } else if (isOutputLut()) {
      styledColor = mix(editedBaseDisplayColor, applyCombinedOutputLut(editedBaseSceneLinearProPhoto), intensity);
    } else {
      styledColor = mix(editedBaseDisplayColor, applyDisplayLut(editedBaseSceneLinearProPhoto), intensity);
    }
  }

  if (params.viewMode == VIEW_MODE_ORIGINAL) {
    styledColor = technicalBaseDisplayColor;
  } else if (params.viewMode == VIEW_MODE_COMPARE) {
    let finalSide = step(clamp(params.compareSplit, 0.0, 1.0), texCoord.x);
    styledColor = mix(technicalBaseDisplayColor, styledColor, finalSide);
  }

  return vec4f(clamp01v(styledColor), 1.0);
}
`

export const PROCESS_FRAGMENT_SHADER_FLOAT = /* wgsl */ `
${PROCESS_FRAGMENT_HEADER}

fn linearProPhotoToLinearSrgb(color: vec3f) -> vec3f {
  return color;
}

fn readInputSceneLinearProPhoto(uv: vec2f) -> vec3f {
  return srgbToLinear(textureSampleLevel(inputTexture, inputSampler, uv, 0.0).rgb);
}

${PROCESS_FRAGMENT_BODY}

@fragment
fn main(@location(0) texCoord: vec2f) -> @location(0) vec4f {
  let sceneLinear = readInputSceneLinearProPhoto(texCoord) * params.rawRenderExposureMultiplier;
  return processColor(sceneLinear, texCoord);
}
`

export const PROCESS_FRAGMENT_SHADER_U16 = /* wgsl */ `
${PROCESS_FRAGMENT_HEADER_U16}

fn linearProPhotoToLinearSrgb(color: vec3f) -> vec3f {
  return vec3f(
    dot(color, vec3f(2.034367543, -0.727634474, -0.306733069)),
    dot(color, vec3f(-0.228826798, 1.231753396, -0.002926598)),
    dot(color, vec3f(-0.008558424, -0.153268204, 1.161826628))
  );
}

fn readInputSceneLinearProPhoto(uv: vec2f) -> vec3f {
  let dims = textureDimensions(inputTexture);
  let coord = vec2u(
    min(u32(uv.x * f32(dims.x)), dims.x - 1u),
    min(u32(uv.y * f32(dims.y)), dims.y - 1u)
  );
  let color = textureLoad(inputTexture, coord, 0);
  return vec3f(f32(color.r), f32(color.g), f32(color.b)) / 65535.0;
}

${PROCESS_FRAGMENT_BODY}

@fragment
fn main(@location(0) texCoord: vec2f) -> @location(0) vec4f {
  let sceneLinear = readInputSceneLinearProPhoto(texCoord) * params.rawRenderExposureMultiplier;
  return processColor(sceneLinear, texCoord);
}
`

export const PREVIEW_OUTPUT_SHADER = /* wgsl */ `
@group(0) @binding(0) var processedTexture: texture_2d<f32>;
@group(0) @binding(1) var processedSampler: sampler;

@fragment
fn main(@location(0) texCoord: vec2f) -> @location(0) vec4f {
  let color = textureSampleLevel(processedTexture, processedSampler, texCoord, 0.0).rgb;
  return vec4f(clamp(color, vec3f(0.0), vec3f(1.0)), 1.0);
}
`

export const PASSTHROUGH_FRAGMENT_SHADER = /* wgsl */ `
@group(0) @binding(0) var inputTex: texture_2d<f32>;
@group(0) @binding(1) var inputSamp: sampler;

@fragment
fn main(@location(0) texCoord: vec2f) -> @location(0) vec4f {
  return textureSampleLevel(inputTex, inputSamp, texCoord, 0.0);
}
`

export const EXPORT_FRAGMENT_SHADER = PASSTHROUGH_FRAGMENT_SHADER

// float32-filterable is optional. Keep full-float LUT precision on baseline
// devices with explicit trilinear interpolation rather than quantizing to FP16.
const UNFILTERABLE_LUT = /* wgsl */ `
fn sampleUnfilterableLut(color: vec3f) -> vec3f {
  let last = vec3i(textureDimensions(lutTexture)) - vec3i(1);
  let p = clamp(color, vec3f(0.0), vec3f(1.0)) * vec3f(last);
  let lo = vec3i(floor(p));
  let hi = min(lo + vec3i(1), last);
  let f = fract(p);
  let c00 = mix(textureLoad(lutTexture, lo, 0).rgb,
    textureLoad(lutTexture, vec3i(hi.x, lo.y, lo.z), 0).rgb, f.x);
  let c10 = mix(textureLoad(lutTexture, vec3i(lo.x, hi.y, lo.z), 0).rgb,
    textureLoad(lutTexture, vec3i(hi.x, hi.y, lo.z), 0).rgb, f.x);
  let c01 = mix(textureLoad(lutTexture, vec3i(lo.x, lo.y, hi.z), 0).rgb,
    textureLoad(lutTexture, vec3i(hi.x, lo.y, hi.z), 0).rgb, f.x);
  let c11 = mix(textureLoad(lutTexture, vec3i(lo.x, hi.y, hi.z), 0).rgb,
    textureLoad(lutTexture, hi, 0).rgb, f.x);
  return mix(mix(c00, c10, f.y), mix(c01, c11, f.y), f.z);
}
`

export function createProcessShader(
  integerInput: boolean,
  filterable: boolean,
  specialization?: ShaderSpecialization,
) {
  let code = integerInput
    ? PROCESS_FRAGMENT_SHADER_U16
    : PROCESS_FRAGMENT_SHADER_FLOAT
  // Processing is exactly one fragment per input texel. Filtering is performed
  // only by the output pass, after the complete color pipeline.
  if (!integerInput)
    code = code.replace(
      'textureSampleLevel(inputTexture, inputSampler, uv, 0.0)',
      'textureLoad(inputTexture, clamp(vec2i(uv * vec2f(textureDimensions(inputTexture))), vec2i(0), vec2i(textureDimensions(inputTexture)) - vec2i(1)), 0)',
    )
  if (!filterable)
    code =
      UNFILTERABLE_LUT +
      code.replace(
        'textureSampleLevel(lutTexture, lutSampler, lutTextureCoordinate(normalizedColor), 0.0).rgb',
        'sampleUnfilterableLut(normalizedColor)',
      )
  return specialization ? specializeProcessShader(code, specialization) : code
}
