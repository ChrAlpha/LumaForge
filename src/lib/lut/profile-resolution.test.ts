import type { LUTContractSelection } from '@lumaforge/luma-color-runtime'
import { resolveLUTProfile } from '@lumaforge/luma-color-runtime'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  applyLUTContractSelection,
  applyTrustedLUTContract,
  getStoredLUTContractSelection,
  getStoredLUTProfileSelection,
  restorePersistedLUTContract,
  storeLUTContractSelection,
} from './profile-resolution'

const SELECTIONS_KEY = 'lumaforge.lutProfileSelections.v1'

// Literal records the deployed writer leaves in browser storage: structured
// contracts with canonical profile, gamut and transfer IDs, never bare strings.
const PRODUCTION_RECORDS = {
  'fp-display-srgb': {
    inputProfile: 'display-srgb',
    role: 'display-look',
    inputGamut: 'srgb-rec709',
    inputTransfer: 'srgb',
    inputRange: 'full',
  },
  'fp-rec709-gamma24': {
    inputProfile: 'rec709-gamma24',
    role: 'display-look',
    inputGamut: 'srgb-rec709',
    inputTransfer: 'gamma24',
    inputRange: 'full',
  },
  'fp-vlog-rec709': {
    inputProfile: 'panasonic-vgamut-vlog',
    role: 'combined-look-output',
    inputGamut: 'v-gamut',
    inputTransfer: 'v-log',
    inputRange: 'full',
    outputGamut: 'srgb-rec709',
    outputTransfer: 'bt709',
    outputRange: 'full',
  },
  'fp-slog3-scene': {
    inputProfile: 'sony-sgamut3cine-slog3',
    role: 'scene-creative',
    inputGamut: 's-gamut3-cine',
    inputTransfer: 's-log3',
    inputRange: 'full',
    outputGamut: 'srgb-rec709',
    outputTransfer: 'gamma24',
    outputRange: 'legal',
  },
  'fp-nikon-zr': {
    inputProfile: 'nikon-zr-rwg-log3g10',
    role: 'technical-output',
    inputGamut: 'red-wide-gamut-rgb',
    inputTransfer: 'log3g10',
    inputRange: 'full',
    outputGamut: 'rec2020',
    outputTransfer: 'linear',
    outputRange: 'unknown',
  },
  'fp-custom-rwg': {
    role: 'combined-look-output',
    inputGamut: 'red-wide-gamut-rgb',
    inputTransfer: 'log3g10',
    inputRange: 'legal',
    outputGamut: 'srgb-rec709',
    outputTransfer: 'srgb',
    outputRange: 'full',
  },
  'fp-gamut-only-match': {
    inputProfile: 'fuji-fgamut-flog2',
    role: 'combined-look-output',
    inputGamut: 'f-gamut',
    inputTransfer: 'f-log2',
    inputRange: 'full',
    outputGamut: 'srgb-rec709',
    outputTransfer: 'bt709',
    outputRange: 'full',
  },
} as const

// The selections that produced PRODUCTION_RECORDS, keyed the same way.
const PRODUCTION_SELECTIONS: Record<
  keyof typeof PRODUCTION_RECORDS,
  LUTContractSelection
> = {
  'fp-display-srgb': { role: 'display-look', inputProfile: 'display-srgb' },
  'fp-rec709-gamma24': { role: 'display-look', inputProfile: 'rec709-gamma24' },
  'fp-vlog-rec709': {
    role: 'combined-look-output',
    inputProfile: 'panasonic-vgamut-vlog',
    outputGamut: 'srgb-rec709',
    outputTransfer: 'bt709',
    outputRange: 'full',
  },
  'fp-slog3-scene': {
    role: 'scene-creative',
    inputProfile: 'sony-sgamut3cine-slog3',
    outputGamut: 'srgb-rec709',
    outputTransfer: 'gamma24',
    outputRange: 'legal',
  },
  'fp-nikon-zr': {
    role: 'technical-output',
    inputProfile: 'nikon-zr-rwg-log3g10',
    outputGamut: 'rec2020',
    outputTransfer: 'linear',
    outputRange: 'unknown',
  },
  'fp-custom-rwg': {
    role: 'combined-look-output',
    inputGamut: 'red-wide-gamut-rgb',
    inputTransfer: 'log3g10',
    inputRange: 'legal',
    outputGamut: 'srgb-rec709',
    outputTransfer: 'srgb',
    outputRange: 'full',
  },
  'fp-gamut-only-match': {
    role: 'combined-look-output',
    inputGamut: 'f-gamut',
    inputTransfer: 'f-log2',
    inputRange: 'full',
    outputGamut: 'srgb-rec709',
    outputTransfer: 'bt709',
    outputRange: 'full',
  },
}

const PRODUCTION_FINGERPRINTS = Object.keys(
  PRODUCTION_RECORDS,
) as (keyof typeof PRODUCTION_RECORDS)[]

function seedSelections(records: Record<string, unknown>) {
  localStorage.setItem(SELECTIONS_KEY, JSON.stringify(records))
}

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

  it('refuses an incomplete or inconsistent selection without writing it', () => {
    const selections: LUTContractSelection[] = [
      { role: 'scene-creative', inputProfile: 'sony-sgamut3cine-slog3' },
      { role: 'combined-look-output', inputProfile: 'panasonic-vgamut-vlog' },
      {
        role: 'display-look',
        inputProfile: 'panasonic-vgamut-vlog',
        outputGamut: 'srgb-rec709',
        outputTransfer: 'bt709',
        outputRange: 'full',
      },
    ]
    for (const selection of selections) {
      const fingerprint = `${selection.role}.cube`
      expect(
        applyLUTContractSelection(
          makeParsedLUTForProfileSelection(fingerprint),
          selection,
        ),
      ).toBeUndefined()
      expect(getStoredLUTContractSelection(fingerprint)).toBeUndefined()
    }
    expect(localStorage.getItem(SELECTIONS_KEY)).toBeNull()
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

describe('lUT stored selection records', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    localStorage.clear()
  })

  it('reads every deployed record back unchanged', () => {
    seedSelections(PRODUCTION_RECORDS)

    for (const fingerprint of PRODUCTION_FINGERPRINTS) {
      expect(getStoredLUTContractSelection(fingerprint)).toEqual(
        PRODUCTION_RECORDS[fingerprint],
      )
    }
  })

  it('maps deployed records to profiles with their IDs, gamut, transfer and ranges', () => {
    seedSelections(PRODUCTION_RECORDS)

    for (const fingerprint of PRODUCTION_FINGERPRINTS) {
      const {
        inputProfile,
        ...contract
      }: { inputProfile?: string } & Record<string, string> =
        PRODUCTION_RECORDS[fingerprint]
      expect(getStoredLUTProfileSelection(fingerprint)).toMatchObject({
        id: inputProfile ?? `${contract.inputGamut}-${contract.inputTransfer}`,
        outputGamut: undefined,
        outputTransfer: undefined,
        outputRange: undefined,
        ...contract,
      })
    }
    expect(getStoredLUTProfileSelection('fp-custom-rwg')?.id).toBe(
      'red-wide-gamut-rgb-log3g10',
    )
  })

  it('confirms a deployed record as the persisted user contract on reload', () => {
    seedSelections(PRODUCTION_RECORDS)
    const reloaded = makeParsedLUTForProfileSelection('fp-slog3-scene')

    const restored = restorePersistedLUTContract(reloaded)

    expect(restored.profileResolution).toMatchObject({
      kind: 'confirmed',
      confidence: 'persisted-user',
      profile: {
        id: 'sony-sgamut3cine-slog3',
        role: 'scene-creative',
        inputGamut: 's-gamut3-cine',
        inputTransfer: 's-log3',
        inputRange: 'full',
        outputGamut: 'srgb-rec709',
        outputTransfer: 'gamma24',
        outputRange: 'legal',
      },
    })
    expect(restored.data).toBe(reloaded.data)
  })

  it('writes the same literal records the deployed writer wrote', () => {
    for (const fingerprint of PRODUCTION_FINGERPRINTS) {
      storeLUTContractSelection(fingerprint, PRODUCTION_SELECTIONS[fingerprint])
    }

    expect(JSON.parse(localStorage.getItem(SELECTIONS_KEY)!)).toEqual(
      PRODUCTION_RECORDS,
    )
  })

  it('keeps deployed records when a new selection is stored', () => {
    seedSelections(PRODUCTION_RECORDS)

    storeLUTContractSelection('fp-new', PRODUCTION_SELECTIONS['fp-vlog-rec709'])

    expect(JSON.parse(localStorage.getItem(SELECTIONS_KEY)!)).toEqual({
      ...PRODUCTION_RECORDS,
      'fp-new': PRODUCTION_RECORDS['fp-vlog-rec709'],
    })
  })

  const UNWRITTEN_RECORDS: Record<string, unknown> = {
    'bare-profile-id': 'display-srgb',
    'bare-alias': 'vlog',
    'bare-registry-alias': 'Panasonic VLog',
    'alias-profile-id': {
      ...PRODUCTION_RECORDS['fp-vlog-rec709'],
      inputProfile: 'vlog',
    },
    'registry-alias-profile-id': {
      ...PRODUCTION_RECORDS['fp-vlog-rec709'],
      inputProfile: 'Panasonic VLog',
    },
    'unknown-profile-id': {
      ...PRODUCTION_RECORDS['fp-custom-rwg'],
      inputProfile: 'not-a-profile',
    },
    'gamut-label': {
      ...PRODUCTION_RECORDS['fp-vlog-rec709'],
      inputGamut: 'V-Gamut',
    },
    'transfer-label': {
      ...PRODUCTION_RECORDS['fp-vlog-rec709'],
      inputTransfer: 'V-Log',
    },
    'output-gamut-label': {
      ...PRODUCTION_RECORDS['fp-vlog-rec709'],
      outputGamut: 'Rec.709',
    },
    'missing-unique-profile-id': {
      ...PRODUCTION_RECORDS['fp-vlog-rec709'],
      inputProfile: undefined,
    },
    'invalid-output-range': {
      ...PRODUCTION_RECORDS['fp-display-srgb'],
      outputRange: 'bogus',
    },
    'empty-output-range': {
      ...PRODUCTION_RECORDS['fp-display-srgb'],
      outputRange: '',
    },
    'empty-output-range-on-output-role': {
      ...PRODUCTION_RECORDS['fp-vlog-rec709'],
      outputRange: '',
    },
    'empty-profile-id': {
      ...PRODUCTION_RECORDS['fp-custom-rwg'],
      inputProfile: '',
    },
    'null-output-field': {
      ...PRODUCTION_RECORDS['fp-display-srgb'],
      outputGamut: null,
    },
    'extra-field': {
      ...PRODUCTION_RECORDS['fp-vlog-rec709'],
      lutInputProfile: 'v-log',
    },
    'conflicting-profile': {
      ...PRODUCTION_RECORDS['fp-vlog-rec709'],
      inputProfile: 'sony-sgamut3cine-slog3',
    },
    'incomplete-output': {
      ...PRODUCTION_RECORDS['fp-vlog-rec709'],
      outputRange: undefined,
    },
    'missing-input-range': {
      ...PRODUCTION_RECORDS['fp-display-srgb'],
      inputRange: undefined,
    },
    'invalid-role': { ...PRODUCTION_RECORDS['fp-display-srgb'], role: 'look' },
    'numeric-profile-id': {
      ...PRODUCTION_RECORDS['fp-custom-rwg'],
      inputProfile: 42,
    },
    'object-gamut': {
      ...PRODUCTION_RECORDS['fp-vlog-rec709'],
      inputGamut: { id: 'v-gamut' },
    },
    array: [PRODUCTION_RECORDS['fp-display-srgb']],
    null: null,
    number: 42,
  }

  it.each(Object.keys(UNWRITTEN_RECORDS))(
    'rejects the unwritten %s record',
    (fingerprint) => {
      seedSelections({
        ...PRODUCTION_RECORDS,
        [fingerprint]: UNWRITTEN_RECORDS[fingerprint],
      })

      expect(getStoredLUTContractSelection(fingerprint)).toBeUndefined()
      expect(getStoredLUTProfileSelection(fingerprint)).toBeUndefined()
      const lut = makeParsedLUTForProfileSelection(fingerprint)
      expect(restorePersistedLUTContract(lut)).toBe(lut)
      expect(
        resolveLUTProfile({
          title: 'Panasonic technical LUT',
          sourceName: 'Panasonic_VLog_to_Rec709.cube',
          comments: [],
          fingerprint,
          lookupStoredProfile: getStoredLUTProfileSelection,
        }).kind,
      ).not.toBe('confirmed')
      expect(getStoredLUTContractSelection('fp-vlog-rec709')).toEqual(
        PRODUCTION_RECORDS['fp-vlog-rec709'],
      )
    },
  )

  it('refuses an alias-only selection instead of writing it', () => {
    expect(
      storeLUTContractSelection('alias-selection', {
        role: 'combined-look-output',
        inputProfile: 'vlog',
        outputGamut: 'srgb-rec709',
        outputTransfer: 'bt709',
        outputRange: 'full',
      }),
    ).toBeUndefined()
    expect(localStorage.getItem(SELECTIONS_KEY)).toBeNull()
  })

  it('ignores a registry that is not a record object', () => {
    localStorage.setItem(
      SELECTIONS_KEY,
      JSON.stringify([PRODUCTION_RECORDS['fp-display-srgb']]),
    )
    expect(getStoredLUTContractSelection('0')).toBeUndefined()

    localStorage.setItem(SELECTIONS_KEY, '{not json')
    expect(getStoredLUTContractSelection('fp-display-srgb')).toBeUndefined()
  })
})
