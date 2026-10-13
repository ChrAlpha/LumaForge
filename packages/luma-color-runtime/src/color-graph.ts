import type { LumaColorBalanceParams } from './color-balance'
import { resolveColorBalanceParams } from './color-balance'
import type { ColorGamutId } from './constants'
import type { TransferFunctionId } from './log-encoding'
import type { Mat3 } from './matrix'
import { getGamutMatrix, mat3Identity } from './matrix'
import type { RawRenderExposure } from './raw-render-exposure'
import type { LUTColorProfile, LUTRole, SignalRange } from './registry'
import type { LumaColorSaturationParams } from './saturation'
import {
  normalizeSaturationParams,
  SKIN_HUE_CENTER_DEG,
  SKIN_HUE_SIGMA_DEG,
  SKIN_PROTECT_STRENGTH,
  USER_SATURATION_MAX_FACTOR,
  USER_VIBRANCE_MAX_FACTOR,
  VIBRANCE_CHROMA_REF,
} from './saturation'
import type {
  LumaColorSelectiveColorParams,
  UserSelectiveColorGraphStep,
} from './selective-color'
import {
  CHROMA_CLAMP_HIGH,
  CHROMA_CLAMP_LOW,
  LUT_CONSTANTS_VERSION,
  normalizeSelectiveColorParams,
} from './selective-color'
import type { LumaColorToneParams } from './tone'
import { resolveToneParams } from './tone'
import type { LUTData, ProcessingParams } from './types'

export type ExportColorGraphStep =
  | { kind: 'input-linear-prophoto' }
  | { kind: 'raw-render-exposure'; ev: number; multiplier: number }
  | {
      kind: 'user-color-balance'
      temperature: number
      tint: number
      gain: readonly [number, number, number]
      operator: 'linear-prophoto-relative-rgb-gain'
      luminanceCoefficients: readonly [number, number, number]
    }
  | { kind: 'user-exposure'; ev: number; multiplier: number }
  | {
      kind: 'user-contrast'
      amount: number
      factor: number
      pivot: number
      operator: 'linear-prophoto-luminance-scale'
      luminanceCoefficients: readonly [number, number, number]
      zeroLuminanceMode: 'return-black'
    }
  | {
      kind: 'user-regional-tone'
      highlights: number
      shadows: number
      whites: number
      blacks: number
      operator: 'linear-prophoto-log-luminance-regions'
      pivot: number
      luminanceCoefficients: readonly [number, number, number]
      zeroLuminanceMode: 'return-black'
    }
  | UserSelectiveColorGraphStep
  | {
      kind: 'user-saturation'
      operator: 'oklab-chroma-with-skin-protection'
      saturation: number
      vibrance: number
      satMaxFactor: number
      vibMaxFactor: number
      chromaRef: number
      skinHueCenterDeg: number
      skinHueSigmaDeg: number
      skinProtectStrength: number
    }
  | { kind: 'gamut-to-lut-input'; matrix: Mat3; gamut: ColorGamutId }
  | {
      kind: 'encode-lut-transfer'
      transfer: TransferFunctionId
      range: SignalRange
    }
  | {
      kind: 'lut3d'
      size: number
      data: Float32Array
      domainMin: [number, number, number]
      domainMax: [number, number, number]
    }
  | {
      kind: 'builtin-style'
      preset: NonNullable<ProcessingParams['builtinPreset']>
      intensity: number
    }
  | {
      kind: 'lut-output-to-srgb'
      matrix: Mat3
      transfer: TransferFunctionId
      range: SignalRange
      role: LUTRole
      intensity: number
    }
  | { kind: 'output-srgb' }

export type ExportColorGraphDescriptor =
  | {
      supported: true
      outputGamut: 'srgb-rec709'
      outputTransfer: 'srgb'
      lutProfile: LUTColorProfile | null
      steps: ExportColorGraphStep[]
    }
  | {
      supported: false
      reason: 'unsupported-pipeline'
      message: string
      steps: []
    }

export type SupportedExportColorGraphDescriptor = Extract<
  ExportColorGraphDescriptor,
  { supported: true }
>

const OUTPUT_GAMUT = 'srgb-rec709'
const OUTPUT_TRANSFER = 'srgb'
const IDENTITY_RAW_RENDER_EXPOSURE: RawRenderExposure = {
  ev: 0,
  multiplier: 1,
  source: 'identity',
}

function resolveEffectiveLUTOutputTransfer(
  profile: LUTColorProfile,
): TransferFunctionId | undefined {
  if (profile.outputTransfer) return profile.outputTransfer

  if (profile.role === 'display-look') return profile.inputTransfer

  return undefined
}

/**
 * Why a confirmed LUT profile cannot feed full-resolution JPEG export:
 * `incomplete-output` while its output still has to be stated, and
 * `unsupported-output` when the output it states cannot be encoded.
 */
export interface UnsupportedLUTOutputReason {
  code: 'incomplete-output' | 'unsupported-output'
  message: string
}

export function resolveUnsupportedLUTOutputReason(
  profile: LUTColorProfile,
): UnsupportedLUTOutputReason | undefined {
  if (profile.outputRange === 'unknown') {
    return {
      code: 'incomplete-output',
      message:
        'This LUT output range must be explicit before full-resolution JPEG export.',
    }
  }

  if (
    profile.role !== 'display-look' &&
    (!profile.outputGamut || !profile.outputTransfer || !profile.outputRange)
  ) {
    return {
      code: 'incomplete-output',
      message: 'Choose a LUT output profile before full-resolution export.',
    }
  }

  const effectiveOutputTransfer = resolveEffectiveLUTOutputTransfer(profile)
  if (!effectiveOutputTransfer) {
    return {
      code: 'incomplete-output',
      message: 'Choose a LUT output profile before full-resolution export.',
    }
  }

  if (effectiveOutputTransfer === 'linear') {
    return {
      code: 'unsupported-output',
      message:
        'This LUT output transfer is not supported by full-resolution JPEG export.',
    }
  }

  return undefined
}

/**
 * What the export color graph reads: the look and user color (see
 * `ColorGraphIntent`), the LUT data, and the RAW render exposure. Missing
 * scalar user fields read as neutral; HSL is required as complete bands, so
 * partial HSL goes through `normalizeColorGraphIntent` first.
 */
export interface ExportColorGraphInput {
  styleKind: ProcessingParams['styleKind']
  intensity: number
  builtinPreset: ProcessingParams['builtinPreset']
  lut: LUTData | null
  rawRenderExposure?: RawRenderExposure
  userExposureEv?: LumaColorToneParams['userExposureEv']
  userContrast?: LumaColorToneParams['userContrast']
  userHighlights?: LumaColorToneParams['userHighlights']
  userShadows?: LumaColorToneParams['userShadows']
  userWhites?: LumaColorToneParams['userWhites']
  userBlacks?: LumaColorToneParams['userBlacks']
  userTemperature?: LumaColorBalanceParams['userTemperature']
  userTint?: LumaColorBalanceParams['userTint']
  userSaturation?: LumaColorSaturationParams['userSaturation']
  userVibrance?: LumaColorSaturationParams['userVibrance']
  selectiveColor: LumaColorSelectiveColorParams['selectiveColor']
}

export function resolveExportColorGraph(
  input: ExportColorGraphInput,
): ExportColorGraphDescriptor {
  const rawRenderExposure =
    input.rawRenderExposure ?? IDENTITY_RAW_RENDER_EXPOSURE
  const colorBalance = resolveColorBalanceParams({
    userTemperature: input.userTemperature,
    userTint: input.userTint,
  })
  const tone = resolveToneParams({
    userExposureEv: input.userExposureEv,
    userContrast: input.userContrast,
    userHighlights: input.userHighlights,
    userShadows: input.userShadows,
    userWhites: input.userWhites,
    userBlacks: input.userBlacks,
  })
  const selectiveColorBands = normalizeSelectiveColorParams({
    selectiveColor: input.selectiveColor,
  })
  const satParams = normalizeSaturationParams({
    userSaturation: input.userSaturation,
    userVibrance: input.userVibrance,
  })
  const base: ExportColorGraphStep[] = [
    { kind: 'input-linear-prophoto' },
    {
      kind: 'raw-render-exposure',
      ev: rawRenderExposure.ev,
      multiplier: rawRenderExposure.multiplier,
    },
    {
      kind: 'user-color-balance',
      temperature: colorBalance.userTemperature,
      tint: colorBalance.userTint,
      gain: colorBalance.gain,
      operator: colorBalance.operator,
      luminanceCoefficients: colorBalance.luminanceCoefficients,
    },
    {
      kind: 'user-exposure',
      ev: tone.userExposureEv,
      multiplier: tone.userExposureMultiplier,
    },
    {
      kind: 'user-contrast',
      amount: tone.userContrast,
      factor: tone.userContrastFactor,
      pivot: tone.contrastPivot,
      operator: 'linear-prophoto-luminance-scale',
      luminanceCoefficients: tone.luminanceCoefficients,
      zeroLuminanceMode: 'return-black',
    },
    {
      kind: 'user-regional-tone',
      highlights: tone.userHighlights,
      shadows: tone.userShadows,
      whites: tone.userWhites,
      blacks: tone.userBlacks,
      operator: 'linear-prophoto-log-luminance-regions',
      pivot: tone.regionalTonePivot,
      luminanceCoefficients: tone.luminanceCoefficients,
      zeroLuminanceMode: 'return-black',
    },
    {
      kind: 'user-saturation',
      operator: 'oklab-chroma-with-skin-protection',
      saturation: satParams.userSaturation,
      vibrance: satParams.userVibrance,
      satMaxFactor: USER_SATURATION_MAX_FACTOR,
      vibMaxFactor: USER_VIBRANCE_MAX_FACTOR,
      chromaRef: VIBRANCE_CHROMA_REF,
      skinHueCenterDeg: SKIN_HUE_CENTER_DEG,
      skinHueSigmaDeg: SKIN_HUE_SIGMA_DEG,
      skinProtectStrength: SKIN_PROTECT_STRENGTH,
    },
    {
      kind: 'user-selective-color',
      bands: selectiveColorBands,
      chromaClampLow: CHROMA_CLAMP_LOW,
      chromaClampHigh: CHROMA_CLAMP_HIGH,
      workingSpace: 'oklab-via-prophoto-d65',
      operator: 'oklch-per-band-shift',
      constantsVersion: LUT_CONSTANTS_VERSION,
    },
  ]

  if (input.styleKind === 'builtin' && input.builtinPreset) {
    return {
      supported: false,
      reason: 'unsupported-pipeline',
      message:
        'Built-in styles are not supported by full-resolution JPEG export.',
      steps: [],
    }
  }

  if (input.styleKind !== 'custom' || !input.lut) {
    return {
      supported: true,
      outputGamut: OUTPUT_GAMUT,
      outputTransfer: OUTPUT_TRANSFER,
      lutProfile: null,
      steps: [...base, { kind: 'output-srgb' }],
    }
  }

  if (input.lut.profileResolution.kind !== 'confirmed') {
    return {
      supported: false,
      reason: 'unsupported-pipeline',
      message: 'Choose a LUT input profile before full-resolution export.',
      steps: [],
    }
  }

  const profile = input.lut.profileResolution.profile
  const effectiveOutputTransfer = resolveEffectiveLUTOutputTransfer(profile)
  const unsupportedOutputReason = resolveUnsupportedLUTOutputReason(profile)
  if (unsupportedOutputReason) {
    return {
      supported: false,
      reason: 'unsupported-pipeline',
      message: unsupportedOutputReason.message,
      steps: [],
    }
  }

  const inputMatrix =
    profile.inputGamut === 'prophoto-rgb'
      ? mat3Identity()
      : getGamutMatrix('prophoto-rgb', profile.inputGamut)
  const outputGamut = profile.outputGamut ?? profile.inputGamut
  const outputRange = profile.outputRange ?? 'full'
  const outputMatrix =
    outputGamut === OUTPUT_GAMUT
      ? mat3Identity()
      : getGamutMatrix(outputGamut, OUTPUT_GAMUT)

  return {
    supported: true,
    outputGamut: OUTPUT_GAMUT,
    outputTransfer: OUTPUT_TRANSFER,
    lutProfile: profile,
    steps: [
      ...base,
      {
        kind: 'gamut-to-lut-input',
        matrix: inputMatrix,
        gamut: profile.inputGamut,
      },
      {
        kind: 'encode-lut-transfer',
        transfer: profile.inputTransfer,
        range: profile.inputRange,
      },
      {
        kind: 'lut3d',
        size: input.lut.size,
        data: input.lut.data,
        domainMin: input.lut.domainMin,
        domainMax: input.lut.domainMax,
      },
      {
        kind: 'lut-output-to-srgb',
        matrix: outputMatrix,
        transfer: effectiveOutputTransfer!,
        range: outputRange,
        role: profile.role,
        intensity: input.intensity,
      },
      { kind: 'output-srgb' },
    ],
  }
}
