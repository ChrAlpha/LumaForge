import { readFile, stat } from 'node:fs/promises'
import { basename, resolve } from 'node:path'

import type {
  LUTColorProfile,
  LUTContractResolution,
  LUTContractSelection,
  LUTData,
  ParsedLUT,
  StoredLUTContractSelection,
} from '@lumaforge/luma-color-runtime'
import {
  buildStoredContractSelection,
  contractToLUTColorProfile,
  getLUTColorProfile,
  hasCompleteOutputContract,
  hasDisplayLikeInput,
  isLUTRole,
  isSupportedLUT,
  parseCubeLUT,
  resolveColorGamutId,
  resolveTransferFunctionId,
  resolveUnsupportedLUTOutputReason,
  toCompatInputProfile,
  toLUTData,
  validateLUT,
} from '@lumaforge/luma-color-runtime'
import type { LutLocalFileIdentity } from '@lumaforge/render-engine'
import { sha256Hex } from '@lumaforge/render-engine'
import { lutIdentityFromProfile } from '@lumaforge/render-engine/manifest'

import { LmfgError } from '../protocol/errors'
import type { LutContractInput, LutReference } from '../schemas/params'
import { LutContractInputSchema } from '../schemas/params'
import type {
  LutContractInferResult,
  LutContractValidateResult,
  LutInspectResult,
  LutProfileOutput,
  LutResolutionOutput,
} from '../schemas/results'

export type LoadedLutFile = {
  absolutePath: string
  filename: string
  byteSize: number
  sha256: string
  content: string
  parsed: ParsedLUT
}

export type ResolvedLut = {
  loaded: LoadedLutFile
  parsed: ParsedLUT
  profile: LUTColorProfile
  source: 'metadata' | 'params'
  lutData: LUTData
  identity: LutLocalFileIdentity
}

const INFER_ACTION = (path: string) => `lmfg lut contract infer --lut ${path}`
const VALIDATE_ACTION = (path: string) =>
  `lmfg lut contract validate --lut ${path} --contract <contract.json>`

export async function loadLutFile(
  path: string,
  cwd: string,
): Promise<LoadedLutFile> {
  const absolutePath = resolve(cwd, path)
  const filename = basename(absolutePath)
  if (!isSupportedLUT(filename)) {
    throw new LmfgError('args.invalid', {
      message: `Only .cube LUT files are supported: ${filename}`,
    })
  }
  try {
    if (!(await stat(absolutePath)).isFile()) {
      throw new LmfgError('args.invalid', {
        message: `LUT path is not a file: ${absolutePath}`,
      })
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new LmfgError('file.not_found', {
        message: `LUT file not found: ${absolutePath}`,
      })
    }
    throw error
  }
  const buffer = await readFile(absolutePath)
  const content = buffer.toString('utf8')
  let parsed: ParsedLUT
  try {
    parsed = parseCubeLUT(content, { sourceName: filename })
  } catch (error) {
    throw new LmfgError('lut.parse_failed', {
      message: `Failed to parse ${filename}: ${error instanceof Error ? error.message : String(error)}`,
      cause: error,
    })
  }
  return {
    absolutePath,
    filename,
    byteSize: buffer.byteLength,
    sha256: sha256Hex(
      new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength),
    ),
    content,
    parsed,
  }
}

export function profileToOutput(profile: LUTColorProfile): LutProfileOutput {
  return {
    profile_id: profile.id,
    label: profile.label,
    role: profile.role,
    input_gamut: profile.inputGamut,
    input_transfer: profile.inputTransfer,
    input_range: profile.inputRange,
    output_gamut: profile.outputGamut ?? null,
    output_transfer: profile.outputTransfer ?? null,
    output_range: profile.outputRange ?? null,
  }
}

export function profileToContractInput(
  profile: LUTColorProfile,
): LutContractInput {
  const registered = getLUTColorProfile(profile.id)
  return LutContractInputSchema.parse({
    role: profile.role,
    ...(registered ? { input_profile: registered.id } : {}),
    input_gamut: profile.inputGamut,
    input_transfer: profile.inputTransfer,
    input_range: profile.inputRange,
    ...(profile.outputGamut ? { output_gamut: profile.outputGamut } : {}),
    ...(profile.outputTransfer
      ? { output_transfer: profile.outputTransfer }
      : {}),
    ...(profile.outputRange ? { output_range: profile.outputRange } : {}),
  })
}

export function resolutionToOutput(
  resolution: LUTContractResolution,
): LutResolutionOutput {
  switch (resolution.kind) {
    case 'confirmed': {
      return {
        kind: 'confirmed',
        confidence: resolution.confidence,
        profile: profileToOutput(resolution.profile),
      }
    }
    case 'recommended':
    case 'unsupported-output': {
      return {
        kind: resolution.kind,
        recommendations: resolution.recommendations.map(profileToOutput),
      }
    }
    default: {
      return { kind: 'unknown' }
    }
  }
}

function contractInputToSelection(
  input: LutContractInput,
): LUTContractSelection {
  return {
    inputProfile: input.input_profile,
    role: input.role,
    inputGamut: resolveColorGamutId(input.input_gamut),
    inputTransfer: resolveTransferFunctionId(input.input_transfer),
    inputRange: input.input_range,
    outputGamut: resolveColorGamutId(input.output_gamut),
    outputTransfer: resolveTransferFunctionId(input.output_transfer),
    outputRange: input.output_range,
  }
}

function explainSelectionIssues(
  input: LutContractInput,
  selection: LUTContractSelection,
): string[] {
  const issues: string[] = []
  if (!isLUTRole(input.role))
    issues.push(`role "${input.role}" is not supported.`)
  const profile = input.input_profile
    ? getLUTColorProfile(input.input_profile)
    : undefined
  if (input.input_profile && !profile) {
    issues.push(
      `input_profile "${input.input_profile}" is not a known profile id.`,
    )
  }
  const inputGamut = profile?.inputGamut ?? selection.inputGamut
  const inputTransfer = profile?.inputTransfer ?? selection.inputTransfer
  if (!inputGamut) {
    issues.push(
      'input_gamut is missing or unsupported (set input_profile or input_gamut).',
    )
  }
  if (!inputTransfer) {
    issues.push(
      'input_transfer is missing or unsupported (set input_profile or input_transfer).',
    )
  }
  if (!profile && !input.input_range) {
    issues.push('input_range is required when input_profile is not given.')
  }
  if (
    input.input_gamut &&
    profile &&
    resolveColorGamutId(input.input_gamut) !== profile.inputGamut
  ) {
    issues.push('input_gamut conflicts with input_profile.')
  }
  if (
    input.input_transfer &&
    profile &&
    resolveTransferFunctionId(input.input_transfer) !== profile.inputTransfer
  ) {
    issues.push('input_transfer conflicts with input_profile.')
  }
  const outputComplete = hasCompleteOutputContract(selection)
  if (input.role !== 'display-look' && !outputComplete) {
    issues.push(
      `role "${input.role}" requires output_gamut, output_transfer and output_range.`,
    )
  }
  if (
    input.role === 'display-look' &&
    inputGamut &&
    inputTransfer &&
    !hasDisplayLikeInput({ inputGamut, inputTransfer })
  ) {
    issues.push(
      'display-look LUTs require a display-like input (srgb-rec709 with srgb, bt709 or gamma24).',
    )
  }
  if (
    input.role === 'display-look' &&
    (input.output_gamut || input.output_transfer || input.output_range) &&
    !outputComplete
  ) {
    issues.push(
      'display-look output contract must be complete when any output field is given.',
    )
  }
  return issues.length > 0
    ? issues
    : ['The contract is incomplete or inconsistent.']
}

export type AppliedContract =
  | { ok: true; parsed: ParsedLUT; profile: LUTColorProfile }
  | { ok: false; issues: string[] }

export function applyContractSelection(
  parsed: ParsedLUT,
  input: LutContractInput,
): AppliedContract {
  const selection = contractInputToSelection(input)
  const contract: StoredLUTContractSelection | undefined =
    buildStoredContractSelection(selection)
  if (!contract)
    return { ok: false, issues: explainSelectionIssues(input, selection) }
  const profileId =
    contract.inputProfile ?? `${contract.inputGamut}-${contract.inputTransfer}`
  const profile = contractToLUTColorProfile(profileId, contract)
  const profileResolution: LUTContractResolution = {
    kind: 'confirmed',
    confidence: 'user',
    profile,
  }
  return {
    ok: true,
    profile,
    parsed: {
      ...parsed,
      profileResolution,
      inputProfile: toCompatInputProfile(profileResolution),
    },
  }
}

export function toLutIdentity(
  loaded: LoadedLutFile,
  profile: LUTColorProfile,
): LutLocalFileIdentity {
  const result = lutIdentityFromProfile({
    filename: loaded.filename,
    sha256: loaded.sha256,
    profile,
    requireExplicitRange: true,
  })
  if (result.identity) return result.identity
  if (result.failure.code === 'output-transfer-missing') {
    throw new LmfgError('lut.contract.incomplete', {
      message: 'Choose a LUT output contract before rendering.',
      retryable: true,
      suggestedNextActions: [INFER_ACTION(loaded.absolutePath)],
    })
  }
  throw new LmfgError('lut.contract.incomplete', {
    message: result.failure.reason,
    retryable: true,
    suggestedNextActions: [VALIDATE_ACTION(loaded.absolutePath)],
  })
}

export function resolveLutContract(
  loaded: LoadedLutFile,
  contractInput?: LutContractInput,
): ResolvedLut {
  let parsed = loaded.parsed
  let profile: LUTColorProfile
  let source: ResolvedLut['source']
  if (contractInput) {
    const applied = applyContractSelection(loaded.parsed, contractInput)
    if (!applied.ok) {
      throw new LmfgError('lut.contract.invalid', {
        message: `LUT contract for ${loaded.filename} is invalid: ${applied.issues.join(' ')}`,
        retryable: true,
        suggestedNextActions: [INFER_ACTION(loaded.absolutePath)],
        details: { issues: applied.issues },
      })
    }
    parsed = applied.parsed
    profile = applied.profile
    source = 'params'
  } else {
    const resolution = loaded.parsed.profileResolution
    if (resolution.kind === 'confirmed') {
      profile = resolution.profile
      source = 'metadata'
    } else if (resolution.kind === 'unsupported-output') {
      throw new LmfgError('lut.contract.unsupported_output', {
        message: `${loaded.filename} declares an output space that cannot be rendered to sRGB JPEG.`,
        details: { resolution: resolutionToOutput(resolution) },
      })
    } else {
      throw new LmfgError('lut.contract.incomplete', {
        message: `${loaded.filename} has no confirmed color contract. Pass params.lut.contract (or --contract).`,
        retryable: true,
        suggestedNextActions: [INFER_ACTION(loaded.absolutePath)],
        details: { resolution: resolutionToOutput(resolution) },
      })
    }
  }
  const unsupportedReason = resolveUnsupportedLUTOutputReason(profile)
  if (unsupportedReason) {
    throw new LmfgError(
      /transfer is not supported/i.test(unsupportedReason)
        ? 'lut.contract.unsupported_output'
        : 'lut.contract.incomplete',
      {
        message: unsupportedReason,
        retryable: true,
        suggestedNextActions: [VALIDATE_ACTION(loaded.absolutePath)],
      },
    )
  }
  const identity = toLutIdentity(loaded, profile)
  return {
    loaded,
    parsed,
    profile,
    source,
    lutData: toLUTData(parsed),
    identity,
  }
}

export async function resolveLutForParams(
  reference: LutReference | null,
  cwd: string,
): Promise<ResolvedLut | null> {
  if (!reference) return null
  const loaded = await loadLutFile(reference.path, cwd)
  return resolveLutContract(loaded, reference.contract)
}

export function inspectLut(loaded: LoadedLutFile): LutInspectResult {
  const validation = validateLUT(loaded.parsed)
  return {
    path: loaded.absolutePath,
    filename: loaded.filename,
    sha256: loaded.sha256,
    byte_size: loaded.byteSize,
    title: loaded.parsed.title,
    size: loaded.parsed.size,
    domain_min: loaded.parsed.domainMin,
    domain_max: loaded.parsed.domainMax,
    comments: loaded.parsed.comments,
    fingerprint: loaded.parsed.fingerprint,
    valid: validation.valid,
    validation_errors: validation.errors,
    resolution: resolutionToOutput(loaded.parsed.profileResolution),
  }
}

export function inferContract(loaded: LoadedLutFile): LutContractInferResult {
  const resolution = loaded.parsed.profileResolution
  const base = {
    path: loaded.absolutePath,
    sha256: loaded.sha256,
    resolution: resolutionToOutput(resolution),
  }
  if (resolution.kind === 'confirmed') {
    const contract = profileToContractInput(resolution.profile)
    return {
      ...base,
      complete: true,
      contract,
      suggested_contracts: [contract],
      message: `Contract confirmed from ${resolution.confidence} metadata.`,
    }
  }
  if (resolution.kind === 'recommended') {
    return {
      ...base,
      complete: false,
      contract: null,
      suggested_contracts: resolution.recommendations.map(
        profileToContractInput,
      ),
      message:
        'Pass one of suggested_contracts as params.lut.contract (or --contract) after confirming the camera log profile.',
    }
  }
  if (resolution.kind === 'unsupported-output') {
    return {
      ...base,
      complete: false,
      contract: null,
      suggested_contracts: resolution.recommendations.map(
        profileToContractInput,
      ),
      message:
        'This LUT appears to target a log/technical output space; only display-referred outputs can be exported.',
    }
  }
  return {
    ...base,
    complete: false,
    contract: null,
    suggested_contracts: [],
    message: 'No profile hints were found; specify the contract explicitly.',
  }
}

export function validateContract(
  loaded: LoadedLutFile,
  input: LutContractInput,
): LutContractValidateResult {
  const applied = applyContractSelection(loaded.parsed, input)
  if (!applied.ok) {
    return {
      path: loaded.absolutePath,
      sha256: loaded.sha256,
      valid: false,
      issues: applied.issues,
      contract: input,
      profile: null,
      export_supported: false,
      export_reason: applied.issues[0] ?? null,
    }
  }
  let exportReason: string | null =
    resolveUnsupportedLUTOutputReason(applied.profile) ?? null
  if (!exportReason) {
    try {
      toLutIdentity(loaded, applied.profile)
    } catch (error) {
      exportReason = error instanceof Error ? error.message : String(error)
    }
  }
  return {
    path: loaded.absolutePath,
    sha256: loaded.sha256,
    valid: true,
    issues: [],
    contract: profileToContractInput(applied.profile),
    profile: profileToOutput(applied.profile),
    export_supported: exportReason === null,
    export_reason: exportReason,
  }
}

/**
 * Rebuild the contract selection recorded in a manifest LUT identity so a
 * replay resolves exactly the same effective color contract.
 */
export type EffectiveLutRanges = {
  input_range?: string
  output_range?: string
}

function replayRange(
  recorded: string,
  effective: string | undefined,
  label: 'input' | 'output',
): 'full' | 'legal' {
  if (recorded === 'full' || recorded === 'legal') return recorded
  if (effective === 'full' || effective === 'legal') return effective
  throw new LmfgError('lut.contract.incomplete', {
    message: `The manifest records an unspecified LUT ${label} range and no effective range to replay; re-export with an explicit contract.`,
  })
}

export function contractInputFromIdentity(
  identity: LutLocalFileIdentity,
  effective: EffectiveLutRanges = {},
): LutContractInput {
  return LutContractInputSchema.parse({
    role: identity.output_contract.role ?? 'combined-look-output',
    input_gamut: identity.input_contract.gamut,
    input_transfer: identity.input_contract.transfer,
    input_range: replayRange(
      identity.input_contract.range,
      effective.input_range,
      'input',
    ),
    output_gamut: identity.output_contract.gamut,
    output_transfer: identity.output_contract.transfer,
    output_range: replayRange(
      identity.output_contract.range,
      effective.output_range,
      'output',
    ),
  })
}
