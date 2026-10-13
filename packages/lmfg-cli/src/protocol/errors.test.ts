// @vitest-environment node
import type { LumaRawErrorCode } from '@lumaforge/luma-raw-runtime'
import { LumaRawRuntimeError } from '@lumaforge/luma-raw-runtime'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import type { CleanupFailure, LmfgErrorCode } from './errors'
import {
  attemptCleanup,
  cleanupFailure,
  cleanupFailureFields,
  cleanupFailuresOf,
  LmfgError,
  MAX_CLEANUP_FAILURES,
  toLmfgError,
  withCleanupFailures,
} from './errors'
import type { ExitCode } from './exit-codes'
import { EXIT_CODES } from './exit-codes'

type RawMapping = {
  code: LmfgErrorCode
  exitCode: ExitCode
  retryable: boolean
}

// The expected taxonomy, written out independently of the CLI's own map and
// exit table: every runtime code needs exactly one row, so a code the runtime
// adds or drops fails typecheck until this table follows it.
const RAW_MAPPINGS = {
  RAW_RUNTIME_UNAVAILABLE: {
    code: 'runtime.unavailable',
    exitCode: 3,
    retryable: false,
  },
  RAW_CROSS_ORIGIN_ISOLATION_REQUIRED: {
    code: 'runtime.unavailable',
    exitCode: 3,
    retryable: false,
  },
  RAW_UNSUPPORTED_FORMAT: {
    code: 'source.unsupported',
    exitCode: 3,
    retryable: false,
  },
  RAW_OPEN_FAILED: {
    code: 'source.unsupported',
    exitCode: 3,
    retryable: false,
  },
  RAW_METADATA_FAILED: {
    code: 'source.unsupported',
    exitCode: 3,
    retryable: false,
  },
  RAW_THUMBNAIL_UNAVAILABLE: {
    code: 'render.failed',
    exitCode: 7,
    retryable: true,
  },
  RAW_QUICK_DECODE_FAILED: {
    code: 'render.failed',
    exitCode: 7,
    retryable: true,
  },
  RAW_HQ_DECODE_FAILED: {
    code: 'render.failed',
    exitCode: 7,
    retryable: true,
  },
  RAW_WINDOW_READ_FAILED: {
    code: 'render.failed',
    exitCode: 7,
    retryable: true,
  },
  RAW_CALIBRATION_FAILED: {
    code: 'render.failed',
    exitCode: 7,
    retryable: true,
  },
  RAW_MEMORY_LIMIT: {
    code: 'render.failed',
    exitCode: 7,
    retryable: true,
  },
  RAW_JOB_CANCELLED: {
    code: 'cancelled',
    exitCode: 9,
    retryable: false,
  },
  RAW_WORKER_PROTOCOL_ERROR: {
    code: 'internal',
    exitCode: 10,
    retryable: false,
  },
} as const satisfies Record<LumaRawErrorCode, RawMapping>

const RAW_MAPPING_ROWS = Object.entries(RAW_MAPPINGS) as [
  LumaRawErrorCode,
  RawMapping,
][]

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

  it.each(RAW_MAPPING_ROWS)(
    'maps RAW runtime code %s through the error envelope',
    (runtimeCode, expected) => {
      const cause = new LumaRawRuntimeError(runtimeCode, 'runtime said no')
      const error = toLmfgError(cause)
      expect({
        code: error.code,
        exitCode: error.exitCode,
        retryable: error.retryable,
      }).toEqual(expected)
      expect(error.cause).toBe(cause)
      expect(error.toEnvelope()).toEqual({
        schema: 'lmfg.error.v1',
        ok: false,
        error: {
          code: expected.code,
          message: 'runtime said no',
          retryable: expected.retryable,
          suggested_next_actions: [],
          details: { runtime_code: runtimeCode },
        },
      })
    },
  )

  it('classifies a cleanup step that fails with a RAW code', () => {
    const failure = cleanupFailure(
      'end_processed_window_export',
      new LumaRawRuntimeError('RAW_MEMORY_LIMIT', 'cleanup said no'),
    )
    // A runtime error carries no errno, and its message stays out.
    expect(failure).toEqual({
      step: 'end_processed_window_export',
      code: 'render.failed',
    })
  })

  it('keeps a RAW primary failure beside bounded cleanup failures', () => {
    const primary = new LumaRawRuntimeError(
      'RAW_MEMORY_LIMIT',
      'runtime said no',
    )
    const failures = Array.from(
      { length: MAX_CLEANUP_FAILURES + 2 },
      (_, index) =>
        cleanupFailure(
          index % 2 === 0 ? 'end_processed_window_export' : 'close_temp_file',
          new LumaRawRuntimeError('RAW_JOB_CANCELLED', 'cancelled'),
        ),
    )
    const combined = toLmfgError(withCleanupFailures(primary, failures))
    expect(combined.exitCode).toBe(7)
    expect(combined.toEnvelope()).toEqual({
      schema: 'lmfg.error.v1',
      ok: false,
      error: {
        code: 'render.failed',
        message: 'runtime said no',
        retryable: true,
        suggested_next_actions: [],
        details: {
          runtime_code: 'RAW_MEMORY_LIMIT',
          cleanup_failures: failures.slice(0, MAX_CLEANUP_FAILURES),
          cleanup_failures_omitted: 2,
        },
      },
    })
    expect(cleanupFailuresOf(combined)).toEqual(failures)
  })

  it.each([
    'constructor',
    'toString',
    '__proto__',
    'hasOwnProperty',
    'valueOf',
    'RAW_NOT_A_CODE',
    '',
  ])(
    'maps the RAW code %j, which is not a mapped code, to internal',
    (runtimeCode) => {
      const cause = new LumaRawRuntimeError(
        runtimeCode as LumaRawErrorCode,
        'unknown runtime failure',
      )
      const error = toLmfgError(cause)
      expect(error.code).toBe('internal')
      expect(error.exitCode).toBe(EXIT_CODES.internal)
      expect(error.retryable).toBe(false)
      expect(error.details).toEqual({ runtime_code: runtimeCode })
      expect(error.toEnvelope().error.code).toBe('internal')
    },
  )

  it('keeps a prototype-named RAW primary when cleanup failures follow', () => {
    const primary = new LumaRawRuntimeError(
      'constructor' as LumaRawErrorCode,
      'unknown runtime failure',
    )
    const failure = cleanupFailure(
      'remove_temp_file',
      new LumaRawRuntimeError('toString' as LumaRawErrorCode, 'cleanup'),
    )
    expect(failure).toEqual({ step: 'remove_temp_file', code: 'internal' })
    const combined = toLmfgError(withCleanupFailures(primary, [failure]))
    expect(combined.code).toBe('internal')
    expect(combined.exitCode).toBe(EXIT_CODES.internal)
    expect(combined.message).toBe('unknown runtime failure')
    expect(combined.details).toEqual({
      runtime_code: 'constructor',
      cleanup_failures: [failure],
    })
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

function errnoError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code, syscall: 'unlink' })
}

describe('cleanup failures', () => {
  it('classifies a cleanup error by code and errno and leaves its message out', () => {
    const private_ = '/home/someone/secret-shoot/IMG_0001.dng.123.tmp'
    expect(
      cleanupFailure(
        'remove_temp_file',
        errnoError('EACCES', `EACCES: permission denied, unlink '${private_}'`),
      ),
    ).toEqual({
      step: 'remove_temp_file',
      code: 'permission.denied',
      errno: 'EACCES',
    })
    expect(
      cleanupFailure('end_processed_window_export', new Error('END_FAILED')),
    ).toEqual({ step: 'end_processed_window_export', code: 'internal' })
    expect(
      cleanupFailure(
        'end_processed_window_export',
        new LumaRawRuntimeError('RAW_JOB_CANCELLED', 'cancelled'),
      ),
    ).toEqual({ step: 'end_processed_window_export', code: 'cancelled' })
    expect(cleanupFailure('abort_jpeg_encoder', 'boom')).toEqual({
      step: 'abort_jpeg_encoder',
      code: 'internal',
    })
    // Only errno-shaped codes are kept; anything else could be free text.
    expect(
      cleanupFailure('close_temp_file', errnoError(private_, 'odd')),
    ).toEqual({ step: 'close_temp_file', code: 'internal' })
  })

  it('records a failed cleanup step instead of throwing it', async () => {
    const failures: CleanupFailure[] = []
    expect(await attemptCleanup(failures, 'close_temp_file', () => {})).toBe(
      true,
    )
    expect(
      await attemptCleanup(failures, 'remove_temp_file', async () => {
        throw errnoError('EBUSY', 'busy')
      }),
    ).toBe(false)
    expect(
      await attemptCleanup(failures, 'dispose_jpeg_runtime', () => {
        throw new Error('DISPOSE_FAILED')
      }),
    ).toBe(false)
    expect(failures).toEqual([
      { step: 'remove_temp_file', code: 'internal', errno: 'EBUSY' },
      { step: 'dispose_jpeg_runtime', code: 'internal' },
    ])
  })

  it('returns the primary failure unchanged when no cleanup failed', () => {
    const primary = new Error('WINDOW_READ_FAILED')
    expect(withCleanupFailures(primary, [])).toBe(primary)
    expect(cleanupFailuresOf(primary)).toEqual([])
  })

  it('keeps the primary code, message and exit code beside the cleanup failures', () => {
    const primary = new LmfgError('replay.mismatch', {
      message: 'Replay output differs; nothing was published.',
      retryable: false,
      suggestedNextActions: ['lmfg inspect --session <id>'],
      details: { stage: 'output', published: false },
    })
    const failures = [
      cleanupFailure('remove_temp_file', errnoError('EACCES', 'denied')),
    ]

    const combined = withCleanupFailures(primary, failures)

    expect(combined).toBeInstanceOf(LmfgError)
    expect((combined as LmfgError).cause).toBe(primary)
    expect((combined as LmfgError).exitCode).toBe(EXIT_CODES.exportRefused)
    expect(toLmfgError(combined).toEnvelope()).toEqual({
      schema: 'lmfg.error.v1',
      ok: false,
      error: {
        code: 'replay.mismatch',
        message: 'Replay output differs; nothing was published.',
        retryable: false,
        suggested_next_actions: ['lmfg inspect --session <id>'],
        details: {
          stage: 'output',
          published: false,
          cleanup_failures: [
            {
              step: 'remove_temp_file',
              code: 'permission.denied',
              errno: 'EACCES',
            },
          ],
        },
      },
    })
  })

  it('classifies a plain primary failure the way the envelope would', () => {
    const primary = new Error('LUMA_JPEG_WRITE_FAILED')
    const combined = withCleanupFailures(primary, [
      cleanupFailure('abort_jpeg_encoder', new Error('ABORT_FAILED')),
    ])
    expect(toLmfgError(combined)).toMatchObject({
      code: 'render.failed',
      retryable: true,
      message: 'LUMA_JPEG_WRITE_FAILED',
      cause: primary,
    })
  })

  it('reports each failure once and bounds how many are listed', () => {
    const first = cleanupFailure('close_temp_file', new Error('CLOSE_FAILED'))
    const once = withCleanupFailures(new Error('PRIMARY'), [first])
    const again = withCleanupFailures(once, [first])
    expect(again).toBe(once)
    expect(cleanupFailuresOf(again)).toEqual([first])

    const many: CleanupFailure[] = []
    for (let index = 0; index < MAX_CLEANUP_FAILURES + 3; index += 1) {
      many.push(cleanupFailure('remove_temp_file', errnoError('EBUSY', 'busy')))
    }
    const bounded = toLmfgError(withCleanupFailures(once, many))
    expect(bounded.details?.cleanup_failures).toHaveLength(MAX_CLEANUP_FAILURES)
    expect(bounded.details?.cleanup_failures_omitted).toBe(4)
    expect(bounded.message).toBe('PRIMARY')
  })

  it('counts failures past the bound once when the same list is attached again', () => {
    const many: CleanupFailure[] = []
    for (let index = 0; index < MAX_CLEANUP_FAILURES + 2; index += 1) {
      many.push(cleanupFailure('close_temp_file', new Error('CLOSE_FAILED')))
    }
    const once = withCleanupFailures(new Error('PRIMARY'), many)
    expect(withCleanupFailures(once, many)).toBe(once)
    expect(cleanupFailuresOf(once)).toEqual(many)

    const later = cleanupFailure('remove_temp_file', new Error('RM_FAILED'))
    const more = toLmfgError(withCleanupFailures(once, [...many, later]))
    expect(more.details?.cleanup_failures).toEqual(
      many.slice(0, MAX_CLEANUP_FAILURES),
    )
    expect(more.details?.cleanup_failures_omitted).toBe(3)
  })

  it('lists the cleanup failures of a result the same bounded way', () => {
    expect(cleanupFailureFields([])).toEqual({})
    const failure = cleanupFailure('remove_temp_file', new Error('RM_FAILED'))
    expect(cleanupFailureFields([failure])).toEqual({
      cleanup_failures: [failure],
    })
    const many = Array.from<CleanupFailure>({
      length: MAX_CLEANUP_FAILURES + 1,
    }).fill(failure)
    expect(cleanupFailureFields(many)).toEqual({
      cleanup_failures: many.slice(0, MAX_CLEANUP_FAILURES),
      cleanup_failures_omitted: 1,
    })
  })
})
