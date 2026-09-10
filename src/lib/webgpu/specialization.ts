import type {
  BuiltinStylePreset,
  LUTData,
  ProcessingParams,
} from '@lumaforge/luma-color-runtime'
import { normalizeSelectiveColorParams } from '@lumaforge/luma-color-runtime'

import {
  isLUTProfileRenderable,
  resolveLUTPipelineProfileUniforms,
} from '~/lib/gl/webgl-pipeline'

export interface ShaderSpecialization {
  readonly styleKind: 0 | 1 | 2
  readonly useLut: boolean
  readonly selectiveColorActive: boolean
  readonly saturationActive: boolean
  readonly vibranceActive: boolean
  readonly builtinPreset?: number
  readonly lutRole?: number
  readonly lutInputTransfer?: number
  readonly lutOutputTransfer?: number
  readonly lutInputRange?: number
  readonly lutOutputRange?: number
}

// Only feature and resolved contract identifiers key shader variants.
// Numeric slider values, LUT texels, gamut matrices and domains remain dynamic.
export const MAX_CACHED_SHADER_SPECIALIZATIONS = 32
export const MAX_QUEUED_SHADER_SPECIALIZATIONS = 32
export const MAX_PARALLEL_SHADER_COMPILATIONS = 2
export const WEBGPU_SPECIALIZATION_BUSY = 'WEBGPU_SPECIALIZATION_BUSY'

const PRESETS: Record<BuiltinStylePreset, number> = {
  neutral: 0,
  warm: 1,
  cool: 2,
  'film-soft': 3,
  'film-contrast': 4,
  cinematic: 5,
  fade: 6,
  mono: 7,
}
const boundedId = (value: number | undefined, maximum: number) =>
  value !== undefined &&
  Number.isInteger(value) &&
  value >= 0 &&
  value <= maximum
    ? value
    : undefined

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
    ...(styleKind === 1
      ? { builtinPreset: boundedId(value.builtinPreset, 7) }
      : {}),
    ...(styleKind === 2
      ? {
          lutRole: boundedId(value.lutRole, 3),
          lutInputTransfer: boundedId(value.lutInputTransfer, 21),
          lutOutputTransfer: boundedId(value.lutOutputTransfer, 21),
          lutInputRange: boundedId(value.lutInputRange, 2),
          lutOutputRange: boundedId(value.lutOutputRange, 2),
        }
      : {}),
  })
}

export function getShaderSpecialization(
  params: ProcessingParams,
  lut: LUTData | null,
): ShaderSpecialization {
  const bands = normalizeSelectiveColorParams({
    selectiveColor: params.selectiveColor,
  })
  const resolved = resolveLUTPipelineProfileUniforms(lut?.profileResolution)
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
    builtinPreset: PRESETS[params.builtinPreset ?? 'neutral'] ?? 0,
    lutRole: resolved.lutRole,
    lutInputTransfer: resolved.lutInputTransfer,
    lutOutputTransfer: resolved.lutOutputTransfer,
    lutInputRange: resolved.lutInputRange,
    lutOutputRange: resolved.lutOutputRange,
    saturationActive: Math.fround(params.userSaturation) !== 0,
    vibranceActive: Math.fround(params.userVibrance) !== 0,
  })
}

export function getShaderSpecializationKey(
  value?: ShaderSpecialization,
): string {
  if (!value) return 'generic'
  const normalized = normalizeShaderSpecialization(value)
  const base = `${normalized.styleKind}:${Number(normalized.selectiveColorActive)}:${Number(normalized.saturationActive)}:${Number(normalized.vibranceActive)}`
  if (normalized.styleKind === 1)
    return `${base}:preset:${normalized.builtinPreset ?? '*'}`
  if (normalized.styleKind === 2)
    return `${base}:lut:${[normalized.lutRole, normalized.lutInputTransfer, normalized.lutOutputTransfer, normalized.lutInputRange, normalized.lutOutputRange].map((value) => value ?? '*').join(':')}`
  return base
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
  for (const field of [
    'builtinPreset',
    'lutRole',
    'lutInputTransfer',
    'lutOutputTransfer',
    'lutInputRange',
    'lutOutputRange',
  ] as const) {
    const constant = normalized[field]
    if (constant !== undefined)
      result = result.replaceAll(`params.${field}`, String(constant))
  }
  return result
}
