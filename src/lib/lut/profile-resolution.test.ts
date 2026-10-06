import type { LUTContractSelection } from '@lumaforge/luma-color-runtime'
import { resolveLUTProfile } from '@lumaforge/luma-color-runtime'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  applyLUTContractSelection,
  applyLUTProfileSelection,
  applyTrustedLUTContract,
  getStoredLUTContractSelection,
  getStoredLUTProfileSelection,
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
        lookupStoredProfile: getStoredLUTProfileSelection,
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
        lookupStoredProfile: getStoredLUTProfileSelection,
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
        lookupStoredProfile: getStoredLUTProfileSelection,
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

describe('lUT legacy profile selection', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    localStorage.clear()
  })

  it('rejects legacy input-profile-only selection for unsupported filename annotations', () => {
    const selected = applyLUTProfileSelection(
      makeParsedLUTForProfileSelection('SLog3_SGamut3Cine_to_Cineon.cube'),
      'sony-sgamut3cine-slog3',
    )

    expect(selected).toBeUndefined()
  })
})
