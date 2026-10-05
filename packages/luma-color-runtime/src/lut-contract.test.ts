import { describe, expect, it } from 'vitest'

import {
  buildStoredContractSelection,
  contractToLUTColorProfile,
  hasCompleteOutputContract,
  hasDisplayLikeInput,
  isLUTRole,
  isSignalRange,
  mapProfileLUTContract,
  resolveColorGamutId,
  resolveTransferFunctionId,
  toLUTContractSelection,
} from './lut-contract'
import { getLUTColorProfile } from './registry'
import type { LUTContractSelection, StoredLUTContractSelection } from './types'

type DisplayLabelField =
  | 'inputGamut'
  | 'inputTransfer'
  | 'outputGamut'
  | 'outputTransfer'

// buildStoredContractSelection re-resolves gamut and transfer through the
// alias tables, so selections from untyped sources (persisted JSON, JS
// callers) that still carry display labels normalize to canonical ids. The
// published selection type stays canonical-only; only this test casts.
function withDisplayLabels(
  selection: Omit<LUTContractSelection, DisplayLabelField> &
    Partial<Record<DisplayLabelField, string>>,
): LUTContractSelection {
  return selection as LUTContractSelection
}

describe('generic LUT contract validation', () => {
  it('normalizes gamut and transfer aliases', () => {
    expect(resolveColorGamutId('S-Gamut3.Cine')).toBe('s-gamut3-cine')
    expect(resolveTransferFunctionId('S-Log3')).toBe('s-log3')
  })

  it('validates role and signal range values', () => {
    expect(isLUTRole('combined-look-output')).toBe(true)
    expect(isLUTRole('monitoring')).toBe(false)
    expect(isSignalRange('legal')).toBe(true)
    expect(isSignalRange('limited')).toBe(false)
  })

  it('allows display-look only for display-like input', () => {
    expect(
      hasDisplayLikeInput({
        inputGamut: 'srgb-rec709',
        inputTransfer: 'gamma24',
      }),
    ).toBe(true)
    expect(
      buildStoredContractSelection({
        role: 'display-look',
        inputGamut: 's-gamut3-cine',
        inputTransfer: 's-log3',
        inputRange: 'full',
      }),
    ).toBeUndefined()
  })

  it('requires complete output contracts for non-display roles', () => {
    expect(
      hasCompleteOutputContract({
        outputGamut: 'srgb-rec709',
        outputTransfer: 'bt709',
      }),
    ).toBe(false)
    expect(
      buildStoredContractSelection(
        withDisplayLabels({
          role: 'scene-creative',
          inputGamut: 'S-Gamut3.Cine',
          inputTransfer: 'S-Log3',
          inputRange: 'full',
        }),
      ),
    ).toBeUndefined()
  })

  it('builds a persistable combined-output contract', () => {
    expect(
      buildStoredContractSelection(
        withDisplayLabels({
          role: 'combined-look-output',
          inputGamut: 'S-Gamut3.Cine',
          inputTransfer: 'S-Log3',
          inputRange: 'legal',
          outputGamut: 'Rec.709',
          outputTransfer: 'Gamma 2.4',
          outputRange: 'full',
        }),
      ),
    ).toEqual({
      inputProfile: 'sony-sgamut3cine-slog3',
      role: 'combined-look-output',
      inputGamut: 's-gamut3-cine',
      inputTransfer: 's-log3',
      inputRange: 'legal',
      outputGamut: 'srgb-rec709',
      outputTransfer: 'gamma24',
      outputRange: 'full',
    })
  })

  it('converts a stored contract into a LUT color profile with caller-owned id', () => {
    const contract: StoredLUTContractSelection = {
      inputProfile: 'sony-sgamut3cine-slog3',
      role: 'combined-look-output',
      inputGamut: 's-gamut3-cine',
      inputTransfer: 's-log3',
      inputRange: 'full',
      outputGamut: 'srgb-rec709',
      outputTransfer: 'bt709',
      outputRange: 'full',
    }

    expect(
      contractToLUTColorProfile('stored-fingerprint-profile', contract),
    ).toMatchObject({
      id: 'stored-fingerprint-profile',
      label: 'Sony S-Gamut3.Cine / S-Log3',
      role: 'combined-look-output',
      inputGamut: 's-gamut3-cine',
      inputTransfer: 's-log3',
      outputGamut: 'srgb-rec709',
      outputTransfer: 'bt709',
    })
  })

  it('round-trips resolved profiles into editable selections', () => {
    const profile = getLUTColorProfile('sony-sgamut3cine-slog3')
    expect(profile).toBeDefined()

    const selection = toLUTContractSelection(profile!)

    expect(selection).toEqual({
      inputProfile: 'sony-sgamut3cine-slog3',
      role: 'scene-creative',
      inputGamut: 's-gamut3-cine',
      inputTransfer: 's-log3',
      inputRange: 'full',
      outputGamut: undefined,
      outputTransfer: undefined,
      outputRange: undefined,
    })
  })
})

describe('trusted LUT metadata mapping', () => {
  it('maps trusted online metadata without filename or comment authority', () => {
    const result = mapProfileLUTContract({
      filename: 'Display_sRGB.cube',
      comments: ['LUMAFORGE_INPUT_PROFILE=display-srgb'],
      intent: 'look',
      input: { gamut: 'S-Gamut3.Cine', transfer: 'S-Log3' },
      output: { gamut: 'Rec.709', transfer: 'Gamma 2.4', range: 'legal' },
    })

    expect(result).toEqual({
      ok: true,
      value: {
        inputProfile: 'sony-sgamut3cine-slog3',
        role: 'combined-look-output',
        inputGamut: 's-gamut3-cine',
        inputTransfer: 's-log3',
        inputRange: 'full',
        outputGamut: 'srgb-rec709',
        outputTransfer: 'gamma24',
        outputRange: 'legal',
      },
    })
  })

  it('treats trusted display-look metadata with non-display input and complete output as combined output', () => {
    const result = mapProfileLUTContract({
      intent: 'display-look',
      inputGamut: 'sony-s-gamut3-cine',
      inputTransfer: 'sony-s-log3',
      outputGamut: 'rec709',
      outputTransfer: 'srgb',
    })

    expect(result).toEqual({
      ok: true,
      value: {
        inputProfile: 'sony-sgamut3cine-slog3',
        role: 'combined-look-output',
        inputGamut: 's-gamut3-cine',
        inputTransfer: 's-log3',
        inputRange: 'full',
        outputGamut: 'srgb-rec709',
        outputTransfer: 'srgb',
        outputRange: 'full',
      },
    })
  })
})
