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

const RAW_CODE_MAP: Record<string, LmfgErrorCode> = {
  RAW_RUNTIME_UNAVAILABLE: 'runtime.unavailable',
  RAW_CROSS_ORIGIN_ISOLATION_REQUIRED: 'runtime.unavailable',
  RAW_UNSUPPORTED_FORMAT: 'source.unsupported',
  RAW_OPEN_FAILED: 'source.unsupported',
  RAW_METADATA_FAILED: 'source.unsupported',
  RAW_THUMBNAIL_UNAVAILABLE: 'render.failed',
  RAW_QUICK_DECODE_FAILED: 'render.failed',
  RAW_HQ_DECODE_FAILED: 'render.failed',
  RAW_MEMORY_LIMIT: 'render.failed',
  RAW_JOB_CANCELLED: 'cancelled',
  RAW_WORKER_PROTOCOL_ERROR: 'internal',
}

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
