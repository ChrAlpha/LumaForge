// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { successEnvelope } from './envelope'
import { LmfgError } from './errors'
import { Output } from './output'

function capture() {
  const out: string[] = []
  const err: string[] = []
  return {
    out,
    err,
    io: {
      stdout: (s: string) => out.push(s),
      stderr: (s: string) => err.push(s),
    },
  }
}

describe('output json mode', () => {
  it('writes one envelope and logs to stderr', () => {
    const c = capture()
    const output = new Output({
      emit: 'json',
      quiet: false,
      color: false,
      ...c.io,
    })
    output.log('working')
    output.event({ event: 'candidate.ready', candidate_id: 'cand_0001' })
    output.result(successEnvelope('lmfg.version.v1', { lmfg: '0.1.0' }))
    expect(c.out).toEqual([
      `${JSON.stringify({ schema: 'lmfg.version.v1', ok: true, result: { lmfg: '0.1.0' } })}\n`,
    ])
    expect(c.err).toEqual([
      'working\n',
      '[candidate.ready] candidate_id=cand_0001\n',
    ])
  })

  it('suppresses stderr when quiet', () => {
    const c = capture()
    const output = new Output({
      emit: 'json',
      quiet: true,
      color: false,
      ...c.io,
    })
    output.log('hidden')
    expect(c.err).toEqual([])
  })
})

describe('output ndjson mode', () => {
  it('streams events and terminates with completed', () => {
    const c = capture()
    const output = new Output({
      emit: 'ndjson',
      quiet: true,
      color: false,
      ...c.io,
    })
    output.event({ event: 'started', command: 'render.sweep' })
    output.result(
      successEnvelope('lmfg.render.sweep.v1', { iteration_id: 'iter_0001' }),
    )
    const lines = c.out
      .join('')
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(lines[0]).toEqual({
      event: 'started',
      command: 'render.sweep',
      schema: 'lmfg.event.v1',
    })
    expect(lines[1]).toEqual({
      event: 'completed',
      ok: true,
      schema: 'lmfg.event.v1',
      result_schema: 'lmfg.render.sweep.v1',
      result: { iteration_id: 'iter_0001' },
    })
  })

  it('terminates with a failed completed event on error', () => {
    const c = capture()
    const output = new Output({
      emit: 'ndjson',
      quiet: true,
      color: false,
      ...c.io,
    })
    output.error(new LmfgError('render.failed', { message: 'boom' }))
    const line = JSON.parse(c.out.join('').trim())
    expect(line.event).toBe('completed')
    expect(line.ok).toBe(false)
    expect(line.error.code).toBe('render.failed')
  })
})
