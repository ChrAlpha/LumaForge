// @vitest-environment node
import process from 'node:process'

import { describe, expect, it } from 'vitest'

import { runCli } from './cli'

function io() {
  const out: string[] = []
  const err: string[] = []
  return {
    out,
    err,
    io: {
      stdout: (s: string) => out.push(s),
      stderr: (s: string) => err.push(s),
      cwd: process.cwd(),
    },
  }
}

describe('runCli', () => {
  it('version returns a success envelope', async () => {
    const c = io()
    expect(await runCli(['version'], c.io)).toBe(0)
    const envelope = JSON.parse(c.out.join(''))
    expect(envelope).toMatchObject({ schema: 'lmfg.version.v1', ok: true })
    expect(envelope.result.lmfg).toMatch(/^\d+\.\d+\.\d+/)
    expect(envelope.result.runtime_versions.render_engine).toMatch(
      /^\d+\.\d+\.\d+/,
    )
  })

  it('capabilities reports the cpu tier', async () => {
    const c = io()
    expect(await runCli(['capabilities', '--json'], c.io)).toBe(0)
    expect(JSON.parse(c.out.join('')).result.active_tier).toBe('cpu_wasm')
  })

  it('schema list/show work and unknown ids fail with exit 2', async () => {
    const list = io()
    expect(await runCli(['schema', 'list'], list.io)).toBe(0)
    expect(JSON.parse(list.out.join('')).result.schemas.length).toBeGreaterThan(
      20,
    )
    const show = io()
    expect(await runCli(['schema', 'show', 'lmfg.params.v1'], show.io)).toBe(0)
    expect(JSON.parse(show.out.join('')).result.json_schema.$id).toBe(
      'lmfg.params.v1',
    )
    const missing = io()
    expect(await runCli(['schema', 'show', 'lmfg.nope.v1'], missing.io)).toBe(2)
    expect(JSON.parse(missing.out.join(''))).toMatchObject({
      ok: false,
      error: { code: 'args.invalid' },
    })
  })

  it('unknown commands and bad options produce args.invalid envelopes', async () => {
    const c = io()
    expect(await runCli(['frobnicate'], c.io)).toBe(2)
    expect(JSON.parse(c.out.join(''))).toMatchObject({
      schema: 'lmfg.error.v1',
      ok: false,
      error: { code: 'args.invalid' },
    })
    const bad = io()
    expect(await runCli(['version', '--tier', 'gpu'], bad.io)).toBe(2)
  })

  it('ndjson emit wraps the result in a completed event', async () => {
    const c = io()
    expect(await runCli(['version', '--emit', 'ndjson'], c.io)).toBe(0)
    const line = JSON.parse(c.out.join('').trim())
    expect(line).toMatchObject({
      event: 'completed',
      ok: true,
      result_schema: 'lmfg.version.v1',
    })
  })

  it('help exits 0 without an envelope', async () => {
    const c = io()
    expect(await runCli(['--help'], c.io)).toBe(0)
    expect(c.out.join('')).toMatch(/Usage: lmfg/)
  })
})
