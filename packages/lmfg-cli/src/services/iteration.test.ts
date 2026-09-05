// @vitest-environment node
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Output } from '../protocol/output'
import { detectCapabilities } from '../runtime/capability'
import { createLmfgRuntime } from '../runtime/node-runtime'
import { loadSourceFile } from '../runtime/source-loader'
import { resolveRenderEnvironment } from '../runtime/versions'
import { expandSweepPlan } from '../schemas/plan'
import { createIterationStore } from '../workspace/iteration-store'
import { createSessionStore } from '../workspace/session-store'
import { runIteration } from './iteration'

const FIXTURE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../luma-raw-runtime/fixtures/.cache/public/raw-pixls-iphone-se.dng',
)
const ready =
  existsSync(FIXTURE) &&
  detectCapabilities({ memoryProfile: 'desktop' }).render_tiers.cpu_wasm
    .available
const d = ready ? describe : describe.skip

let root: string
beforeEach(async () => {
  root = join(await mkdtemp(join(tmpdir(), 'lmfg-iter-')), '.lmfg')
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

d('runIteration', () => {
  it('renders a sweep with events, manifests, metrics, tiles, and a contact sheet', async () => {
    const runtime = createLmfgRuntime({ memoryProfile: 'desktop' })
    const events: string[] = []
    try {
      const source = await loadSourceFile(FIXTURE, '/')
      const store = createSessionStore(root)
      const record = await store.init({
        sourcePath: source.absolutePath,
        sha256: source.sha256,
        byteSize: source.byteSize,
      })
      const output = new Output({
        emit: 'ndjson',
        quiet: true,
        color: false,
        stdout: (s) => {
          events.push(s)
        },
        stderr: () => {},
      })
      const result = await runIteration({
        runtime,
        source,
        record,
        store,
        iterationStore: createIterationStore(root, record.id),
        environment: resolveRenderEnvironment('desktop'),
        output,
        cwd: root,
        plan: expandSweepPlan({
          axes: { exposure_ev: [-1, 1], contrast: [0, 30] },
        }),
        options: {
          maxPixels: 300_000,
          quality: 80,
          contactSheet: true,
          sheetOptions: { cols: 2, tile_width: 160 },
        },
      })
      expect(result.iteration_id).toBe('iter_0001')
      expect(result.candidates).toHaveLength(4)
      expect(result.contact_sheet).toMatchObject({
        cols: 2,
        rows: 2,
        tile_width: 160,
      })
      expect(
        new Set(result.candidates.map((c) => c.manifest_sha256)).size,
      ).toBe(4)
      const manifest = JSON.parse(
        await readFile(
          join(
            root,
            'sessions',
            record.id,
            'iterations',
            'iter_0001',
            'candidates',
            'cand_0002',
            'manifest.json',
          ),
          'utf8',
        ),
      )
      expect(manifest.kind).toBe('candidate')
      expect(manifest.render_params).toMatchObject({
        exposure_ev: -1,
        tone_curve: { contrast: 30 },
      })
      const lines = events
        .join('')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      expect(lines.filter((l) => l.event === 'candidate.ready')).toHaveLength(4)
      expect(
        lines.some(
          (l) => l.event === 'artifact.ready' && l.role === 'contact-sheet',
        ),
      ).toBe(true)
      const stored = await readFile(
        join(
          root,
          'sessions',
          record.id,
          'iterations',
          'iter_0001',
          'events.ndjson',
        ),
        'utf8',
      )
      expect(stored.trim().split('\n').length).toBeGreaterThanOrEqual(6)
    } finally {
      runtime.dispose()
    }
  }, 120_000)
})
