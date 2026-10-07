export type LumaRawErrorCode =
  | 'RAW_RUNTIME_UNAVAILABLE'
  | 'RAW_CROSS_ORIGIN_ISOLATION_REQUIRED'
  | 'RAW_UNSUPPORTED_FORMAT'
  | 'RAW_OPEN_FAILED'
  | 'RAW_METADATA_FAILED'
  | 'RAW_THUMBNAIL_UNAVAILABLE'
  | 'RAW_QUICK_DECODE_FAILED'
  | 'RAW_HQ_DECODE_FAILED'
  | 'RAW_WINDOW_READ_FAILED'
  | 'RAW_MEMORY_LIMIT'
  | 'RAW_JOB_CANCELLED'
  | 'RAW_WORKER_PROTOCOL_ERROR'

export class LumaRawRuntimeError extends Error {
  readonly code: LumaRawErrorCode

  constructor(code: LumaRawErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'LumaRawRuntimeError'
    this.code = code
  }
}

export function normalizeRawRuntimeError(
  error: unknown,
  fallbackCode: LumaRawErrorCode,
): LumaRawRuntimeError {
  if (error instanceof LumaRawRuntimeError) {
    return error
  }

  const message =
    error instanceof Error ? error.message : 'RAW runtime request failed.'

  return new LumaRawRuntimeError(fallbackCode, message, {
    cause: error,
  })
}
