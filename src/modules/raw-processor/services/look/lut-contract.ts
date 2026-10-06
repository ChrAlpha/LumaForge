import type {
  ColorGamutId,
  LUTColorProfile,
  LUTContractResolution,
  SignalRange,
  TransferFunctionId,
} from '@lumaforge/luma-color-runtime'
import {
  getLUTColorProfile,
  hasDisplayLikeInput,
} from '@lumaforge/luma-color-runtime'

import type { LUTContractSelectionState } from '../../model/session'

/**
 * What a LUT contract delivers on its output side. A display look on
 * display-like input implies its own display output; any other profile needs
 * all three output fields declared before it can be applied.
 */
export type LUTContractOutput =
  | { kind: 'missing' }
  | { kind: 'display-implied' }
  | {
      kind: 'declared'
      gamut: ColorGamutId
      transfer: TransferFunctionId
      range: SignalRange
      /** The declared output is display-referred Rec.709. */
      displayLike: boolean
    }

export type KnownLUTContractOutput = Exclude<
  LUTContractOutput,
  { kind: 'missing' }
>

export function getResolvedProfile(
  selection?: LUTContractSelectionState | null,
  resolution?: LUTContractResolution | null,
) {
  if (resolution?.kind === 'confirmed') return resolution.profile
  if (selection?.status === 'confirmed') {
    return getLUTColorProfile(selection.profileId)
  }
  return undefined
}

export function describeLUTContractOutput(
  profile: LUTColorProfile,
): LUTContractOutput {
  const { outputGamut, outputTransfer, outputRange } = profile
  if (!outputGamut || !outputTransfer || !outputRange) {
    return profile.role === 'display-look' && hasDisplayLikeInput(profile)
      ? { kind: 'display-implied' }
      : { kind: 'missing' }
  }

  return {
    kind: 'declared',
    gamut: outputGamut,
    transfer: outputTransfer,
    range: outputRange,
    displayLike: hasDisplayLikeInput({
      inputGamut: outputGamut,
      inputTransfer: outputTransfer,
    }),
  }
}

/** The profile, when its output side is known well enough to apply it. */
export function toSelectableContract(profile: LUTColorProfile) {
  if (describeLUTContractOutput(profile).kind === 'missing') return undefined
  return profile
}

function getComposedContractRole(
  inputProfile: LUTColorProfile,
  outputProfile: LUTColorProfile,
): LUTColorProfile['role'] {
  const outputIsDisplayLike = hasDisplayLikeInput(outputProfile)
  const outputMatchesInput =
    inputProfile.inputGamut === outputProfile.inputGamut &&
    inputProfile.inputTransfer === outputProfile.inputTransfer

  if (
    inputProfile.role === 'display-look' &&
    hasDisplayLikeInput(inputProfile) &&
    outputIsDisplayLike
  ) {
    return 'display-look'
  }
  if (outputIsDisplayLike) return 'combined-look-output'
  if (outputMatchesInput) return 'scene-creative'
  return 'technical-output'
}

/**
 * Completes a contract from two picks: the input profile keeps its input
 * side, and the output profile's input side becomes the contract's output.
 */
export function composeLUTContractProfile(
  inputProfile: LUTColorProfile,
  outputProfile: LUTColorProfile,
): LUTColorProfile {
  return {
    ...inputProfile,
    role: getComposedContractRole(inputProfile, outputProfile),
    outputGamut: outputProfile.inputGamut,
    outputTransfer: outputProfile.inputTransfer,
    outputRange: outputProfile.inputRange,
  }
}

export type LUTContractView =
  | {
      status: 'confirmed'
      profile: LUTColorProfile
      output: KnownLUTContractOutput
    }
  | { status: 'incomplete-output'; profile: LUTColorProfile }
  | {
      status: 'recommended'
      recommendation: LUTColorProfile
      recommendations: LUTColorProfile[]
      completesContract: boolean
    }
  | { status: 'unknown' }
  | { status: 'unsupported-output'; recommendations: LUTColorProfile[] }

export function deriveLUTContractView(
  selection?: LUTContractSelectionState | null,
  resolution?: LUTContractResolution | null,
): LUTContractView {
  const resolved = getResolvedProfile(selection, resolution)
  if (resolved) {
    const output = describeLUTContractOutput(resolved)
    if (output.kind === 'missing') {
      return { status: 'incomplete-output', profile: resolved }
    }
    return { status: 'confirmed', profile: resolved, output }
  }

  const recommendations =
    resolution &&
    (resolution.kind === 'recommended' ||
      resolution.kind === 'unsupported-output')
      ? resolution.recommendations
      : selection &&
          (selection.status === 'recommended' ||
            selection.status === 'unsupported-output')
        ? selection.recommendations
        : []

  if (
    resolution?.kind === 'unsupported-output' ||
    selection?.status === 'unsupported-output'
  ) {
    return { status: 'unsupported-output', recommendations }
  }

  if (recommendations.length > 0) {
    const recommendation = recommendations[0]
    return {
      status: 'recommended',
      recommendation,
      recommendations,
      completesContract: Boolean(toSelectableContract(recommendation)),
    }
  }

  return { status: 'unknown' }
}
