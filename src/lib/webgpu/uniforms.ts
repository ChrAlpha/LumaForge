import type {
  BuiltinStylePreset,
  LUTData,
  ProcessingParams,
} from '@lumaforge/luma-color-runtime'
import {
  CHROMA_CLAMP_HIGH,
  CHROMA_CLAMP_LOW,
  resolveColorBalanceParams,
  resolveToneParams,
} from '@lumaforge/luma-color-runtime'

import {
  isLUTProfileRenderable,
  resolveLUTPipelineProfileUniforms,
} from '~/lib/gl/pipeline'

import {
  writeUniformF32,
  writeUniformI32,
  writeUniformMat3x3f,
  writeUniformVec2f,
  writeUniformVec3f,
} from './uniform-layout'
export const DEFAULT_PARAMS: ProcessingParams = {
  intensity: 0.7,
  viewMode: 'compare',
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

const VIEW_MODE_UNIFORMS: Record<ProcessingParams['viewMode'], number> = {
  processed: 0,
  original: 1,
  compare: 2,
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
  const lutProfileUniforms = resolveLUTPipelineProfileUniforms(
    lut?.profileResolution,
  )
  const useRenderableLut = Boolean(
    lut && isLUTProfileRenderable(lut.profileResolution),
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
    useRenderableLut && lut ? lut.domainMin[0] : 0,
    useRenderableLut && lut ? lut.domainMin[1] : 0,
    useRenderableLut && lut ? lut.domainMin[2] : 0,
  )
  writeUniformF32(v, 'intensity', p.intensity)
  writeUniformVec3f(
    v,
    'lutDomainMax',
    useRenderableLut && lut ? lut.domainMax[0] : 1,
    useRenderableLut && lut ? lut.domainMax[1] : 1,
    useRenderableLut && lut ? lut.domainMax[2] : 1,
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
  writeUniformF32(v, 'compareSplit', Math.min(1, Math.max(0, p.compareSplit)))
  writeUniformF32(
    v,
    'lutSize',
    useRenderableLut && lut ? Math.max(1, lut.size) : 1,
  )
  writeUniformVec2f(
    v,
    'selectiveColorChromaClamp',
    CHROMA_CLAMP_LOW,
    CHROMA_CLAMP_HIGH,
  )
  writeUniformI32(v, 'viewMode', VIEW_MODE_UNIFORMS[p.viewMode])
  writeUniformI32(v, 'styleKind', STYLE_KIND_UNIFORMS[p.styleKind])
  writeUniformI32(
    v,
    'builtinPreset',
    p.builtinPreset ? BUILTIN_PRESET_UNIFORMS[p.builtinPreset] : 0,
  )
  writeUniformI32(v, 'useLut', useRenderableLut ? 1 : 0)
  writeUniformI32(v, 'lutInputTransfer', lutProfileUniforms.lutInputTransfer)
  writeUniformI32(v, 'lutOutputTransfer', lutProfileUniforms.lutOutputTransfer)
  writeUniformI32(v, 'lutRole', lutProfileUniforms.lutRole)
  writeUniformI32(v, 'lutInputRange', lutProfileUniforms.lutInputRange)
  writeUniformI32(v, 'lutOutputRange', lutProfileUniforms.lutOutputRange)
  writeUniformI32(v, 'selectiveColorActive', selectiveColorActive ? 1 : 0)
}
