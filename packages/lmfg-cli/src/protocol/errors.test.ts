// @vitest-environment node
import { LumaRawRuntimeError } from '@lumaforge/luma-raw-runtime'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { LmfgError, toLmfgError } from './errors'
import { EXIT_CODES } from './exit-codes'

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
