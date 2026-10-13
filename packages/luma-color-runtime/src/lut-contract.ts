import type { ColorGamutId } from './constants'
import type { TransferFunctionId } from './log-encoding'
import type { LUTColorProfile, LUTRole, SignalRange } from './registry'
import {
  getColorGamut,
  getLUTColorProfile,
  getTransferFunction,
  TIER1_LUT_COLOR_PROFILES,
} from './registry'
import type { LUTContractSelection, StoredLUTContractSelection } from './types'

const DISPLAY_LIKE_INPUT_TRANSFERS = new Set<TransferFunctionId>([
  'srgb',
  'bt709',
  'gamma24',
])

const SUPPORTED_INTENT_ROLES = new Set<LUTRole>([
  'technical-output',
  'display-look',
  'scene-creative',
  'combined-look-output',
])

export interface LUTContractIssue {
  code: 'unsupported-contract'
  message: string
}

export type LUTContractResult<T> =
  | { ok: true; value: T }
  | { ok: false; issues: LUTContractIssue[] }

function issue(message: string): LUTContractIssue {
  return { code: 'unsupported-contract', message }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function readRecordField(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const field = value[key]

  return isRecord(field) ? field : undefined
}

function readString(
  value: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const field = value?.[key]

  return typeof field === 'string' ? field : undefined
}

export function isSignalRange(value: unknown): value is SignalRange {
  return value === 'full' || value === 'legal' || value === 'unknown'
}

export function isLUTRole(value: unknown): value is LUTRole {
  return (
    value === 'display-look' ||
    value === 'scene-creative' ||
    value === 'technical-output' ||
    value === 'combined-look-output'
  )
}

export function resolveColorGamutId(value: unknown): ColorGamutId | undefined {
  if (typeof value !== 'string') return undefined
  return getColorGamut(value)?.id
}

export function resolveTransferFunctionId(
  value: unknown,
): TransferFunctionId | undefined {
  if (typeof value !== 'string') return undefined
  return getTransferFunction(value)?.id
}

export function hasDisplayLikeInput(selection: {
  inputGamut?: ColorGamutId
  inputTransfer?: TransferFunctionId
}): boolean {
  return Boolean(
    selection.inputGamut === 'srgb-rec709' &&
    selection.inputTransfer &&
    DISPLAY_LIKE_INPUT_TRANSFERS.has(selection.inputTransfer),
  )
}

function profileInputConflicts(
  profile: LUTColorProfile | undefined,
  selection: LUTContractSelection,
): LUTContractIssue[] {
  if (!profile) return []
  const issues: LUTContractIssue[] = []
  if (
    selection.inputGamut &&
    resolveColorGamutId(selection.inputGamut) !== profile.inputGamut
  ) {
    issues.push(issue('Input gamut conflicts with the input profile.'))
  }
  if (
    selection.inputTransfer &&
    resolveTransferFunctionId(selection.inputTransfer) !== profile.inputTransfer
  ) {
    issues.push(issue('Input transfer conflicts with the input profile.'))
  }
  return issues
}

function roleRequiresOutputContract(role: LUTRole): boolean {
  return role !== 'display-look'
}

function resolveInputProfileId(input: {
  inputProfile?: string
  inputGamut?: ColorGamutId
  inputTransfer?: TransferFunctionId
}): string | undefined {
  if (input.inputProfile) {
    const explicitProfile = getLUTColorProfile(input.inputProfile)
    if (explicitProfile) return explicitProfile.id
  }

  if (!input.inputGamut || !input.inputTransfer) return undefined

  const matches = TIER1_LUT_COLOR_PROFILES.filter(
    (profile) =>
      profile.inputGamut === input.inputGamut &&
      profile.inputTransfer === input.inputTransfer,
  )

  return matches.length === 1 ? matches[0]?.id : undefined
}

export function hasCompleteOutputContract(selection: {
  outputGamut?: ColorGamutId
  outputTransfer?: TransferFunctionId
  outputRange?: SignalRange
}): boolean {
  return Boolean(
    selection.outputGamut && selection.outputTransfer && selection.outputRange,
  )
}

function hasAnyOutputContractField(selection: {
  outputGamut?: ColorGamutId
  outputTransfer?: TransferFunctionId
  outputRange?: SignalRange
}): boolean {
  return Boolean(
    selection.outputGamut || selection.outputTransfer || selection.outputRange,
  )
}

/**
 * The contract a selection stores, or every reason it cannot be stored. An
 * input profile supplies the input gamut, transfer, and range the selection
 * leaves out and must agree with the ones it states.
 */
export function buildStoredContractSelection(
  selection: LUTContractSelection,
): LUTContractResult<StoredLUTContractSelection> {
  const issues: LUTContractIssue[] = []
  const role = isLUTRole(selection.role) ? selection.role : undefined
  if (!role) issues.push(issue('LUT role is unsupported.'))

  const profile = selection.inputProfile
    ? getLUTColorProfile(selection.inputProfile)
    : undefined
  issues.push(...profileInputConflicts(profile, selection))

  const inputGamut =
    profile?.inputGamut ?? resolveColorGamutId(selection.inputGamut)
  const inputTransfer =
    profile?.inputTransfer ?? resolveTransferFunctionId(selection.inputTransfer)
  const inputRange = selection.inputRange ?? profile?.inputRange
  const outputGamut = resolveColorGamutId(selection.outputGamut)
  const outputTransfer = resolveTransferFunctionId(selection.outputTransfer)
  const outputRange = selection.outputRange

  if (!inputGamut) {
    issues.push(
      issue(
        'Input gamut is missing or unsupported; name an input profile or gamut.',
      ),
    )
  }
  if (!inputTransfer) {
    issues.push(
      issue(
        'Input transfer is missing or unsupported; name an input profile or transfer.',
      ),
    )
  }
  if (!isSignalRange(inputRange)) {
    issues.push(
      issue(
        'Input range is missing or unsupported; name an input profile or range.',
      ),
    )
  }
  if (outputRange && !isSignalRange(outputRange)) {
    issues.push(issue('Output range is unsupported.'))
  }

  const output = { outputGamut, outputTransfer, outputRange }
  if (
    role === 'display-look' &&
    inputGamut &&
    inputTransfer &&
    !hasDisplayLikeInput({ inputGamut, inputTransfer })
  ) {
    issues.push(issue('Display-look LUT input must be display-like.'))
  }
  if (role && roleRequiresOutputContract(role)) {
    if (!hasCompleteOutputContract(output)) {
      issues.push(
        issue(`A ${role} LUT requires an output gamut, transfer, and range.`),
      )
    }
  } else if (
    role &&
    hasAnyOutputContractField(output) &&
    !hasCompleteOutputContract(output)
  ) {
    issues.push(
      issue(
        'A display-look output contract must be complete when any output field is given.',
      ),
    )
  }

  if (
    issues.length > 0 ||
    !role ||
    !inputGamut ||
    !inputTransfer ||
    !isSignalRange(inputRange)
  ) {
    return { ok: false, issues }
  }

  return {
    ok: true,
    value: {
      inputProfile: resolveInputProfileId({
        inputProfile: profile?.id,
        inputGamut,
        inputTransfer,
      }),
      role,
      inputGamut,
      inputTransfer,
      inputRange,
      outputGamut,
      outputTransfer,
      outputRange,
    },
  }
}

export function toLUTContractSelection(
  profile: LUTColorProfile,
): LUTContractSelection {
  return {
    inputProfile: profile.id,
    role: profile.role,
    inputGamut: profile.inputGamut,
    inputTransfer: profile.inputTransfer,
    inputRange: profile.inputRange,
    outputGamut: profile.outputGamut,
    outputTransfer: profile.outputTransfer,
    outputRange: profile.outputRange,
  }
}

export function contractToLUTColorProfile(
  id: string,
  contract: StoredLUTContractSelection,
): LUTColorProfile {
  const baseProfile = contract.inputProfile
    ? getLUTColorProfile(contract.inputProfile)
    : undefined

  return {
    id,
    label:
      baseProfile?.label ??
      `${contract.inputGamut} / ${contract.inputTransfer}`,
    aliases: baseProfile?.aliases ?? [],
    source: baseProfile?.source,
    role: contract.role,
    inputGamut: contract.inputGamut,
    inputTransfer: contract.inputTransfer,
    inputRange: contract.inputRange,
    outputGamut: contract.outputGamut,
    outputTransfer: contract.outputTransfer,
    outputRange: contract.outputRange,
  }
}

/**
 * The LUT color profile a stored contract confirms. Its ID is the contract's
 * input profile, canonicalized through the registry, or
 * `${inputGamut}-${inputTransfer}` when the contract names no input profile.
 */
export function storedContractToLUTColorProfile(
  contract: StoredLUTContractSelection,
): LUTColorProfile {
  const id =
    (contract.inputProfile
      ? getLUTColorProfile(contract.inputProfile)?.id
      : undefined) ??
    contract.inputProfile ??
    `${contract.inputGamut}-${contract.inputTransfer}`
  return contractToLUTColorProfile(id, contract)
}

function resolveRole(
  intent: unknown,
  hasCompleteOutput: boolean,
): LUTContractResult<LUTRole> {
  if (
    intent === 'monitoring' ||
    intent === 'calibration' ||
    intent === 'unknown' ||
    typeof intent !== 'string'
  ) {
    return { ok: false, issues: [issue('LUT intent is unsupported.')] }
  }

  if (intent === 'look') {
    return {
      ok: true,
      value: hasCompleteOutput ? 'combined-look-output' : 'scene-creative',
    }
  }

  if (isLUTRole(intent) && SUPPORTED_INTENT_ROLES.has(intent)) {
    return { ok: true, value: intent }
  }

  return { ok: false, issues: [issue('LUT intent is unsupported.')] }
}

function resolveGamut(
  value: string | undefined,
  label: string,
): LUTContractResult<ColorGamutId> {
  const gamut = resolveColorGamutId(value)

  if (!gamut) {
    return {
      ok: false,
      issues: [issue(`${label} gamut is missing or unsupported.`)],
    }
  }

  return { ok: true, value: gamut }
}

function resolveTransfer(
  value: string | undefined,
  label: string,
): LUTContractResult<TransferFunctionId> {
  const transfer = resolveTransferFunctionId(value)

  if (!transfer) {
    return {
      ok: false,
      issues: [issue(`${label} transfer is missing or unsupported.`)],
    }
  }

  return { ok: true, value: transfer }
}

function resolveRange(
  value: unknown,
  label: string,
): LUTContractResult<SignalRange> {
  if (value === undefined || value === null) {
    return { ok: true, value: 'full' }
  }

  if (isSignalRange(value)) {
    return { ok: true, value }
  }

  return {
    ok: false,
    issues: [issue(`${label} range is unsupported.`)],
  }
}

export function mapProfileLUTContract(
  lut: unknown,
): LUTContractResult<LUTContractSelection> {
  if (!isRecord(lut)) {
    return { ok: false, issues: [issue('LUT contract is missing.')] }
  }

  const input = readRecordField(lut, 'input')
  const output = readRecordField(lut, 'output')
  const inputGamutValue =
    readString(input, 'gamut') ?? readString(lut, 'inputGamut')
  const inputTransferValue =
    readString(input, 'transfer') ?? readString(lut, 'inputTransfer')
  const inputRangeValue = input?.range ?? lut.inputRange
  const outputGamutValue =
    readString(output, 'gamut') ?? readString(lut, 'outputGamut')
  const outputTransferValue =
    readString(output, 'transfer') ?? readString(lut, 'outputTransfer')
  const outputRangeValue = output?.range ?? lut.outputRange
  const hasCompleteOutput = Boolean(outputGamutValue && outputTransferValue)
  const issues: LUTContractIssue[] = []
  const role = resolveRole(lut.intent, hasCompleteOutput)

  if (!role.ok) issues.push(...role.issues)

  const inputGamut = resolveGamut(inputGamutValue, 'Input')
  if (!inputGamut.ok) issues.push(...inputGamut.issues)

  const inputTransfer = resolveTransfer(inputTransferValue, 'Input')
  if (!inputTransfer.ok) issues.push(...inputTransfer.issues)

  const inputRange = resolveRange(inputRangeValue, 'Input')
  if (!inputRange.ok) issues.push(...inputRange.issues)

  const outputGamut = resolveGamut(outputGamutValue, 'Output')
  const outputTransfer = resolveTransfer(outputTransferValue, 'Output')
  const outputRange = resolveRange(outputRangeValue, 'Output')
  let resolvedRole = role.ok ? role.value : undefined
  if (
    resolvedRole === 'display-look' &&
    hasCompleteOutput &&
    inputGamut.ok &&
    inputTransfer.ok &&
    !hasDisplayLikeInput({
      inputGamut: inputGamut.value,
      inputTransfer: inputTransfer.value,
    })
  ) {
    resolvedRole = 'combined-look-output'
  }
  const requiresOutput = resolvedRole !== 'display-look'
  const hasOutput =
    outputGamutValue || outputTransferValue || outputRangeValue !== undefined

  if (requiresOutput || hasOutput) {
    if (!outputGamut.ok) issues.push(...outputGamut.issues)
    if (!outputTransfer.ok) issues.push(...outputTransfer.issues)
    if (!outputRange.ok) issues.push(...outputRange.issues)
  }

  if (
    resolvedRole === 'display-look' &&
    inputGamut.ok &&
    inputTransfer.ok &&
    !hasDisplayLikeInput({
      inputGamut: inputGamut.value,
      inputTransfer: inputTransfer.value,
    })
  ) {
    issues.push(issue('Display-look LUT input must be display-like.'))
  }

  if (issues.length > 0) {
    return { ok: false, issues }
  }

  if (
    !role.ok ||
    !resolvedRole ||
    !inputGamut.ok ||
    !inputTransfer.ok ||
    !inputRange.ok
  ) {
    return {
      ok: false,
      issues: [issue('LUT contract is incomplete.')],
    }
  }

  return {
    ok: true,
    value: {
      inputProfile:
        inputGamut.ok && inputTransfer.ok
          ? resolveInputProfileId({
              inputGamut: inputGamut.value,
              inputTransfer: inputTransfer.value,
            })
          : undefined,
      role: resolvedRole,
      inputGamut: inputGamut.value,
      inputTransfer: inputTransfer.value,
      inputRange: inputRange.value,
      outputGamut: outputGamut.ok ? outputGamut.value : undefined,
      outputTransfer: outputTransfer.ok ? outputTransfer.value : undefined,
      outputRange: hasOutput && outputRange.ok ? outputRange.value : undefined,
    },
  }
}
