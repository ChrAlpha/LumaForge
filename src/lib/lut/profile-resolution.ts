import type {
  LUTColorProfile,
  LUTContractResolution,
  LUTContractSelection,
  ParsedLUT,
  StoredLUTContractSelection,
} from '@lumaforge/luma-color-runtime'
import {
  buildStoredContractSelection,
  storedContractToLUTColorProfile,
} from '@lumaforge/luma-color-runtime'

// Browser storage and application adapters for LUT contracts. Contract
// inference from cube text lives in @lumaforge/luma-color-runtime; this module
// only persists user selections by fingerprint and applies contracts to parsed
// LUTs on the main thread.

const LUT_PROFILE_SELECTIONS_STORAGE_KEY = 'lumaforge.lutProfileSelections.v1'

const STORED_CONTRACT_FIELDS = [
  'inputProfile',
  'role',
  'inputGamut',
  'inputTransfer',
  'inputRange',
  'outputGamut',
  'outputTransfer',
  'outputRange',
] as const satisfies readonly (keyof StoredLUTContractSelection)[]

function getLUTProfileStorage(): Storage | undefined {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}

/**
 * A stored record is trusted only in the exact form the writer produces: a
 * structured contract whose fields are already canonical. Rebuilding it must
 * return the same fields, so bare strings, aliases, labels, empty, non-string
 * or extra fields, and records the contract rules refuse never confirm a
 * profile.
 */
function readStoredLUTContractSelection(
  value: unknown,
): StoredLUTContractSelection | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }

  const record = value as Record<string, unknown>
  const knownFields: readonly string[] = STORED_CONTRACT_FIELDS
  if (
    Object.entries(record).some(
      ([field, fieldValue]) =>
        !knownFields.includes(field) ||
        typeof fieldValue !== 'string' ||
        fieldValue === '',
    )
  ) {
    return undefined
  }

  // Every field is a non-empty string here; the builder validates each one.
  // The writer omits absent fields and never stores an empty string, which the
  // builder would read as absent, so one is refused above.
  const contract = buildStoredContractSelection(
    record as unknown as LUTContractSelection,
  )
  if (!contract) return undefined

  return STORED_CONTRACT_FIELDS.every(
    (field) => contract[field] === record[field],
  )
    ? contract
    : undefined
}

function readStoredLUTContractSelections(): Record<
  string,
  StoredLUTContractSelection
> {
  const storage = getLUTProfileStorage()
  if (!storage) return {}

  try {
    const raw = storage.getItem(LUT_PROFILE_SELECTIONS_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {}
    }
    return Object.fromEntries(
      Object.entries(parsed)
        .map(([fingerprint, value]) => [
          fingerprint,
          readStoredLUTContractSelection(value),
        ])
        .filter((entry): entry is [string, StoredLUTContractSelection] =>
          Boolean(entry[1]),
        ),
    )
  } catch {
    return {}
  }
}

function writeStoredLUTContractSelections(
  selections: Record<string, StoredLUTContractSelection>,
) {
  const storage = getLUTProfileStorage()
  if (!storage) return

  try {
    storage.setItem(
      LUT_PROFILE_SELECTIONS_STORAGE_KEY,
      JSON.stringify(selections),
    )
  } catch {
    // Storage can be unavailable or quota-limited; profile resolution should still work.
  }
}

export function getStoredLUTContractSelection(
  fingerprint: string,
): StoredLUTContractSelection | undefined {
  return readStoredLUTContractSelections()[fingerprint]
}

export function getStoredLUTProfileSelection(
  fingerprint: string,
): LUTColorProfile | undefined {
  const contract = getStoredLUTContractSelection(fingerprint)
  return contract ? storedContractToLUTColorProfile(contract) : undefined
}

export function storeLUTContractSelection(
  fingerprint: string,
  selection: LUTContractSelection,
): LUTColorProfile | undefined {
  const contract = buildStoredContractSelection(selection)
  if (!contract) return undefined

  writeStoredLUTContractSelections({
    ...readStoredLUTContractSelections(),
    [fingerprint]: contract,
  })

  return storedContractToLUTColorProfile(contract)
}

type ConfirmedLUTContractConfidence = Extract<
  LUTContractResolution,
  { kind: 'confirmed' }
>['confidence']

function withConfirmedProfile(
  lut: ParsedLUT,
  profile: LUTColorProfile,
  confidence: ConfirmedLUTContractConfidence,
): ParsedLUT {
  const profileResolution: LUTContractResolution = {
    kind: 'confirmed',
    confidence,
    profile,
  }

  return { ...lut, profileResolution }
}

/** Pure contract application: never reads or writes user storage. */
function withLUTContract(
  lut: ParsedLUT,
  selection: LUTContractSelection,
  confidence: ConfirmedLUTContractConfidence,
): ParsedLUT | undefined {
  const contract = buildStoredContractSelection(selection)
  return contract
    ? withConfirmedProfile(
        lut,
        storedContractToLUTColorProfile(contract),
        confidence,
      )
    : undefined
}

/**
 * Applies an explicit user selection and persists it by fingerprint so the
 * same LUT content resolves to it on a later load.
 */
export function applyLUTContractSelection(
  lut: ParsedLUT,
  selection: LUTContractSelection,
): ParsedLUT | undefined {
  const selected = withLUTContract(lut, selection, 'user')
  if (selected) storeLUTContractSelection(lut.fingerprint, selection)
  return selected
}

/**
 * Applies a contract that ships with the LUT source (a trusted catalog entry)
 * as metadata. It is not a user choice, so user storage is left untouched.
 */
export function applyTrustedLUTContract(
  lut: ParsedLUT,
  selection: LUTContractSelection,
): ParsedLUT | undefined {
  return withLUTContract(lut, selection, 'metadata')
}

/**
 * Re-applies a persisted user contract to a LUT parsed without storage access
 * (the parse worker has none), keyed by fingerprint so the cube text is not
 * scanned again. Confirmed contracts already outrank stored ones; recommended,
 * unknown and unsupported-output resolutions yield to a stored selection.
 */
export function restorePersistedLUTContract(lut: ParsedLUT): ParsedLUT {
  if (lut.profileResolution.kind === 'confirmed') return lut

  const storedProfile = getStoredLUTProfileSelection(lut.fingerprint)
  return storedProfile
    ? withConfirmedProfile(lut, storedProfile, 'persisted-user')
    : lut
}
