import { describe, expect, it } from 'vitest'

import { LumaRawRuntimeError } from '../src/errors'
import type {
  LumaRawWorkerRequest,
  LumaRawWorkerResponse,
} from '../src/worker-protocol'
import type { RawSessionJobContext, RawWorkerRequestRef } from './session-job'
import { runSessionJob } from './session-job'

type FakeSession = { sessionId: string }

function makeContext(options: {
  cancelled?: (call: number) => boolean
  sessions?: string[]
}) {
  const steps: string[] = []
  let cancellationChecks = 0
  const sessions = new Set(options.sessions ?? ['raw-session-1'])
  const context: RawSessionJobContext<FakeSession> = {
    consumeCancellation(request) {
      cancellationChecks += 1
      steps.push(`cancellation:${request.id}`)
      return options.cancelled?.(cancellationChecks) ?? false
    },
    requireSession(sessionId) {
      steps.push(`session:${sessionId}`)
      if (!sessions.has(sessionId)) {
        throw new LumaRawRuntimeError(
          'RAW_WORKER_PROTOCOL_ERROR',
          `RAW runtime session does not exist: ${sessionId}`,
        )
      }
      return { sessionId }
    },
    cancelledResponse(request: RawWorkerRequestRef) {
      steps.push(`cancelled:${request.id}`)
      return {
        id: request.id,
        ok: false,
        type: request.type,
        error: { code: 'RAW_JOB_CANCELLED', message: 'cancelled' },
      } as LumaRawWorkerResponse
    },
  }

  return { context, steps }
}

const endRequest = (
  sessionId = 'raw-session-1',
): LumaRawWorkerRequest<'endProcessedWindowExportFromSession'> => ({
  id: 'job-end',
  type: 'endProcessedWindowExportFromSession',
  payload: { sessionId },
})

const hqRequest = (
  sessionId = 'raw-session-1',
): LumaRawWorkerRequest<'decodeBoundedHqFromSession'> => ({
  id: 'job-hq',
  type: 'decodeBoundedHqFromSession',
  payload: { sessionId, maxOutputPixels: 4 },
})

describe('runSessionJob', () => {
  it('checks cancellation, looks up the session, runs, then checks again before publishing', () => {
    const { context, steps } = makeContext({})

    const response = runSessionJob(context, endRequest(), {
      run(session) {
        steps.push(`run:${session.sessionId}`)
        return { ended: true }
      },
    })

    expect(response).toEqual({
      id: 'job-end',
      ok: true,
      type: 'endProcessedWindowExportFromSession',
      payload: { ended: true },
    })
    expect(steps).toEqual([
      'cancellation:job-end',
      'session:raw-session-1',
      'run:raw-session-1',
      'cancellation:job-end',
    ])
  })

  it('reads options after the cancellation check and before the session lookup', () => {
    const { context, steps } = makeContext({})

    runSessionJob(context, hqRequest(), {
      options(request) {
        steps.push(`options:${request.payload.maxOutputPixels}`)
        return request.payload.maxOutputPixels * 2
      },
      run(session, maxOutputPixels) {
        steps.push(`run:${maxOutputPixels}`)
        return {} as never
      },
    })

    expect(steps).toEqual([
      'cancellation:job-hq',
      'options:4',
      'session:raw-session-1',
      'run:8',
      'cancellation:job-hq',
    ])
  })

  it('refuses a pre-cancelled job before options, session lookup, or native work', () => {
    const { context, steps } = makeContext({ cancelled: (call) => call === 1 })

    const response = runSessionJob(context, hqRequest('raw-session-missing'), {
      options() {
        steps.push('options')
        throw new Error('options must not run')
      },
      run() {
        steps.push('run')
        return {} as never
      },
    })

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'RAW_JOB_CANCELLED' },
    })
    expect(steps).toEqual(['cancellation:job-hq', 'cancelled:job-hq'])
  })

  it('replaces a successful result when cancellation arrives during the job', () => {
    const { context, steps } = makeContext({ cancelled: (call) => call === 2 })

    const response = runSessionJob(context, endRequest(), {
      run() {
        steps.push('run')
        return { ended: true }
      },
    })

    expect(response).toMatchObject({
      id: 'job-end',
      ok: false,
      error: { code: 'RAW_JOB_CANCELLED' },
    })
    expect(steps).toEqual([
      'cancellation:job-end',
      'session:raw-session-1',
      'run',
      'cancellation:job-end',
      'cancelled:job-end',
    ])
  })

  it('propagates option, session, and native errors without consuming a late cancellation', () => {
    const optionsError = new Error('invalid options')
    const nativeFailure = undefined
    const { context, steps } = makeContext({})

    expect(() =>
      runSessionJob(context, hqRequest('raw-session-missing'), {
        options() {
          throw optionsError
        },
        run: () => ({}) as never,
      }),
    ).toThrow(optionsError)
    expect(() =>
      runSessionJob(context, endRequest('raw-session-missing'), {
        run: () => ({ ended: true }),
      }),
    ).toThrow('RAW runtime session does not exist: raw-session-missing')

    let thrown: unknown = 'not thrown'
    try {
      runSessionJob(context, endRequest(), {
        run() {
          throw nativeFailure
        },
      })
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeUndefined()
    expect(steps).toEqual([
      'cancellation:job-hq',
      'cancellation:job-end',
      'session:raw-session-missing',
      'cancellation:job-end',
      'session:raw-session-1',
    ])
  })
})
