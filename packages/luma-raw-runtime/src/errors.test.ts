import { describe, expect, it } from 'vitest'

import type { LumaRawErrorCode } from './errors'
import { LumaRawRuntimeError, normalizeRawRuntimeError } from './errors'

describe('normalizeRawRuntimeError', () => {
  it.each([
    'RAW_JOB_CANCELLED',
    'RAW_MEMORY_LIMIT',
    'RAW_WORKER_PROTOCOL_ERROR',
    'RAW_UNSUPPORTED_FORMAT',
    'RAW_RUNTIME_UNAVAILABLE',
  ] satisfies LumaRawErrorCode[])(
    'keeps an existing %s error over the fallback code',
    (code) => {
      const error = new LumaRawRuntimeError(code, `${code} failure`)

      const normalized = normalizeRawRuntimeError(
        error,
        'RAW_WINDOW_READ_FAILED',
      )

      expect(normalized).toBe(error)
      expect(normalized.code).toBe(code)
    },
  )

  it('wraps an Error with the fallback code, message, and cause', () => {
    const cause = new TypeError(
      'Native RAW processed-window returned invalid stride.',
    )

    const normalized = normalizeRawRuntimeError(cause, 'RAW_WINDOW_READ_FAILED')

    expect(normalized).toBeInstanceOf(LumaRawRuntimeError)
    expect(normalized.name).toBe('LumaRawRuntimeError')
    expect(normalized.code).toBe('RAW_WINDOW_READ_FAILED')
    expect(normalized.message).toBe(cause.message)
    expect(normalized.cause).toBe(cause)
  })

  it('classifies a native calibration throw with the calibration fallback', () => {
    const cause = new Error('native calibration rejected the matrix')

    const normalized = normalizeRawRuntimeError(cause, 'RAW_CALIBRATION_FAILED')

    expect(normalized.code).toBe('RAW_CALIBRATION_FAILED')
    expect(normalized.message).toBe(cause.message)
    expect(normalized.cause).toBe(cause)
  })

  it.each([
    ['a string', 'native abort'],
    ['undefined', undefined],
    ['null', null],
    ['a plain object', { message: 'not an Error' }],
  ])(
    'wraps a non-Error throw (%s) with a generic message',
    (_label, thrown) => {
      const normalized = normalizeRawRuntimeError(
        thrown,
        'RAW_HQ_DECODE_FAILED',
      )

      expect(normalized.code).toBe('RAW_HQ_DECODE_FAILED')
      expect(normalized.message).toBe('RAW runtime request failed.')
      expect(normalized.cause).toBe(thrown)
    },
  )
})
