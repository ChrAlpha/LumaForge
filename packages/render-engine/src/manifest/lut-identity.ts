// Build a `LutLocalFileIdentity` from a resolved `LUTColorProfile`, recording
// the effective input/output color contracts the graph will apply.

import type { LUTColorProfile } from '@lumaforge/luma-color-runtime'

import type { LutColorContract, LutLocalFileIdentity } from './render-manifest'

export type LutIdentityFailure =
  | { readonly code: 'output-transfer-missing'; readonly reason: string }
  | {
      readonly code: 'range-unspecified'
      readonly contract: 'input' | 'output'
      readonly reason: string
    }

function contractRange(range: string | undefined): LutColorContract['range'] {
  return range === 'full' || range === 'legal' ? range : 'unknown'
}

/**
 * Returns `null` (with a reason) when the profile cannot express a complete
 * output contract — the same condition under which the export color graph
 * refuses the LUT.
 */
export function lutIdentityFromProfile(input: {
  readonly filename: string
  readonly sha256: string
  readonly profile: LUTColorProfile
  /**
   * Refuse profiles whose signal ranges are unspecified instead of recording
   * `'unknown'`; renderers that never guess a contract (the CLI) set this.
   */
  readonly requireExplicitRange?: boolean
}):
  | { identity: LutLocalFileIdentity }
  | { identity: null; failure: LutIdentityFailure } {
  const { profile } = input
  const outputTransfer =
    profile.outputTransfer ??
    (profile.role === 'display-look' ? profile.inputTransfer : undefined)
  if (!outputTransfer) {
    return {
      identity: null,
      failure: {
        code: 'output-transfer-missing',
        reason: 'The LUT profile has no output transfer contract.',
      },
    }
  }
  const inputRange = contractRange(profile.inputRange)
  const outputRange = contractRange(
    profile.outputRange ??
      (profile.role === 'display-look' ? 'full' : undefined),
  )
  if (input.requireExplicitRange) {
    const unspecified =
      inputRange === 'unknown'
        ? 'input'
        : outputRange === 'unknown'
          ? 'output'
          : null
    if (unspecified) {
      return {
        identity: null,
        failure: {
          code: 'range-unspecified',
          contract: unspecified,
          reason: `LUT ${unspecified} range must be explicit ("full" or "legal") before rendering.`,
        },
      }
    }
  }
  return {
    identity: {
      kind: 'local-file',
      filename: input.filename,
      sha256: input.sha256,
      input_contract: {
        gamut: profile.inputGamut,
        transfer: profile.inputTransfer,
        range: inputRange,
      },
      output_contract: {
        gamut: profile.outputGamut ?? profile.inputGamut,
        transfer: outputTransfer,
        range: outputRange,
        role: profile.role,
      },
    },
  }
}
