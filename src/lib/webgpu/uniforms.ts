import type {
  BuiltinStylePreset,
  LUTData,
  ProcessingParams,
} from '@lumaforge/luma-color-runtime'
import {
  CHROMA_CLAMP_HIGH,
  CHROMA_CLAMP_LOW,
  pickColorGraphIntent,
  resolveColorBalanceParams,
  resolveToneParams,
} from '@lumaforge/luma-color-runtime'

import type { GpuPreviewInput } from './contract'
import {
  resolveGpuPreviewLook,
  resolveLUTPipelineProfileUniforms,
} from './lut-profile'
import {
  writeUniformF32,
  writeUniformI32,
  writeUniformMat3x3f,
  writeUniformVec2f,
  writeUniformVec3f,
} from './uniform-layout'

export const DEFAULT_PARAMS: ProcessingParams = {
  intensity: 0.7,
  viewMode: 'processed',
  compareSplit: 0.5,
  styleKind: 'none',
  builtinPreset: null,
  userExposureEv: 0,
  userContrast: 0,
  userHighlights: 0,
  userShadows: 0,
  userWhites: 0,
  userBlacks: 0,
  userTemperature: 0,
  userTint: 0,
  userSaturation: 0,
  userVibrance: 0,
}

export const DEFAULT_GPU_PREVIEW_INPUT: GpuPreviewInput = Object.freeze({
  color: Object.freeze(pickColorGraphIntent(DEFAULT_PARAMS)),
  output: 'processed',
})

const OUTPUT_VIEW_MODES: Record<
  GpuPreviewInput['output'],
  Exclude<ProcessingParams['viewMode'], 'compare'>
> = {
  processed: 'processed',
  'technical-original': 'original',
}

/**
 * The uniform-level params for a preview input. The output selects the shader
 * branch; the color intent passes through unchanged.
 */
export function gpuPreviewInputParams(
  input: GpuPreviewInput,
): ProcessingParams {
  return {
    ...input.color,
    viewMode: OUTPUT_VIEW_MODES[input.output],
    compareSplit: 0.5,
  }
}

export function packGpuPreviewUniforms(
  v: DataView,
  input: GpuPreviewInput,
  lut: LUTData | null,
  rawRenderExposureMultiplier: number,
  selectiveColorActive: boolean,
): void {
  packUniforms(
    v,
    gpuPreviewInputParams(input),
    lut,
    rawRenderExposureMultiplier,
    selectiveColorActive,
  )
}

// The shader renders one output per draw. Compare is composed from
// frame-anchored layers above the canvas, so a compare view mode packs as the
// processed output and the compare split never reaches the GPU.
const VIEW_MODE_UNIFORMS: Record<ProcessingParams['viewMode'], 0 | 1> = {
  processed: 0,
  original: 1,
  compare: 0,
}

const STYLE_KIND_UNIFORMS: Record<ProcessingParams['styleKind'], number> = {
  none: 0,
  builtin: 1,
  custom: 2,
}

const BUILTIN_PRESET_UNIFORMS: Record<BuiltinStylePreset, number> = {
  neutral: 0,
  warm: 1,
  cool: 2,
  'film-soft': 3,
  'film-contrast': 4,
  cinematic: 5,
  fade: 6,
  mono: 7,
}

export function packUniforms(
  v: DataView,
  p: ProcessingParams,
  lut: LUTData | null,
  rawRenderExposureMultiplier: number,
  selectiveColorActive: boolean,
): void {
  const tone = resolveToneParams({
    userExposureEv: p.userExposureEv,
    userContrast: p.userContrast,
    userHighlights: p.userHighlights,
    userShadows: p.userShadows,
    userWhites: p.userWhites,
    userBlacks: p.userBlacks,
  })
  const colorBalance = resolveColorBalanceParams({
    userTemperature: p.userTemperature,
    userTint: p.userTint,
  })
  // The shader draws the look the shared preview policy resolves, not the
  // raw selection: a LUT export refuses is left out, user color kept.
  const drawn = resolveGpuPreviewLook(p, lut)
  const drawnLut = drawn.lut
  const lutProfileUniforms = resolveLUTPipelineProfileUniforms(
    drawnLut?.profileResolution,
  )

  writeUniformMat3x3f(v, 'inputToLutGamut', lutProfileUniforms.inputToLutGamut)
  writeUniformMat3x3f(
    v,
    'lutOutputToDisplayGamut',
    lutProfileUniforms.lutOutputToDisplayGamut,
  )
  writeUniformVec3f(
    v,
    'lutDomainMin',
    drawnLut ? drawnLut.domainMin[0] : 0,
    drawnLut ? drawnLut.domainMin[1] : 0,
    drawnLut ? drawnLut.domainMin[2] : 0,
  )
  writeUniformF32(v, 'intensity', drawn.look.intensity)
  writeUniformVec3f(
    v,
    'lutDomainMax',
    drawnLut ? drawnLut.domainMax[0] : 1,
    drawnLut ? drawnLut.domainMax[1] : 1,
    drawnLut ? drawnLut.domainMax[2] : 1,
  )
  writeUniformF32(v, 'rawRenderExposureMultiplier', rawRenderExposureMultiplier)
  writeUniformVec3f(
    v,
    'userColorBalanceGain',
    colorBalance.gain[0],
    colorBalance.gain[1],
    colorBalance.gain[2],
  )
  writeUniformF32(v, 'userExposureMultiplier', tone.userExposureMultiplier)
  writeUniformF32(v, 'userContrastAmount', tone.userContrast)
  writeUniformF32(v, 'userContrastFactor', tone.userContrastFactor)
  writeUniformF32(v, 'userHighlights', tone.userHighlights)
  writeUniformF32(v, 'userShadows', tone.userShadows)
  writeUniformF32(v, 'userWhites', tone.userWhites)
  writeUniformF32(v, 'userBlacks', tone.userBlacks)
  writeUniformF32(v, 'userSaturation', p.userSaturation)
  writeUniformF32(v, 'userVibrance', p.userVibrance)
  writeUniformF32(v, 'lutSize', drawnLut ? Math.max(1, drawnLut.size) : 1)
  writeUniformVec2f(
    v,
    'selectiveColorChromaClamp',
    CHROMA_CLAMP_LOW,
    CHROMA_CLAMP_HIGH,
  )
  writeUniformI32(v, 'viewMode', VIEW_MODE_UNIFORMS[p.viewMode])
  writeUniformI32(v, 'styleKind', STYLE_KIND_UNIFORMS[drawn.look.styleKind])
  writeUniformI32(
    v,
    'builtinPreset',
    drawn.look.builtinPreset
      ? BUILTIN_PRESET_UNIFORMS[drawn.look.builtinPreset]
      : 0,
  )
  writeUniformI32(v, 'useLut', drawnLut ? 1 : 0)
  writeUniformI32(v, 'lutInputTransfer', lutProfileUniforms.lutInputTransfer)
  writeUniformI32(v, 'lutOutputTransfer', lutProfileUniforms.lutOutputTransfer)
  writeUniformI32(v, 'lutRole', lutProfileUniforms.lutRole)
  writeUniformI32(v, 'lutInputRange', lutProfileUniforms.lutInputRange)
  writeUniformI32(v, 'lutOutputRange', lutProfileUniforms.lutOutputRange)
  writeUniformI32(v, 'selectiveColorActive', selectiveColorActive ? 1 : 0)
}
