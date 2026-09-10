import type { LUTData, ProcessingParams } from '@lumaforge/luma-color-runtime'
import { normalizeSelectiveColorParams } from '@lumaforge/luma-color-runtime'

import { isLUTProfileRenderable } from '~/lib/gl/webgl-pipeline'

export interface ShaderSpecialization {
  readonly styleKind: 0 | 1 | 2
  readonly useLut: boolean
  readonly selectiveColorActive: boolean
  readonly saturationActive: boolean
  readonly vibranceActive: boolean
}

// Three effective style paths and three independent binary color flags.
// Numeric slider values, LUT data and preset choices remain uniforms/textures.
export const MAX_SHADER_SPECIALIZATIONS = 24

export function normalizeShaderSpecialization(
  value: ShaderSpecialization,
): ShaderSpecialization {
  const styleKind =
    value.styleKind === 1
      ? 1
      : value.styleKind === 2 && value.useLut === true
        ? 2
        : 0
  return Object.freeze({
    styleKind,
    useLut: styleKind === 2,
    selectiveColorActive: value.selectiveColorActive === true,
    saturationActive: value.saturationActive === true,
    vibranceActive: value.vibranceActive === true,
  })
}

export function getShaderSpecialization(
  params: ProcessingParams,
  lut: LUTData | null,
): ShaderSpecialization {
  const bands = normalizeSelectiveColorParams({
    selectiveColor: params.selectiveColor,
  })
  return normalizeShaderSpecialization({
    styleKind:
      params.styleKind === 'builtin'
        ? 1
        : params.styleKind === 'custom'
          ? 2
          : 0,
    useLut: Boolean(lut && isLUTProfileRenderable(lut.profileResolution)),
    selectiveColorActive: Object.values(bands).some(
      (band) => band.hue !== 0 || band.saturation !== 0 || band.lightness !== 0,
    ),
    // Match the actual f32 upload. Signed zero and values rounded to zero take
    // the existing neutral bypass; nonfinite values stay dynamic, not hidden.
    saturationActive: Math.fround(params.userSaturation) !== 0,
    vibranceActive: Math.fround(params.userVibrance) !== 0,
  })
}

export function getShaderSpecializationKey(
  value?: ShaderSpecialization,
): string {
  if (!value) return 'generic'
  const normalized = normalizeShaderSpecialization(value)
  return `${normalized.styleKind}:${Number(normalized.selectiveColorActive)}:${Number(normalized.saturationActive)}:${Number(normalized.vibranceActive)}`
}

export function specializeProcessShader(
  code: string,
  value: ShaderSpecialization,
): string {
  const normalized = normalizeShaderSpecialization(value)
  let result = code
    .replaceAll('params.styleKind', String(normalized.styleKind))
    .replaceAll('params.useLut', normalized.useLut ? '1' : '0')
    .replaceAll(
      'params.selectiveColorActive',
      normalized.selectiveColorActive ? '1' : '0',
    )
  if (!normalized.saturationActive)
    result = result.replaceAll('params.userSaturation', '0.0')
  if (!normalized.vibranceActive)
    result = result.replaceAll('params.userVibrance', '0.0')
  return result
}
