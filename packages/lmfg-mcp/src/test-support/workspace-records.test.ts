// @vitest-environment node
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { runCliTool } from '../server'
import { renderManifest, seal } from './workspace-records'

describe('render manifest fixture', () => {
  let cwd: string
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'lmfg-mcp-records-'))
  })
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true })
  })

  // A replay plan rebuilds the color graph with the CLI's own builder from
  // the recorded params and refuses a fingerprint it does not reproduce, so
  // the fixture's literal descriptor cannot drift from what lmfg writes.
  it('records the color graph the CLI rebuilds for its params', async () => {
    const bytes = Buffer.from('fixture source bytes')
    await writeFile(join(cwd, 'source.dng'), bytes)
    const manifest = seal(
      renderManifest({
        kind: 'preview',
        source: {
          sha256: createHash('sha256').update(bytes).digest('hex'),
          byte_size: bytes.byteLength,
        },
        decoded: { width: 6000, height: 4000 },
        output: {
          filename: 'prev_0001.jpg',
          sha256: 'b'.repeat(64),
          width: 600,
          height: 400,
        },
      }),
    )
    await writeFile(join(cwd, 'manifest.json'), JSON.stringify(manifest))

    const run = await runCliTool(
      [
        'render',
        'replay',
        '--manifest',
        'manifest.json',
        '--source',
        'source.dng',
        '--dry-run',
      ],
      cwd,
    )
    expect(run.envelope).toMatchObject({
      ok: true,
      result: {
        dry_run: true,
        command: 'render.replay',
        plan: { kind: 'preview', fingerprint_match: true },
      },
    })
    expect(run.exitCode).toBe(0)
  })
})
