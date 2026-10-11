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
  storedContractToLUTColorProfile,
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

  it('names a stored contract profile by its canonical input profile, or by its input when it names none', () => {
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

    expect(storedContractToLUTColorProfile(contract)).toEqual(
      contractToLUTColorProfile('sony-sgamut3cine-slog3', contract),
    )
    expect(
      storedContractToLUTColorProfile({
        ...contract,
        inputProfile: 'S-Gamut3.Cine S-Log3',
      }).id,
    ).toBe('sony-sgamut3cine-slog3')

    const { inputProfile: _named, ...unnamed } = contract
    expect(storedContractToLUTColorProfile(unnamed)).toMatchObject({
      id: 's-gamut3-cine-s-log3',
      label: 's-gamut3-cine / s-log3',
      inputGamut: 's-gamut3-cine',
      inputTransfer: 's-log3',
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

  it('maps combined-look-output intent to a complete output contract', () => {
    const result = mapProfileLUTContract({
      intent: 'combined-look-output',
      input: { gamut: 'arri-wide-gamut-3', transfer: 'logc3' },
      output: { gamut: 'rec709', transfer: 'gamma24' },
    })

    expect(result).toEqual({
      ok: true,
      value: {
        role: 'combined-look-output',
        inputProfile: 'arri-awg3-logc3',
        inputGamut: 'arri-wide-gamut-3',
        inputTransfer: 'logc3',
        inputRange: 'full',
        outputGamut: 'srgb-rec709',
        outputTransfer: 'gamma24',
        outputRange: 'full',
      },
    })
  })

  it.each([
    ['display-look', 'display-look'],
    ['technical-output', 'technical-output'],
    ['scene-creative', 'scene-creative'],
  ] as const)('maps %s intent to the same role', (intent, role) => {
    const result = mapProfileLUTContract({
      intent,
      input: { gamut: 'rec709', transfer: 'srgb' },
      output: { gamut: 'rec709', transfer: 'gamma24' },
    })

    expect(result).toMatchObject({ ok: true, value: { role } })
  })

  it('accepts flat R2 display-look metadata without output for display-like input', () => {
    const result = mapProfileLUTContract({
      intent: 'display-look',
      inputGamut: 'rec709',
      inputTransfer: 'srgb',
    })

    expect(result).toEqual({
      ok: true,
      value: {
        role: 'display-look',
        inputProfile: 'display-srgb',
        inputGamut: 'srgb-rec709',
        inputTransfer: 'srgb',
        inputRange: 'full',
        outputGamut: undefined,
        outputTransfer: undefined,
        outputRange: undefined,
      },
    })
  })

  it('rejects flat R2 display-look metadata without output for camera log input', () => {
    const result = mapProfileLUTContract({
      intent: 'display-look',
      inputGamut: 'arri-wide-gamut-3',
      inputTransfer: 'arri-logc3',
    })

    expect(result).toMatchObject({
      ok: false,
      issues: [{ code: 'unsupported-contract' }],
    })
  })

  it('maps legacy look intent to combined-look-output with output metadata', () => {
    const result = mapProfileLUTContract({
      intent: 'look',
      input: { gamut: 'arri-wide-gamut-3', transfer: 'logc3' },
      output: { gamut: 'rec709', transfer: 'gamma24', range: 'legal' },
    })

    expect(result).toMatchObject({
      ok: true,
      value: {
        role: 'combined-look-output',
        outputGamut: 'srgb-rec709',
        outputTransfer: 'gamma24',
        outputRange: 'legal',
      },
    })
  })

  it('maps flat R2 look metadata to combined-look-output when output fields are present', () => {
    const result = mapProfileLUTContract({
      inputTransfer: 'arri-logc3',
      inputGamut: 'arri-wide-gamut-3',
      outputTransfer: 'srgb',
      outputGamut: 'rec709',
      intent: 'look',
    })

    expect(result).toEqual({
      ok: true,
      value: {
        role: 'combined-look-output',
        inputProfile: 'arri-awg3-logc3',
        inputGamut: 'arri-wide-gamut-3',
        inputTransfer: 'logc3',
        inputRange: 'full',
        outputGamut: 'srgb-rec709',
        outputTransfer: 'srgb',
        outputRange: 'full',
      },
    })
  })

  it('maps legacy look intent to scene-creative without output metadata and fails closed', () => {
    const result = mapProfileLUTContract({
      intent: 'look',
      input: { gamut: 'arri-wide-gamut-3', transfer: 'logc3' },
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.code)).toContain(
        'unsupported-contract',
      )
    }
  })

  it.each(['monitoring', 'calibration', 'unknown', undefined] as const)(
    'rejects unsupported intent %s with a typed issue',
    (intent) => {
      const result = mapProfileLUTContract({
        intent,
        input: { gamut: 'rec709', transfer: 'srgb' },
        output: { gamut: 'rec709', transfer: 'gamma24' },
      })

      expect(result).toMatchObject({
        ok: false,
        issues: [{ code: 'unsupported-contract' }],
      })
    },
  )

  it('rejects unknown gamut or transfer values', () => {
    const result = mapProfileLUTContract({
      intent: 'combined-look-output',
      input: { gamut: 'not-a-gamut', transfer: 'logc3' },
      output: { gamut: 'rec709', transfer: 'not-a-transfer' },
    })

    expect(result).toMatchObject({
      ok: false,
      issues: [
        { code: 'unsupported-contract' },
        { code: 'unsupported-contract' },
      ],
    })
  })
})
