import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { LUTContractSelection } from './profile-resolution'
import {
  applyLUTContractSelection,
  applyLUTProfileSelection,
  applyTrustedLUTContract,
  getStoredLUTContractSelection,
  getStoredLUTProfileSelection,
  resolveLUTProfile,
  restorePersistedLUTContract,
  storeLUTProfileSelection,
} from './profile-resolution'

const SELECTIONS_KEY = 'lumaforge.lutProfileSelections.v1'

function makeParsedLUTForProfileSelection(sourceName: string) {
  const profileResolution = resolveLUTProfile({
    title: 'Sony technical LUT',
    sourceName,
    comments: [],
  })

  return {
    title: 'Sony technical LUT',
    sourceName,
    comments: [],
    size: 2,
    domainMin: [0, 0, 0] as [number, number, number],
    domainMax: [1, 1, 1] as [number, number, number],
    data: new Float32Array(2 * 2 * 2 * 3),
    fingerprint: sourceName,
    profileResolution,
    inputProfile: 'display-srgb' as const,
  }
}

describe('lUT profile selection persistence', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    localStorage.clear()
  })

  it('stores valid display-look profile selections by fingerprint', () => {
    const stored = storeLUTProfileSelection('lut-fingerprint-1', 'display-srgb')

    expect(stored?.id).toBe('display-srgb')
    expect(getStoredLUTProfileSelection('lut-fingerprint-1')?.id).toBe(
      'display-srgb',
    )
  })

  it('uses a stored fingerprint selection before filename inference', () => {
    applyLUTContractSelection(
      makeParsedLUTForProfileSelection('lut-fingerprint-2'),
      {
        role: 'combined-look-output',
        inputProfile: 'sony-sgamut3cine-slog3',
        outputGamut: 'srgb-rec709',
        outputTransfer: 'bt709',
        outputRange: 'full',
      },
    )

    expect(
      resolveLUTProfile({
        title: 'LUMIXPHOTOSTYLE VLOG',
        sourceName: 'Panasonic_VLog.cube',
        comments: [],
        fingerprint: 'lut-fingerprint-2',
      }),
    ).toMatchObject({
      kind: 'confirmed',
      confidence: 'persisted-user',
      profile: { id: 'sony-sgamut3cine-slog3' },
    })
  })

  it('rejects scene-creative selections without a complete output contract', () => {
    const selected = applyLUTContractSelection(
      makeParsedLUTForProfileSelection('scene-creative-incomplete.cube'),
      {
        role: 'scene-creative',
        inputProfile: 'sony-sgamut3cine-slog3',
      },
    )

    expect(selected).toBeUndefined()
    expect(
      getStoredLUTContractSelection('scene-creative-incomplete.cube'),
    ).toBeUndefined()
  })

  it('ignores legacy string selections for non-display input-only profiles', () => {
    localStorage.setItem(
      'lumaforge.lutProfileSelections.v1',
      JSON.stringify({
        legacy: 'sony-sgamut3cine-slog3',
      }),
    )

    expect(getStoredLUTProfileSelection('legacy')).toBeUndefined()
    expect(
      resolveLUTProfile({
        title: 'Sony technical LUT',
        sourceName: 'SLog3_SGamut3Cine_to_Rec709.cube',
        comments: [],
        fingerprint: 'legacy',
      }),
    ).toMatchObject({
      kind: 'recommended',
    })
  })

  it('stores full user-selected contracts by fingerprint', () => {
    const selected = applyLUTContractSelection(
      makeParsedLUTForProfileSelection('manual-contract.cube'),
      {
        role: 'combined-look-output',
        inputProfile: 'panasonic-vgamut-vlog',
        outputGamut: 'srgb-rec709',
        outputTransfer: 'bt709',
        outputRange: 'full',
      },
    )

    expect(selected?.profileResolution).toMatchObject({
      kind: 'confirmed',
      confidence: 'user',
      profile: {
        inputGamut: 'v-gamut',
        inputTransfer: 'v-log',
        role: 'combined-look-output',
        outputGamut: 'srgb-rec709',
        outputTransfer: 'bt709',
        outputRange: 'full',
      },
    })
    expect(getStoredLUTContractSelection('manual-contract.cube')).toEqual({
      inputProfile: 'panasonic-vgamut-vlog',
      role: 'combined-look-output',
      inputGamut: 'v-gamut',
      inputTransfer: 'v-log',
      inputRange: 'full',
      outputGamut: 'srgb-rec709',
      outputTransfer: 'bt709',
      outputRange: 'full',
    })
  })

  it('rejects output roles without a complete output contract', () => {
    const selected = applyLUTContractSelection(
      makeParsedLUTForProfileSelection('incomplete-output.cube'),
      {
        role: 'combined-look-output',
        inputProfile: 'panasonic-vgamut-vlog',
      },
    )

    expect(selected).toBeUndefined()
    expect(
      getStoredLUTContractSelection('incomplete-output.cube'),
    ).toBeUndefined()
  })

  it('rejects display-look selections for non-display inputs even with output fields', () => {
    const selected = applyLUTContractSelection(
      makeParsedLUTForProfileSelection('display-look-camera-input.cube'),
      {
        role: 'display-look',
        inputProfile: 'panasonic-vgamut-vlog',
        outputGamut: 'srgb-rec709',
        outputTransfer: 'bt709',
        outputRange: 'full',
      },
    )

    expect(selected).toBeUndefined()
    expect(
      getStoredLUTContractSelection('display-look-camera-input.cube'),
    ).toBeUndefined()
  })

  it('ignores malformed non-string stored profile IDs without throwing', () => {
    localStorage.setItem(
      'lumaforge.lutProfileSelections.v1',
      JSON.stringify({
        broken: 42,
        valid: 'display-srgb',
      }),
    )

    expect(getStoredLUTProfileSelection('broken')).toBeUndefined()
    expect(getStoredLUTProfileSelection('valid')?.id).toBe('display-srgb')
    expect(() =>
      resolveLUTProfile({
        title: 'Panasonic technical LUT',
        sourceName: 'Panasonic_VLog.cube',
        comments: [],
        fingerprint: 'broken',
      }),
    ).not.toThrow()
  })
})

describe('lUT contract provenance', () => {
  const vLogToRec709: LUTContractSelection = {
    role: 'combined-look-output',
    inputProfile: 'panasonic-vgamut-vlog',
    outputGamut: 'srgb-rec709',
    outputTransfer: 'bt709',
    outputRange: 'full',
  }

  function selectionWrites(setItem: { mock: { calls: unknown[][] } }) {
    return setItem.mock.calls.filter(([key]) => key === SELECTIONS_KEY)
  }

  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  it('applies trusted catalog contracts as metadata without writing user storage', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    const lut = makeParsedLUTForProfileSelection('catalog-entry.cube')

    const trusted = applyTrustedLUTContract(lut, vLogToRec709)

    expect(trusted?.profileResolution).toMatchObject({
      kind: 'confirmed',
      confidence: 'metadata',
      profile: {
        id: 'panasonic-vgamut-vlog',
        inputGamut: 'v-gamut',
        inputTransfer: 'v-log',
        role: 'combined-look-output',
        outputGamut: 'srgb-rec709',
        outputTransfer: 'bt709',
        outputRange: 'full',
      },
    })
    expect(trusted?.inputProfile).toBe('v-log')
    expect(trusted?.fingerprint).toBe(lut.fingerprint)
    expect(lut.profileResolution.kind).not.toBe('confirmed')
    expect(selectionWrites(setItem)).toHaveLength(0)
    expect(getStoredLUTContractSelection('catalog-entry.cube')).toBeUndefined()
  })

  it('rejects incomplete trusted contracts without writing user storage', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem')

    expect(
      applyTrustedLUTContract(
        makeParsedLUTForProfileSelection('catalog-incomplete.cube'),
        { role: 'combined-look-output', inputProfile: 'panasonic-vgamut-vlog' },
      ),
    ).toBeUndefined()
    expect(selectionWrites(setItem)).toHaveLength(0)
  })

  it('persists explicit user selections with user confidence', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem')

    const selected = applyLUTContractSelection(
      makeParsedLUTForProfileSelection('user-choice.cube'),
      vLogToRec709,
    )

    expect(selected?.profileResolution).toMatchObject({
      kind: 'confirmed',
      confidence: 'user',
      profile: { id: 'panasonic-vgamut-vlog' },
    })
    expect(selectionWrites(setItem)).toHaveLength(1)
    expect(getStoredLUTContractSelection('user-choice.cube')).toMatchObject({
      inputProfile: 'panasonic-vgamut-vlog',
      outputTransfer: 'bt709',
    })
  })

  it('restores a persisted user contract by fingerprint', () => {
    applyLUTContractSelection(
      makeParsedLUTForProfileSelection('reloaded.cube'),
      vLogToRec709,
    )
    const reloaded = makeParsedLUTForProfileSelection('reloaded.cube')

    const restored = restorePersistedLUTContract(reloaded)

    expect(restored.profileResolution).toMatchObject({
      kind: 'confirmed',
      confidence: 'persisted-user',
      profile: { id: 'panasonic-vgamut-vlog', outputTransfer: 'bt709' },
    })
    expect(restored.inputProfile).toBe('v-log')
    expect(restored.data).toBe(reloaded.data)
  })

  it('keeps unmatched LUTs unchanged when restoring', () => {
    const lut = makeParsedLUTForProfileSelection('never-selected.cube')

    expect(restorePersistedLUTContract(lut)).toBe(lut)
  })

  it('keeps confirmed metadata ahead of a persisted user contract', () => {
    applyLUTContractSelection(
      makeParsedLUTForProfileSelection('metadata.cube'),
      vLogToRec709,
    )
    const withMetadata = applyTrustedLUTContract(
      makeParsedLUTForProfileSelection('metadata.cube'),
      {
        role: 'display-look',
        inputGamut: 'srgb-rec709',
        inputTransfer: 'srgb',
        inputRange: 'full',
      },
    )!

    expect(restorePersistedLUTContract(withMetadata)).toBe(withMetadata)
  })

  it('keeps the parsed resolution when storage is absent or throws', () => {
    applyLUTContractSelection(
      makeParsedLUTForProfileSelection('blocked.cube'),
      vLogToRec709,
    )
    const lut = makeParsedLUTForProfileSelection('blocked.cube')

    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage is blocked')
    })
    expect(restorePersistedLUTContract(lut)).toBe(lut)

    vi.stubGlobal('localStorage', undefined)
    expect(restorePersistedLUTContract(lut)).toBe(lut)
  })
})

describe('lUT explicit profile labels', () => {
  it('does not resolve LUT contracts from filename or free-form comments', () => {
    const resolution = resolveLUTProfile({
      title: 'Generated',
      sourceName: 'technical-vlog-to-rec709.cube',
      comments: ['LUMIXPHOTOSTYLE VLOG'],
    })

    expect(resolution).not.toMatchObject({
      kind: 'confirmed',
    })
    expect(resolution.kind).not.toBe('confirmed')
  })

  it('resolves structured metadata as a full input and output contract', () => {
    const resolution = resolveLUTProfile({
      title: 'Trusted LUT',
      sourceName: 'renamed-file.cube',
      comments: [
        'LUMAFORGE_INPUT_PROFILE=panasonic-vgamut-vlog',
        'LUMAFORGE_ROLE=combined-look-output',
        'LUMAFORGE_OUTPUT_GAMUT=srgb-rec709',
        'LUMAFORGE_OUTPUT_TRANSFER=bt709',
        'LUMAFORGE_OUTPUT_RANGE=full',
      ],
    })

    expect(resolution).toMatchObject({
      kind: 'confirmed',
      confidence: 'metadata',
      profile: {
        inputGamut: 'v-gamut',
        inputTransfer: 'v-log',
        role: 'combined-look-output',
        outputGamut: 'srgb-rec709',
        outputTransfer: 'bt709',
        outputRange: 'full',
      },
    })
  })

  it('does not resolve structured metadata when input profile conflicts with explicit input fields', () => {
    const resolution = resolveLUTProfile({
      title: 'Contradictory LUT',
      sourceName: 'contradictory.cube',
      comments: [
        'LUMAFORGE_INPUT_PROFILE=display-srgb',
        'LUMAFORGE_ROLE=display-look',
        'LUMAFORGE_INPUT_GAMUT=v-gamut',
        'LUMAFORGE_INPUT_TRANSFER=v-log',
        'LUMAFORGE_INPUT_RANGE=full',
        'LUMAFORGE_OUTPUT_GAMUT=srgb-rec709',
        'LUMAFORGE_OUTPUT_TRANSFER=bt709',
        'LUMAFORGE_OUTPUT_RANGE=full',
      ],
    })

    expect(resolution.kind).not.toBe('confirmed')
    expect(resolution).not.toMatchObject({
      kind: 'confirmed',
    })
  })

  it('does not resolve display-look metadata for non-display input without output fields', () => {
    const resolution = resolveLUTProfile({
      title: 'Incomplete Camera LUT',
      sourceName: 'Panasonic_VLog.cube',
      comments: [
        'LUMAFORGE_INPUT_PROFILE=panasonic-vgamut-vlog',
        'LUMAFORGE_ROLE=display-look',
      ],
    })

    expect(resolution.kind).not.toBe('confirmed')
    expect(resolution).not.toMatchObject({
      kind: 'confirmed',
    })
  })

  it('does not resolve display-look metadata for non-display input with output fields', () => {
    const resolution = resolveLUTProfile({
      title: 'Malformed Camera LUT',
      sourceName: 'Panasonic_VLog_to_Rec709.cube',
      comments: [
        'LUMAFORGE_INPUT_PROFILE=panasonic-vgamut-vlog',
        'LUMAFORGE_ROLE=display-look',
        'LUMAFORGE_OUTPUT_GAMUT=srgb-rec709',
        'LUMAFORGE_OUTPUT_TRANSFER=bt709',
        'LUMAFORGE_OUTPUT_RANGE=full',
      ],
    })

    expect(resolution.kind).not.toBe('confirmed')
    expect(resolution).not.toMatchObject({
      kind: 'confirmed',
    })
  })

  it('does not resolve input profile labels as explicit input profiles', () => {
    expect(
      resolveLUTProfile({
        title: 'Client LUT',
        comments: ['Input profile: V-Log'],
      }),
    ).toMatchObject({
      kind: 'recommended',
      recommendations: expect.arrayContaining([
        expect.objectContaining({ id: 'panasonic-vgamut-vlog' }),
      ]),
    })
  })

  it('does not resolve output profile labels as input profiles', () => {
    const resolution = resolveLUTProfile({
      title: 'Client LUT',
      comments: ['Output profile: V-Log'],
    })

    expect(resolution).not.toMatchObject({
      kind: 'confirmed',
      profile: { id: 'panasonic-vgamut-vlog' },
    })
    expect(resolution.kind).toBe('unknown')
  })

  it('does not resolve target profile labels as input profiles', () => {
    const resolution = resolveLUTProfile({
      title: 'Client LUT',
      comments: ['Target profile = VLog'],
    })

    expect(resolution.kind).toBe('unknown')
  })

  it('does not resolve destination profile labels as input profiles', () => {
    const resolution = resolveLUTProfile({
      title: 'Client LUT',
      comments: ['Destination profile: V-Log'],
    })

    expect(resolution.kind).toBe('unknown')
  })

  it('does not resolve bare profile labels as input profiles', () => {
    const resolution = resolveLUTProfile({
      title: 'Client LUT',
      comments: ['Profile: V-Log'],
    })

    expect(resolution.kind).toBe('unknown')
  })

  it('ignores mixed-case output-side to markers for input inference', () => {
    const resolution = resolveLUTProfile({
      title: 'UnknownCamera_To_VLog',
      sourceName: 'UnknownCamera_To_VLog.cube',
      comments: [],
    })

    expect(resolution.kind).toBe('unknown')
  })

  it('ignores mixed-case output-side for markers for input inference', () => {
    const resolution = resolveLUTProfile({
      title: 'UnknownCamera_FOR_VLog',
      sourceName: 'UnknownCamera_FOR_VLog.cube',
      comments: [],
    })

    expect(resolution.kind).toBe('unknown')
  })

  it('does not resolve unsupported Cineon output annotations as renderable profiles', () => {
    const resolution = resolveLUTProfile({
      title: 'Sony technical LUT',
      sourceName: 'SLog3_SGamut3Cine_to_Cineon.cube',
      comments: [],
    })

    expect(resolution.kind).toBe('unsupported-output')
    if (resolution.kind !== 'unsupported-output') {
      throw new Error('Expected Cineon LUT to require profile selection')
    }
    expect(resolution.recommendations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'sony-sgamut3cine-slog3' }),
      ]),
    )
    expect(resolution).not.toMatchObject({
      kind: 'confirmed',
      profile: {
        role: 'combined-look-output',
      },
    })
  })

  it('detects unsupported for Cineon and unknown LogC directional outputs', () => {
    for (const sourceName of [
      'SLog3_SGamut3Cine_for_Cineon.cube',
      'SLog3_SGamut3Cine_toCineon.cube',
      'SLog3_SGamut3Cine_to_LogC.cube',
      'SLog3_SGamut3Cine_for_LogC.cube',
    ]) {
      const resolution = resolveLUTProfile({
        title: 'Sony technical LUT',
        sourceName,
        comments: [],
      })

      expect(resolution).toMatchObject({
        kind: 'unsupported-output',
      })
    }
  })

  it('rejects legacy input-profile-only selection for unsupported filename annotations', () => {
    const selected = applyLUTProfileSelection(
      makeParsedLUTForProfileSelection('SLog3_SGamut3Cine_to_Cineon.cube'),
      'sony-sgamut3cine-slog3',
    )

    expect(selected).toBeUndefined()
  })
})
