// Build a `LutLocalFileIdentity` from a resolved `LUTColorProfile`, recording
// the effective input/output color contracts the graph will apply.

import type { LUTColorProfile } from '@lumaforge/luma-color-runtime'

import type { LutColorContract, LutLocalFileIdentity } from './render-manifest'

export type LutIdentityFailure = { readonly reason: string }

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
      failure: { reason: 'The LUT profile has no output transfer contract.' },
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
        range: contractRange(profile.inputRange),
      },
      output_contract: {
        gamut: profile.outputGamut ?? profile.inputGamut,
        transfer: outputTransfer,
        range: contractRange(
          profile.outputRange ??
            (profile.role === 'display-look' ? 'full' : undefined),
        ),
        role: profile.role,
      },
    },
  }
}
