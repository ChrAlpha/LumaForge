import type {
  BuiltinStylePreset,
  ColorGraphIntent,
  LookStyleKind,
  LUTData,
} from '@lumaforge/luma-color-runtime'
import {
  CHROMA_CLAMP_HIGH,
  CHROMA_CLAMP_LOW,
  NEUTRAL_SELECTIVE_COLOR,
  resolveColorBalanceParams,
  resolveToneParams,
} from '@lumaforge/luma-color-runtime'

import type { PreviewSurfaceOutput } from '~/lib/preview/preview-view'

import { resolveGpuPreviewLook } from './lut-profile'
import {
  writeUniformF32,
  writeUniformI32,
  writeUniformMat3x3f,
  writeUniformVec2f,
  writeUniformVec3f,
} from './uniform-layout'

/**
 * What the uniform packer reads: the complete color intent, HSL included,
 * plus the output the surface draws. Selecting the technical original never
 * rewrites the color intent, and the frame-anchored compare split never
 * reaches the GPU.
 */
export type GpuPreviewParams = ColorGraphIntent & {
  readonly output: PreviewSurfaceOutput
}

export const DEFAULT_PARAMS: GpuPreviewParams = {
  intensity: 0.7,
  output: 'processed',
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
  selectiveColor: NEUTRAL_SELECTIVE_COLOR,
}

// The shader renders one output per draw; compare is composed from
// frame-anchored layers above the canvas. The technical original selects the
// technical base (VIEW_MODE_ORIGINAL in the shader).
const OUTPUT_UNIFORMS: Record<PreviewSurfaceOutput, 0 | 1> = {
  processed: 0,
  'technical-original': 1,
}

const STYLE_KIND_UNIFORMS: Record<LookStyleKind, number> = {
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
  p: GpuPreviewParams,
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
  const lutProfileUniforms = drawn.uniforms

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
  writeUniformI32(v, 'viewMode', OUTPUT_UNIFORMS[p.output])
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
