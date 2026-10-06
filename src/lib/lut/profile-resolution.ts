import type {
  LUTColorProfile,
  LUTContractResolution,
  LUTContractSelection,
  LUTRole,
  ParsedLUT,
  SignalRange,
  StoredLUTContractSelection,
} from '@lumaforge/luma-color-runtime'
import {
  buildStoredContractSelection,
  contractToLUTColorProfile as contractToRuntimeLUTColorProfile,
  getLUTColorProfile,
  isLUTRole,
  isSignalRange,
  resolveColorGamutId,
  resolveTransferFunctionId,
  toCompatInputProfile,
  toLUTContractSelection,
} from '@lumaforge/luma-color-runtime'

// Browser storage and application adapters for LUT contracts. Contract
// inference from cube text lives in @lumaforge/luma-color-runtime; this module
// only persists user selections by fingerprint and applies contracts to parsed
// LUTs on the main thread.

const LUT_PROFILE_SELECTIONS_STORAGE_KEY = 'lumaforge.lutProfileSelections.v1'

function compactProfileText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function resolveCompatProfileId(profileId: string): string {
  const compact = compactProfileText(profileId)
  if (compact === 'vlog' || compact === 'vloginput') {
    return 'panasonic-vgamut-vlog'
  }
  if (compact === 'displaysrgb' || compact === 'srgbdisplay') {
    return 'display-srgb'
  }
  return profileId
}

function getCompatibleLUTColorProfile(
  profileId: string,
): LUTColorProfile | undefined {
  return getLUTColorProfile(resolveCompatProfileId(profileId))
}

function getLUTProfileStorage(): Storage | undefined {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}

function isStoredLUTContractSelection(
  value: unknown,
): value is StoredLUTContractSelection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }

  const candidate = value as Record<string, unknown>
  const role = candidate.role
  const inputGamut = resolveColorGamutId(candidate.inputGamut)
  const inputTransfer = resolveTransferFunctionId(candidate.inputTransfer)
  const inputRange = candidate.inputRange
  const outputGamut = resolveColorGamutId(candidate.outputGamut)
  const outputTransfer = resolveTransferFunctionId(candidate.outputTransfer)
  const outputRange = candidate.outputRange

  if (
    !isLUTRole(role) ||
    !inputGamut ||
    !inputTransfer ||
    !isSignalRange(inputRange)
  ) {
    return false
  }

  const normalized = buildStoredContractSelection({
    role,
    inputGamut,
    inputTransfer,
    inputRange,
    outputGamut,
    outputTransfer,
    outputRange: isSignalRange(outputRange) ? outputRange : undefined,
  })
  if (!normalized) {
    return false
  }

  return true
}

function normalizeStoredLUTContractSelection(
  value: unknown,
): StoredLUTContractSelection | undefined {
  if (typeof value === 'string') {
    const profile = getCompatibleLUTColorProfile(value)
    return profile
      ? buildStoredContractSelection({
          inputProfile: profile.id,
          role: profile.role,
          inputGamut: profile.inputGamut,
          inputTransfer: profile.inputTransfer,
          inputRange: profile.inputRange,
          outputGamut: profile.outputGamut,
          outputTransfer: profile.outputTransfer,
          outputRange: profile.outputRange,
        })
      : undefined
  }

  if (!isStoredLUTContractSelection(value)) return undefined

  const candidate = value
  return buildStoredContractSelection({
    inputProfile:
      typeof candidate.inputProfile === 'string'
        ? (getCompatibleLUTColorProfile(candidate.inputProfile)?.id ??
          candidate.inputProfile)
        : undefined,
    role: candidate.role as LUTRole,
    inputGamut: resolveColorGamutId(candidate.inputGamut),
    inputTransfer: resolveTransferFunctionId(candidate.inputTransfer),
    inputRange: candidate.inputRange as SignalRange,
    outputGamut: resolveColorGamutId(candidate.outputGamut),
    outputTransfer: resolveTransferFunctionId(candidate.outputTransfer),
    outputRange: isSignalRange(candidate.outputRange)
      ? candidate.outputRange
      : undefined,
  })
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
          normalizeStoredLUTContractSelection(value),
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

function getContractProfileId(contract: StoredLUTContractSelection): string {
  const baseProfile = contract.inputProfile
    ? getCompatibleLUTColorProfile(contract.inputProfile)
    : undefined

  return (
    baseProfile?.id ??
    contract.inputProfile ??
    `${contract.inputGamut}-${contract.inputTransfer}`
  )
}

function normalizeAppContractSelection(
  selection: LUTContractSelection,
): LUTContractSelection {
  const inputProfile =
    typeof selection.inputProfile === 'string'
      ? getCompatibleLUTColorProfile(selection.inputProfile)?.id
      : undefined

  return {
    ...selection,
    inputProfile,
  }
}

function contractToLUTColorProfile(
  contract: StoredLUTContractSelection,
): LUTColorProfile {
  return contractToRuntimeLUTColorProfile(
    getContractProfileId(contract),
    contract,
  )
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
  return contract ? contractToLUTColorProfile(contract) : undefined
}

function buildAppContractSelection(
  selection: LUTContractSelection,
): StoredLUTContractSelection | undefined {
  return buildStoredContractSelection(normalizeAppContractSelection(selection))
}

export function storeLUTContractSelection(
  fingerprint: string,
  selection: LUTContractSelection,
): LUTColorProfile | undefined {
  const contract = buildAppContractSelection(selection)
  if (!contract) return undefined

  writeStoredLUTContractSelections({
    ...readStoredLUTContractSelections(),
    [fingerprint]: contract,
  })

  return contractToLUTColorProfile(contract)
}

export function storeLUTProfileSelection(
  fingerprint: string,
  profileId: string,
): LUTColorProfile | undefined {
  const profile = getCompatibleLUTColorProfile(profileId)
  if (!profile) return undefined

  return storeLUTContractSelection(fingerprint, toLUTContractSelection(profile))
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

  return {
    ...lut,
    profileResolution,
    inputProfile: toCompatInputProfile(profileResolution),
  }
}

/** Pure contract application: never reads or writes user storage. */
function withLUTContract(
  lut: ParsedLUT,
  selection: LUTContractSelection,
  confidence: ConfirmedLUTContractConfidence,
): ParsedLUT | undefined {
  const contract = buildAppContractSelection(selection)
  return contract
    ? withConfirmedProfile(lut, contractToLUTColorProfile(contract), confidence)
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

export function applyLUTProfileSelection(
  lut: ParsedLUT,
  profileId: string,
): ParsedLUT | undefined {
  const profile = getCompatibleLUTColorProfile(profileId)
  if (!profile) return undefined

  return applyLUTContractSelection(lut, toLUTContractSelection(profile))
}
