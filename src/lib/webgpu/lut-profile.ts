/**
 * What the WebGPU preview draws for the selected look, and the LUT contract to
 * shader-uniform resolution for the LUT it draws.
 */

import type {
  ColorGraphIntentSource,
  LookSelection,
  LUTColorProfile,
  LUTContractResolution,
  LUTData,
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
import type { PreviewColorPlanReason } from '@lumaforge/render-engine/preview'
import { resolvePreviewColorPlan } from '@lumaforge/render-engine/preview'

export interface GpuPreviewLook {
  /** The look the shader draws: the selection, or no look. */
  look: LookSelection
  /** The LUT the shader samples; null unless a custom look is drawn. */
  lut: LUTData | null
  /** Why the drawn look differs from the selection; null when it does not. */
  reason: PreviewColorPlanReason | null
}

/**
 * The look the WebGPU preview draws, read from the shared preview color
 * policy. A custom LUT draws only when export would run it; otherwise the
 * shader draws no look over the user's adjustments, at any strength. Built-in
 * presets draw as selected. The selection itself is never rewritten.
 */
export function resolveGpuPreviewLook(
  intent: ColorGraphIntentSource,
  lut: LUTData | null,
): GpuPreviewLook {
  const plan = resolvePreviewColorPlan({ intent, lut, executor: 'webgpu' })
  return { look: plan.effective, lut: plan.lut, reason: plan.reason }
}

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

/** Whether a contract describes enough of the LUT output to map uniforms. */
function describesLUTOutput(
  profileResolution?: LUTContractResolution | null,
): profileResolution is Extract<LUTContractResolution, { kind: 'confirmed' }> {
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
  if (!describesLUTOutput(profileResolution)) {
    return DISPLAY_PROFILE_UNIFORMS
  }

  const { profile } = profileResolution
  if (profile.role === 'display-look') {
    // Display looks read display sRGB, but may declare a wider output gamut;
    // export converts that output to sRGB, so the preview must as well.
    const outputGamut = profile.outputGamut ?? profile.inputGamut
    return {
      ...DISPLAY_PROFILE_UNIFORMS,
      lutOutputToDisplayGamut:
        outputGamut === DISPLAY_TARGET_GAMUT
          ? DISPLAY_PROFILE_UNIFORMS.lutOutputToDisplayGamut
          : mat3ToColumnMajor(
              getLUTOutputToTargetMatrix(outputGamut, DISPLAY_TARGET_GAMUT),
            ),
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
