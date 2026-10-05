import type {
  LUTColorProfile,
  LUTContractResolution,
  LUTContractSelection,
  LUTInputProfile,
  LUTRole,
  ParsedLUT,
  SignalRange,
  StoredLUTContractSelection,
} from '@lumaforge/luma-color-runtime'
import {
  buildStoredContractSelection,
  contractToLUTColorProfile as contractToRuntimeLUTColorProfile,
  getLUTColorProfile,
  inferLUTColorProfileHints,
  isLUTRole,
  isSignalRange,
  resolveColorGamutId,
  resolveTransferFunctionId,
  toLUTContractSelection,
} from '@lumaforge/luma-color-runtime'

export type {
  LUTContractSelection,
  StoredLUTContractSelection,
} from '@lumaforge/luma-color-runtime'
export { toLUTContractSelection } from '@lumaforge/luma-color-runtime'

const LUT_PROFILE_SELECTIONS_STORAGE_KEY = 'lumaforge.lutProfileSelections.v1'
function stripCubeExtension(name: string): string {
  return name.replace(/\.cube$/i, '')
}

function normalizeProfileText(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/([a-z])(\d)/g, '$1 $2')
    .replace(/(\d)([a-z])/g, '$1 $2')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

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

export function contractToLUTColorProfile(
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

function extractCubeComments(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('#'))
    .map((line) => line.replace(/^#+\s?/, '').trim())
    .filter(Boolean)
}

function readStructuredMetadata(comments: string[]) {
  const metadata = new Map<string, string>()
  for (const comment of comments) {
    if (!comment.startsWith('LUMAFORGE_')) continue
    const separatorIndex = comment.indexOf('=')
    if (separatorIndex < 0) continue

    const key = comment.slice('LUMAFORGE_'.length, separatorIndex).trim()
    const value = comment.slice(separatorIndex + 1).trim()
    if (/^[A-Z_]+$/.test(key) && value) metadata.set(key, value)
  }
  return metadata
}

function resolveStructuredMetadataContract(
  comments: string[],
): LUTColorProfile | undefined {
  const metadata = readStructuredMetadata(comments)
  const role = metadata.get('ROLE')
  if (!isLUTRole(role)) return undefined

  const inputProfile = metadata.get('INPUT_PROFILE')
  const inputGamut = resolveColorGamutId(metadata.get('INPUT_GAMUT'))
  const inputTransfer = resolveTransferFunctionId(
    metadata.get('INPUT_TRANSFER'),
  )
  const inputRange = metadata.get('INPUT_RANGE')
  const outputGamut = resolveColorGamutId(metadata.get('OUTPUT_GAMUT'))
  const outputTransfer = resolveTransferFunctionId(
    metadata.get('OUTPUT_TRANSFER'),
  )
  const outputRange = metadata.get('OUTPUT_RANGE')

  const contract = buildStoredContractSelection({
    inputProfile: inputProfile
      ? getCompatibleLUTColorProfile(inputProfile)?.id
      : undefined,
    role,
    inputGamut,
    inputTransfer,
    inputRange: isSignalRange(inputRange) ? inputRange : undefined,
    outputGamut,
    outputTransfer,
    outputRange: isSignalRange(outputRange) ? outputRange : undefined,
  })

  return contract ? contractToLUTColorProfile(contract) : undefined
}

function buildProfileSignature(input: {
  title: string
  sourceName?: string
  comments: string[]
}): string {
  return [input.sourceName, input.title, ...input.comments]
    .filter(Boolean)
    .join('\n')
}

function stripOutputSide(value: string): string {
  if (
    /\b(?:output|target|destination)\s+profile\s*[:=]/i.test(value) ||
    (/\bprofile\s*[:=]/i.test(value) &&
      !/\b(?:input|source|camera)\s+profile\s*[:=]/i.test(value))
  ) {
    return ''
  }

  const directionalMarker =
    value.match(/(?:^|[^a-z0-9])(?:to|for)(?=$|[^a-z0-9])/i) ??
    value.match(/(?:^|[^A-Za-z0-9])(?:to|To|TO|for|For|FOR)(?=[A-Z0-9])/)
  if (!directionalMarker || directionalMarker.index === undefined) return value
  return value.slice(0, directionalMarker.index)
}

function buildInputProfileInput(input: {
  title: string
  sourceName?: string
  comments: string[]
}): { title: string; sourceName?: string; comments: string[] } {
  const title = stripOutputSide(input.title).trim()
  const sourceName = input.sourceName
    ? stripOutputSide(input.sourceName).trim() || undefined
    : undefined
  const comments = input.comments
    .map((comment) => stripOutputSide(comment).trim())
    .filter((comment) => comment.length > 0)

  return {
    title,
    sourceName,
    comments,
  }
}

function inferOutputAnnotation(
  signature: string,
): Partial<
  Pick<
    LUTColorProfile,
    'outputGamut' | 'outputTransfer' | 'outputRange' | 'role'
  >
> {
  const normalized = normalizeProfileText(signature)
  const compact = compactProfileText(signature)

  if (
    /\b(?:to|for)\s+(?:rec\s*709|bt\s*709|bt\s*1886)\b/.test(normalized) ||
    /\b(?:bt\s*709|bt\s*1886)\b/.test(normalized) ||
    /\b(?:lc\s*709|709\s+type\s+a|wide\s*dr)\b/.test(normalized) ||
    [
      'torec709',
      'tobt709',
      'tobt1886',
      'bt709',
      'bt1886',
      'lc709',
      '709typea',
      'widedr',
    ].some((marker) => compact.includes(marker))
  ) {
    return {
      role: 'combined-look-output',
      outputGamut: 'srgb-rec709',
      outputTransfer: 'gamma24',
      outputRange: 'full',
    }
  }

  if (/\bto\s+v\s*log\b/.test(normalized) || compact.includes('tovlog')) {
    return {
      role: 'technical-output',
      outputGamut: 'v-gamut',
      outputTransfer: 'v-log',
      outputRange: 'unknown',
    }
  }

  if (/\bto\s+linear\b/.test(normalized) || compact.includes('tolinear')) {
    return {
      role: 'technical-output',
      outputTransfer: 'linear',
      outputRange: 'unknown',
    }
  }

  if (/\bto\s+cineon\b/.test(normalized) || compact.includes('tocineon')) {
    return {}
  }

  return {}
}

function hasUnsupportedOutputAnnotation(signature: string): boolean {
  const normalized = normalizeProfileText(signature)
  const compact = compactProfileText(signature)
  return (
    /\b(?:to|for)\s+(?:cineon|log\s*c)\b/.test(normalized) ||
    ['tocineon', 'forcineon', 'tologc', 'forlogc'].some((marker) =>
      compact.includes(marker),
    )
  )
}

function annotateProfileOutput(
  profile: LUTColorProfile,
  signature: string,
): LUTColorProfile {
  const outputAnnotation = inferOutputAnnotation(signature)
  if (Object.keys(outputAnnotation).length === 0) return profile

  return {
    ...profile,
    ...outputAnnotation,
  }
}

function uniqueProfiles(profiles: LUTColorProfile[]): LUTColorProfile[] {
  const seen = new Set<string>()
  const unique: LUTColorProfile[] = []

  for (const profile of profiles) {
    if (seen.has(profile.id)) continue
    seen.add(profile.id)
    unique.push(profile)
  }

  return unique
}

export function resolveLUTProfile(input: {
  title: string
  sourceName?: string
  comments: string[]
  fingerprint?: string
}): LUTContractResolution {
  const signature = buildProfileSignature(input)

  const metadataProfile = resolveStructuredMetadataContract(input.comments)
  if (metadataProfile) {
    return {
      kind: 'confirmed',
      confidence: 'metadata',
      profile: metadataProfile,
    }
  }

  if (input.fingerprint) {
    const storedProfile = getStoredLUTProfileSelection(input.fingerprint)
    if (storedProfile) {
      return {
        kind: 'confirmed',
        confidence: 'persisted-user',
        profile: storedProfile,
      }
    }
  }

  const inputProfileInput = buildInputProfileInput(input)
  const recommendations = uniqueProfiles(
    inferLUTColorProfileHints(inputProfileInput).map((profile) =>
      annotateProfileOutput(profile, signature),
    ),
  )

  if (hasUnsupportedOutputAnnotation(signature)) {
    return { kind: 'unsupported-output', recommendations }
  }

  if (recommendations.length > 0) {
    return { kind: 'recommended', recommendations }
  }

  return { kind: 'unknown' }
}

export function toCompatInputProfile(
  profileResolution: LUTContractResolution,
): LUTInputProfile {
  if (profileResolution.kind !== 'confirmed') return 'display-srgb'

  const { profile } = profileResolution
  if (
    profile.id === 'panasonic-vgamut-vlog' ||
    profile.inputTransfer === 'v-log'
  ) {
    return 'v-log'
  }

  return 'display-srgb'
}

export function inferLUTInputProfile({
  content,
  sourceName,
  title,
}: {
  content: string
  sourceName?: string
  title?: string
}): LUTInputProfile {
  return toCompatInputProfile(
    resolveLUTProfile({
      title: title || (sourceName ? stripCubeExtension(sourceName) : ''),
      sourceName,
      comments: extractCubeComments(content),
    }),
  )
}
