// @vitest-environment node
import type { LumaRawErrorCode } from '@lumaforge/luma-raw-runtime'
import { LumaRawRuntimeError } from '@lumaforge/luma-raw-runtime'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import type { LmfgErrorCode } from './errors'
import { LmfgError, toLmfgError } from './errors'
import type { ExitCode } from './exit-codes'
import { EXIT_CODES } from './exit-codes'

type RawMapping = {
  code: LmfgErrorCode
  exitCode: ExitCode
  retryable: boolean
}

// Every runtime code needs a row: a new code fails typecheck until it is mapped.
const RAW_MAPPINGS = {
  RAW_RUNTIME_UNAVAILABLE: {
    code: 'runtime.unavailable',
    exitCode: EXIT_CODES.unsupported,
    retryable: false,
  },
  RAW_CROSS_ORIGIN_ISOLATION_REQUIRED: {
    code: 'runtime.unavailable',
    exitCode: EXIT_CODES.unsupported,
    retryable: false,
  },
  RAW_UNSUPPORTED_FORMAT: {
    code: 'source.unsupported',
    exitCode: EXIT_CODES.unsupported,
    retryable: false,
  },
  RAW_OPEN_FAILED: {
    code: 'source.unsupported',
    exitCode: EXIT_CODES.unsupported,
    retryable: false,
  },
  RAW_METADATA_FAILED: {
    code: 'source.unsupported',
    exitCode: EXIT_CODES.unsupported,
    retryable: false,
  },
  RAW_THUMBNAIL_UNAVAILABLE: {
    code: 'render.failed',
    exitCode: EXIT_CODES.render,
    retryable: true,
  },
  RAW_QUICK_DECODE_FAILED: {
    code: 'render.failed',
    exitCode: EXIT_CODES.render,
    retryable: true,
  },
  RAW_HQ_DECODE_FAILED: {
    code: 'render.failed',
    exitCode: EXIT_CODES.render,
    retryable: true,
  },
  RAW_WINDOW_READ_FAILED: {
    code: 'render.failed',
    exitCode: EXIT_CODES.render,
    retryable: true,
  },
  RAW_MEMORY_LIMIT: {
    code: 'render.failed',
    exitCode: EXIT_CODES.render,
    retryable: true,
  },
  RAW_JOB_CANCELLED: {
    code: 'cancelled',
    exitCode: EXIT_CODES.cancelled,
    retryable: false,
  },
  RAW_WORKER_PROTOCOL_ERROR: {
    code: 'internal',
    exitCode: EXIT_CODES.internal,
    retryable: false,
  },
} as const satisfies Record<LumaRawErrorCode, RawMapping>

describe('lmfgError', () => {
  it('maps codes to spec exit codes', () => {
    expect(new LmfgError('args.invalid', { message: 'x' }).exitCode).toBe(
      EXIT_CODES.invalidArguments,
    )
    expect(new LmfgError('source.unsupported', { message: 'x' }).exitCode).toBe(
      EXIT_CODES.unsupported,
    )
    expect(
      new LmfgError('lut.contract.incomplete', { message: 'x' }).exitCode,
    ).toBe(EXIT_CODES.lutContract)
    expect(new LmfgError('export.refused', { message: 'x' }).exitCode).toBe(
      EXIT_CODES.exportRefused,
    )
    expect(new LmfgError('replay.mismatch', { message: 'x' }).exitCode).toBe(8)
    expect(new LmfgError('cancelled', { message: 'x' }).exitCode).toBe(
      EXIT_CODES.cancelled,
    )
    expect(new LmfgError('internal', { message: 'x' }).exitCode).toBe(
      EXIT_CODES.internal,
    )
  })

  it('serializes to the error envelope', () => {
    const error = new LmfgError('lut.contract.incomplete', {
      message: 'LUT contract is incomplete.',
      retryable: true,
      suggestedNextActions: ['lmfg lut contract infer --lut look.cube'],
      details: { resolution: 'recommended' },
    })
    expect(error.toEnvelope()).toEqual({
      schema: 'lmfg.error.v1',
      ok: false,
      error: {
        code: 'lut.contract.incomplete',
        message: 'LUT contract is incomplete.',
        retryable: true,
        suggested_next_actions: ['lmfg lut contract infer --lut look.cube'],
        details: { resolution: 'recommended' },
      },
    })
  })
})

describe('toLmfgError', () => {
  it('passes LmfgError through', () => {
    const error = new LmfgError('render.failed', { message: 'boom' })
    expect(toLmfgError(error)).toBe(error)
  })

  it('maps zod errors to schema.invalid with issue details', () => {
    const result = z.object({ a: z.number() }).safeParse({ a: 'x' })
    const error = toLmfgError(result.error)
    expect(error.code).toBe('schema.invalid')
    expect(error.exitCode).toBe(2)
    expect(error.details?.issues).toBeInstanceOf(Array)
  })

  it.each(Object.entries(RAW_MAPPINGS) as [LumaRawErrorCode, RawMapping][])(
    'maps RAW runtime code %s',
    (runtimeCode, expected) => {
      const cause = new LumaRawRuntimeError(runtimeCode, 'runtime said no')
      const error = toLmfgError(cause)
      expect({
        code: error.code,
        exitCode: error.exitCode,
        retryable: error.retryable,
      }).toEqual(expected)
      expect(error.message).toBe('runtime said no')
      expect(error.cause).toBe(cause)
      expect(error.details).toEqual({ runtime_code: runtimeCode })
      expect(error.suggestedNextActions).toEqual([])
    },
  )

  it('serializes a RAW window read failure as a retryable render failure', () => {
    const error = toLmfgError(
      new LumaRawRuntimeError(
        'RAW_WINDOW_READ_FAILED',
        'Processed window read failed.',
      ),
    )
    expect(error.exitCode).toBe(7)
    expect(error.toEnvelope()).toEqual({
      schema: 'lmfg.error.v1',
      ok: false,
      error: {
        code: 'render.failed',
        message: 'Processed window read failed.',
        retryable: true,
        suggested_next_actions: [],
        details: { runtime_code: 'RAW_WINDOW_READ_FAILED' },
      },
    })
  })

  it('maps RAW codes from a newer runtime to internal and keeps the code', () => {
    const cause = new LumaRawRuntimeError(
      'RAW_FUTURE_FAILURE' as LumaRawErrorCode,
      'unknown runtime failure',
    )
    const error = toLmfgError(cause)
    expect(error.code).toBe('internal')
    expect(error.exitCode).toBe(EXIT_CODES.internal)
    expect(error.retryable).toBe(false)
    expect(error.details).toEqual({ runtime_code: 'RAW_FUTURE_FAILURE' })
  })

  it('maps RAW runtime errors', () => {
    expect(
      toLmfgError(new LumaRawRuntimeError('RAW_UNSUPPORTED_FORMAT', 'nope'))
        .code,
    ).toBe('source.unsupported')
    expect(
      toLmfgError(new LumaRawRuntimeError('RAW_JOB_CANCELLED', 'nope')).code,
    ).toBe('cancelled')
    expect(
      toLmfgError(new LumaRawRuntimeError('RAW_MEMORY_LIMIT', 'nope')).code,
    ).toBe('render.failed')
    expect(
      toLmfgError(new LumaRawRuntimeError('RAW_WINDOW_READ_FAILED', 'nope'))
        .code,
    ).toBe('render.failed')
    expect(
      toLmfgError(new LumaRawRuntimeError('RAW_RUNTIME_UNAVAILABLE', 'nope'))
        .code,
    ).toBe('runtime.unavailable')
  })

  it('maps engine sentinel messages and abort errors', () => {
    expect(
      toLmfgError(new Error('FULL_RES_EXPORT_UNSUPPORTED_SOURCE')).code,
    ).toBe('source.export_unsupported')
    expect(
      toLmfgError(new Error('FULL_RES_EXPORT_UNSUPPORTED_PIPELINE')).code,
    ).toBe('lut.contract.incomplete')
    expect(toLmfgError(new Error('FULL_RES_EXPORT_CANCELLED')).code).toBe(
      'cancelled',
    )
    expect(
      toLmfgError(new Error('FULL_RES_EXPORT_RESOURCE_FAILURE')).code,
    ).toBe('render.failed')
    const abort = new Error('aborted')
    abort.name = 'AbortError'
    expect(toLmfgError(abort).code).toBe('cancelled')
    expect(toLmfgError('weird').code).toBe('internal')
  })
})
