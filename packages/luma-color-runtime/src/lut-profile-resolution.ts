import {
  buildStoredContractSelection,
  contractToLUTColorProfile,
  isLUTRole,
  isSignalRange,
  resolveColorGamutId,
  resolveTransferFunctionId,
} from './lut-contract'
import type { LUTColorProfile } from './registry'
import { getLUTColorProfile, inferLUTColorProfileHints } from './registry'
import type { LUTContractResolution, StoredLUTContractSelection } from './types'

export interface ResolveLUTProfileInput {
  title: string
  sourceName?: string
  comments: string[]
  fingerprint?: string
  lookupStoredProfile?: (fingerprint: string) => LUTColorProfile | undefined
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

function getContractProfileId(contract: StoredLUTContractSelection): string {
  const baseProfile = contract.inputProfile
    ? getLUTColorProfile(contract.inputProfile)
    : undefined

  return (
    baseProfile?.id ??
    contract.inputProfile ??
    `${contract.inputGamut}-${contract.inputTransfer}`
  )
}

function resolvedProfileFromContract(
  contract: StoredLUTContractSelection,
): LUTColorProfile {
  return contractToLUTColorProfile(getContractProfileId(contract), contract)
}

function readStructuredMetadata(comments: string[]): Map<string, string> {
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
      ? getLUTColorProfile(inputProfile)?.id
      : undefined,
    role,
    inputGamut,
    inputTransfer,
    inputRange: isSignalRange(inputRange) ? inputRange : undefined,
    outputGamut,
    outputTransfer,
    outputRange: isSignalRange(outputRange) ? outputRange : undefined,
  })

  return contract ? resolvedProfileFromContract(contract) : undefined
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

  return { title, sourceName, comments }
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

export function resolveLUTProfile(
  input: ResolveLUTProfileInput,
): LUTContractResolution {
  const signature = buildProfileSignature(input)

  const metadataProfile = resolveStructuredMetadataContract(input.comments)
  if (metadataProfile) {
    return {
      kind: 'confirmed',
      confidence: 'metadata',
      profile: metadataProfile,
    }
  }

  if (input.fingerprint && input.lookupStoredProfile) {
    const storedProfile = input.lookupStoredProfile(input.fingerprint)
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
