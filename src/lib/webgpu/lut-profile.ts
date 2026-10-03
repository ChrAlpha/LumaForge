/**
 * LUT contract to preview shader-uniform resolution. A LUT only renders when
 * its contract is confirmed and fully describes the output side.
 */

import type {
  LUTColorProfile,
  LUTContractResolution,
  TransferFunctionId,
} from '@lumaforge/luma-color-runtime'
import {
  getLinearProPhotoToGamutMatrix,
  getLUTOutputToTargetMatrix,
  mat3Identity,
  mat3ToColumnMajor,
} from '@lumaforge/luma-color-runtime'
import {
  LUT_RANGE_UNIFORMS,
  LUT_ROLE_UNIFORMS,
  LUT_TRANSFER_UNIFORMS,
} from '@lumaforge/luma-color-runtime/wgsl'

export interface LUTPipelineProfileUniforms {
  inputToLutGamut: Float32Array
  lutOutputToDisplayGamut: Float32Array
  lutInputTransfer: number
  lutOutputTransfer: number
  lutRole: number
  lutInputRange: number
  lutOutputRange: number
}

const DISPLAY_TARGET_GAMUT = 'srgb-rec709'

const DISPLAY_PROFILE_UNIFORMS: LUTPipelineProfileUniforms = {
  inputToLutGamut: mat3ToColumnMajor(mat3Identity()),
  lutOutputToDisplayGamut: mat3ToColumnMajor(mat3Identity()),
  lutInputTransfer: LUT_TRANSFER_UNIFORMS.srgb,
  lutOutputTransfer: LUT_TRANSFER_UNIFORMS.srgb,
  lutRole: LUT_ROLE_UNIFORMS['display-look'],
  lutInputRange: LUT_RANGE_UNIFORMS.full,
  lutOutputRange: LUT_RANGE_UNIFORMS.full,
}

export function isLUTProfileRenderable(
  profileResolution?: LUTContractResolution | null,
): boolean {
  if (!profileResolution || profileResolution.kind !== 'confirmed') {
    return false
  }

  const { profile } = profileResolution
  if (profile.role === 'display-look') {
    return true
  }

  return Boolean(
    profile.outputGamut &&
    profile.outputTransfer &&
    profile.outputRange &&
    profile.outputRange !== 'unknown',
  )
}

export function resolveLUTOutputTransfer(
  profile: LUTColorProfile,
): TransferFunctionId | undefined {
  if (profile.outputTransfer) return profile.outputTransfer

  if (profile.role === 'display-look') return profile.inputTransfer

  return undefined
}

export function resolveLUTPipelineProfileUniforms(
  profileResolution?: LUTContractResolution | null,
): LUTPipelineProfileUniforms {
  if (
    !isLUTProfileRenderable(profileResolution) ||
    profileResolution?.kind !== 'confirmed'
  ) {
    return DISPLAY_PROFILE_UNIFORMS
  }

  const { profile } = profileResolution
  if (profile.role === 'display-look') {
    return {
      ...DISPLAY_PROFILE_UNIFORMS,
      lutInputTransfer:
        LUT_TRANSFER_UNIFORMS[profile.inputTransfer] ??
        DISPLAY_PROFILE_UNIFORMS.lutInputTransfer,
      lutOutputTransfer:
        LUT_TRANSFER_UNIFORMS[
          profile.outputTransfer ?? profile.inputTransfer
        ] ?? DISPLAY_PROFILE_UNIFORMS.lutOutputTransfer,
      lutInputRange: LUT_RANGE_UNIFORMS[profile.inputRange],
      lutOutputRange: LUT_RANGE_UNIFORMS[profile.outputRange ?? 'full'],
    }
  }

  const outputGamut = profile.outputGamut!
  const outputTransfer = resolveLUTOutputTransfer(profile)
  const lutOutputToDisplayGamut =
    outputGamut === DISPLAY_TARGET_GAMUT
      ? mat3Identity()
      : getLUTOutputToTargetMatrix(outputGamut, DISPLAY_TARGET_GAMUT)

  return {
    inputToLutGamut: mat3ToColumnMajor(
      getLinearProPhotoToGamutMatrix(profile.inputGamut),
    ),
    lutOutputToDisplayGamut: mat3ToColumnMajor(lutOutputToDisplayGamut),
    lutInputTransfer: LUT_TRANSFER_UNIFORMS[profile.inputTransfer],
    lutOutputTransfer: LUT_TRANSFER_UNIFORMS[outputTransfer!],
    lutRole: LUT_ROLE_UNIFORMS[profile.role],
    lutInputRange: LUT_RANGE_UNIFORMS[profile.inputRange],
    lutOutputRange: LUT_RANGE_UNIFORMS[profile.outputRange!],
  }
}
