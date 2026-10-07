import type { LumaRawErrorCode } from '@lumaforge/luma-raw-runtime'
import { LumaRawRuntimeError } from '@lumaforge/luma-raw-runtime'
import { ZodError } from 'zod'

import type { ExitCode } from './exit-codes'
import { EXIT_CODES } from './exit-codes'

export type LmfgErrorCode =
  | 'args.invalid'
  | 'schema.invalid'
  | 'file.not_found'
  | 'session.not_found'
  | 'iteration.not_found'
  | 'candidate.not_found'
  | 'source.unsupported'
  | 'source.export_unsupported'
  | 'tier.unavailable'
  | 'runtime.unavailable'
  | 'lut.parse_failed'
  | 'lut.contract.incomplete'
  | 'lut.contract.unsupported_output'
  | 'lut.contract.invalid'
  | 'permission.denied'
  | 'network.not_allowed'
  | 'fetch.failed'
  | 'hash.mismatch'
  | 'render.failed'
  | 'export.refused'
  | 'replay.mismatch'
  | 'cancelled'
  | 'timeout'
  | 'manifest.invalid'
  | 'internal'

const EXIT_BY_CODE: Record<LmfgErrorCode, ExitCode> = {
  'args.invalid': EXIT_CODES.invalidArguments,
  'schema.invalid': EXIT_CODES.invalidArguments,
  'file.not_found': EXIT_CODES.invalidArguments,
  'session.not_found': EXIT_CODES.invalidArguments,
  'iteration.not_found': EXIT_CODES.invalidArguments,
  'candidate.not_found': EXIT_CODES.invalidArguments,
  'lut.parse_failed': EXIT_CODES.invalidArguments,
  'source.unsupported': EXIT_CODES.unsupported,
  'source.export_unsupported': EXIT_CODES.unsupported,
  'tier.unavailable': EXIT_CODES.unsupported,
  'runtime.unavailable': EXIT_CODES.unsupported,
  'lut.contract.incomplete': EXIT_CODES.lutContract,
  'lut.contract.unsupported_output': EXIT_CODES.lutContract,
  'lut.contract.invalid': EXIT_CODES.lutContract,
  'permission.denied': EXIT_CODES.permission,
  'network.not_allowed': EXIT_CODES.permission,
  'fetch.failed': EXIT_CODES.fetch,
  'hash.mismatch': EXIT_CODES.fetch,
  'render.failed': EXIT_CODES.render,
  'export.refused': EXIT_CODES.exportRefused,
  'replay.mismatch': EXIT_CODES.exportRefused,
  cancelled: EXIT_CODES.cancelled,
  timeout: EXIT_CODES.cancelled,
  'manifest.invalid': EXIT_CODES.failure,
  internal: EXIT_CODES.internal,
}

export type LmfgErrorInit = {
  message: string
  retryable?: boolean
  suggestedNextActions?: readonly string[]
  details?: Record<string, unknown>
  cause?: unknown
}

export type ErrorEnvelope = {
  schema: 'lmfg.error.v1'
  ok: false
  error: {
    code: LmfgErrorCode
    message: string
    retryable: boolean
    suggested_next_actions: string[]
    details?: Record<string, unknown>
  }
}

export class LmfgError extends Error {
  readonly code: LmfgErrorCode
  readonly exitCode: ExitCode
  readonly retryable: boolean
  readonly suggestedNextActions: string[]
  readonly details?: Record<string, unknown>

  constructor(code: LmfgErrorCode, init: LmfgErrorInit) {
    super(
      init.message,
      init.cause === undefined ? undefined : { cause: init.cause },
    )
    this.name = 'LmfgError'
    this.code = code
    this.exitCode = EXIT_BY_CODE[code]
    this.retryable = init.retryable ?? false
    this.suggestedNextActions = [...(init.suggestedNextActions ?? [])]
    this.details = init.details
  }

  toEnvelope(): ErrorEnvelope {
    return {
      schema: 'lmfg.error.v1',
      ok: false,
      error: {
        code: this.code,
        message: this.message,
        retryable: this.retryable,
        suggested_next_actions: this.suggestedNextActions,
        ...(this.details ? { details: this.details } : {}),
      },
    }
  }
}

// Every runtime code maps explicitly; a code from a newer runtime build that is
// not listed falls back to internal and keeps the code in details.runtime_code.
const RAW_CODE_MAP: Readonly<Record<string, LmfgErrorCode | undefined>> = {
  RAW_RUNTIME_UNAVAILABLE: 'runtime.unavailable',
  RAW_CROSS_ORIGIN_ISOLATION_REQUIRED: 'runtime.unavailable',
  RAW_UNSUPPORTED_FORMAT: 'source.unsupported',
  RAW_OPEN_FAILED: 'source.unsupported',
  RAW_METADATA_FAILED: 'source.unsupported',
  RAW_THUMBNAIL_UNAVAILABLE: 'render.failed',
  RAW_QUICK_DECODE_FAILED: 'render.failed',
  RAW_HQ_DECODE_FAILED: 'render.failed',
  RAW_WINDOW_READ_FAILED: 'render.failed',
  RAW_MEMORY_LIMIT: 'render.failed',
  RAW_JOB_CANCELLED: 'cancelled',
  RAW_WORKER_PROTOCOL_ERROR: 'internal',
} satisfies Record<LumaRawErrorCode, LmfgErrorCode>

const MESSAGE_CODE_MAP: Array<[pattern: RegExp, code: LmfgErrorCode]> = [
  [/^FULL_RES_EXPORT_UNSUPPORTED_SOURCE$/, 'source.export_unsupported'],
  [/^FULL_RES_EXPORT_UNSUPPORTED_PIPELINE$/, 'lut.contract.incomplete'],
  [/^FULL_RES_EXPORT_CANCELLED$/, 'cancelled'],
  [/^CANDIDATE_RENDER_ABORTED$/, 'cancelled'],
  [/^FULL_RES_EXPORT_RESOURCE_FAILURE$/, 'render.failed'],
  [/^JPEG_/, 'render.failed'],
  [/^LUMA_JPEG_/, 'render.failed'],
  [/^PREVIEW_JPEG_ENCODE_/, 'render.failed'],
  [/^CONTACT_SHEET_/, 'render.failed'],
]

export function toLmfgError(error: unknown): LmfgError {
  if (error instanceof LmfgError) return error
  if (error instanceof ZodError) {
    return new LmfgError('schema.invalid', {
      message: 'Input failed schema validation.',
      details: {
        issues: error.issues.map((issue) => ({
          path: issue.path.map(String).join('.'),
          message: issue.message,
          code: issue.code,
        })),
      },
      cause: error,
    })
  }
  if (error instanceof LumaRawRuntimeError) {
    const code = RAW_CODE_MAP[error.code] ?? 'internal'
    return new LmfgError(code, {
      message: error.message,
      retryable: code === 'render.failed',
      details: { runtime_code: error.code },
      cause: error,
    })
  }
  if (error instanceof Error) {
    if (error.name === 'AbortError' || error.name === 'TimeoutError') {
      return new LmfgError('cancelled', {
        message: error.message || 'Operation was cancelled.',
        cause: error,
      })
    }
    for (const [pattern, code] of MESSAGE_CODE_MAP) {
      if (pattern.test(error.message)) {
        return new LmfgError(code, {
          message: error.message,
          retryable: code === 'render.failed',
          cause: error,
        })
      }
    }
    const errno = (error as NodeJS.ErrnoException).code
    if (errno === 'ENOENT') {
      return new LmfgError('file.not_found', {
        message: error.message,
        cause: error,
      })
    }
    if (errno === 'EACCES' || errno === 'EPERM') {
      return new LmfgError('permission.denied', {
        message: error.message,
        cause: error,
      })
    }
    return new LmfgError('internal', {
      message: error.message || 'Internal error.',
      cause: error,
    })
  }
  return new LmfgError('internal', {
    message: typeof error === 'string' ? error : 'Internal error.',
    cause: error,
  })
}

/** The cleanup steps that run after an operation failed or was refused. */
export const CLEANUP_STEPS = [
  'abort_jpeg_encoder',
  'dispose_jpeg_runtime',
  'close_temp_file',
  'remove_temp_file',
  'end_processed_window_export',
] as const

export type CleanupStep = (typeof CLEANUP_STEPS)[number]

/**
 * A cleanup step that did not finish: the step, the code its error maps to,
 * and the filesystem errno when there is one. The error message stays out
 * because it can carry local paths. A failed `remove_temp_file` means the
 * temp file may still exist.
 */
export type CleanupFailure = {
  step: CleanupStep
  code: LmfgErrorCode
  errno?: string
}

/** At most this many cleanup failures are listed in one error. */
export const MAX_CLEANUP_FAILURES = 8

const ERRNO_PATTERN = /^E[A-Z0-9]{1,15}$/

export function cleanupFailure(
  step: CleanupStep,
  error: unknown,
): CleanupFailure {
  const errno =
    error instanceof Error && !(error instanceof LmfgError)
      ? (error as NodeJS.ErrnoException).code
      : undefined
  return {
    step,
    code: toLmfgError(error).code,
    ...(typeof errno === 'string' && ERRNO_PATTERN.test(errno)
      ? { errno }
      : {}),
  }
}

/**
 * Runs one cleanup step and records its failure in `failures` instead of
 * throwing it; resolves whether the step finished.
 */
export async function attemptCleanup(
  failures: CleanupFailure[],
  step: CleanupStep,
  cleanup: () => unknown,
): Promise<boolean> {
  try {
    await cleanup()
    return true
  } catch (error) {
    failures.push(cleanupFailure(step, error))
    return false
  }
}

/**
 * How a result or an error lists cleanup failures: at most
 * `MAX_CLEANUP_FAILURES` under `cleanup_failures`, the rest counted in
 * `cleanup_failures_omitted`, and neither field when nothing failed.
 */
export function cleanupFailureFields(failures: readonly CleanupFailure[]): {
  cleanup_failures?: CleanupFailure[]
  cleanup_failures_omitted?: number
} {
  if (failures.length === 0) return {}
  const omitted = failures.length - MAX_CLEANUP_FAILURES
  return {
    cleanup_failures: failures.slice(0, MAX_CLEANUP_FAILURES),
    ...(omitted > 0 ? { cleanup_failures_omitted: omitted } : {}),
  }
}

/** Every cleanup failure an error carries, including those not listed. */
const allCleanupFailures = new WeakMap<LmfgError, readonly CleanupFailure[]>()

/** The cleanup failures an error already reports. */
export function cleanupFailuresOf(error: unknown): readonly CleanupFailure[] {
  if (!(error instanceof LmfgError)) return []
  const known = allCleanupFailures.get(error)
  if (known) return known
  const reported = error.details?.cleanup_failures
  return Array.isArray(reported) ? (reported as CleanupFailure[]) : []
}

/**
 * Keeps `primary` as the failure an operation reports and lists the cleanup
 * failures that followed it under `details.cleanup_failures`: the code,
 * message, retryability and exit code stay the primary's. Each failure is
 * listed once, bounded as `cleanupFailureFields` bounds them. Without a new
 * failure `primary` comes back unchanged.
 */
export function withCleanupFailures(
  primary: unknown,
  failures: readonly CleanupFailure[],
): unknown {
  const reported = cleanupFailuresOf(primary)
  const added = failures.filter((failure) => !reported.includes(failure))
  if (added.length === 0) return primary
  const base = toLmfgError(primary)
  const all = [...reported, ...added]
  const {
    cleanup_failures: _listed,
    cleanup_failures_omitted: _omitted,
    ...details
  } = base.details ?? {}
  const combined = new LmfgError(base.code, {
    message: base.message,
    retryable: base.retryable,
    suggestedNextActions: base.suggestedNextActions,
    details: { ...details, ...cleanupFailureFields(all) },
    cause: primary,
  })
  allCleanupFailures.set(combined, all)
  return combined
}
