// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveRawRenderExposure } from '@lumaforge/luma-color-runtime'
import {
  BOUNDED_HQ_PREVIEW_MAX_PIXELS,
  QUICK_PREVIEW_MAX_PIXELS,
} from '@lumaforge/render-engine/preview'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Output } from '../protocol/output'
import type { LmfgRuntime } from '../runtime/node-runtime'
import { createLmfgRuntime } from '../runtime/node-runtime'
import type { LoadedSource } from '../runtime/source-loader'
import { loadSourceFile } from '../runtime/source-loader'
import { resolveRenderEnvironment } from '../runtime/versions'
import { expandSweepPlan, normalizeCandidatePlan } from '../schemas/plan'
import {
  describeWithFixture,
  FIXTURE_PATH,
} from '../test-support/describe-with-fixture'
import { createIterationStore } from '../workspace/iteration-store'
import { createSessionStore } from '../workspace/session-store'
import { runIteration } from './iteration'

let root: string
beforeEach(async () => {
  root = join(await mkdtemp(join(tmpdir(), 'lmfg-iter-')), '.lmfg')
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describeWithFixture('runIteration', () => {
  it('renders a sweep with events, manifests, metrics, tiles, and a contact sheet', async () => {
    const runtime = createLmfgRuntime({ memoryProfile: 'desktop' })
    const events: string[] = []
    try {
      const source = await loadSourceFile(FIXTURE_PATH, '/')
      const store = createSessionStore(root)
      const record = await store.init({
        sourcePath: source.absolutePath,
        sha256: source.sha256,
        byteSize: source.byteSize,
      })
      const output = new Output({
        emit: 'ndjson',
        quiet: true,
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
          concurrency: 1,
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

/** A uniform linear RGB frame; its auto EV is log2(0.75 / level). */
function uniformFrame(width: number, height: number, level: number) {
  return {
    data: new Uint16Array(width * height * 3).fill(Math.round(level * 65535)),
    width,
    height,
  }
}

// Each decode has different statistics, so an EV measured on the wrong frame
// shows up as a different value.
const SMALL_QUICK = uniformFrame(4, 3, 0.2)
const STANDARD_QUICK = uniformFrame(8, 6, 0.3)
const BOUNDED_HQ = uniformFrame(16, 12, 0.5)
const STANDARD_AUTO = resolveRawRenderExposure({
  metadata: {},
  image: STANDARD_QUICK,
})

function fakeRuntime(onDecode?: (maxOutputPixels: number | undefined) => void) {
  const calls: Array<{ stage: string; maxOutputPixels?: number }> = []
  let disposed = 0
  const session = {
    probe: { baselineExposure: undefined },
    probeExportCapability: async () => ({
      supported: true,
      width: 64,
      height: 48,
      reasons: [],
    }),
    decodeQuick: async (options: { maxOutputPixels?: number } = {}) => {
      calls.push({ stage: 'quick', maxOutputPixels: options.maxOutputPixels })
      onDecode?.(options.maxOutputPixels)
      return options.maxOutputPixels === QUICK_PREVIEW_MAX_PIXELS
        ? STANDARD_QUICK
        : SMALL_QUICK
    },
    decodeBoundedHq: async (options: { maxOutputPixels: number }) => {
      calls.push({
        stage: 'bounded-hq',
        maxOutputPixels: options.maxOutputPixels,
      })
      onDecode?.(options.maxOutputPixels)
      return BOUNDED_HQ
    },
    dispose: () => {
      disposed += 1
    },
  }
  const runtime = {
    memoryProfile: 'desktop',
    raw: async () => ({ openSession: async () => session }),
    jpeg: async () => ({
      createEncoder: () => ({
        writeRows: async () => {},
        finish: async () => new Uint8Array([0xFF, 0xD8, 0xFF, 0xD9]),
        abort: () => {},
      }),
    }),
    dispose: () => {},
  } as unknown as LmfgRuntime
  return { runtime, calls, disposed: () => disposed }
}

const SOURCE = {
  absolutePath: '/fake.raw',
  filename: 'fake.raw',
  bytes: new Uint8Array(0),
  byteSize: 0,
  sha256: '0'.repeat(64),
  input: {},
} as unknown as LoadedSource

describe('runIteration automatic exposure', () => {
  async function iterate(
    fake: ReturnType<typeof fakeRuntime>,
    maxPixels: number,
    signal?: AbortSignal,
  ) {
    const store = createSessionStore(root)
    const record = await store.init({
      sourcePath: SOURCE.absolutePath,
      sha256: SOURCE.sha256,
      byteSize: SOURCE.byteSize,
    })
    const result = await runIteration({
      runtime: fake.runtime,
      source: SOURCE,
      record,
      store,
      iterationStore: createIterationStore(root, record.id),
      environment: resolveRenderEnvironment('desktop'),
      output: new Output({
        emit: 'ndjson',
        quiet: true,
        stdout: () => {},
        stderr: () => {},
      }),
      cwd: root,
      signal,
      plan: normalizeCandidatePlan({
        candidates: [
          { id: 'auto' },
          { id: 'soft', params: { intensity: 0.4 } },
          { id: 'punchy', params: { contrast: 40, exposure_ev: 1 } },
          { id: 'zero', params: { raw_render_exposure: 0 } },
        ],
      }),
      options: {
        maxPixels,
        quality: 80,
        contactSheet: false,
        concurrency: 1,
        sheetOptions: null,
      },
    })
    const manifests = await Promise.all(
      result.candidates.map(async (candidate) =>
        JSON.parse(
          await readFile(
            join(
              root,
              'sessions',
              record.id,
              'iterations',
              result.iteration_id,
              'candidates',
              candidate.id,
              'manifest.json',
            ),
            'utf8',
          ),
        ),
      ),
    )
    return { result, manifests }
  }

  for (const maxPixels of [
    500_000,
    QUICK_PREVIEW_MAX_PIXELS,
    BOUNDED_HQ_PREVIEW_MAX_PIXELS,
  ]) {
    it(`pins every auto candidate to the standard quick frame at ${maxPixels} px`, async () => {
      const fake = fakeRuntime()
      const { result, manifests } = await iterate(fake, maxPixels)
      expect(result.raw_render_exposure).toEqual(STANDARD_AUTO)
      expect(
        manifests.map((manifest) => [
          manifest.render_params.raw_render_exposure_ev,
          manifest.render_params.raw_render_exposure_source,
        ]),
      ).toEqual([
        [STANDARD_AUTO.ev, 'image-statistics'],
        [STANDARD_AUTO.ev, 'image-statistics'],
        [STANDARD_AUTO.ev, 'image-statistics'],
        [0, 'user'],
      ])
      // The standard quick frame is decoded once, or not at all when the
      // rendered frame already is that frame.
      expect(
        fake.calls.filter(
          (call) => call.maxOutputPixels === QUICK_PREVIEW_MAX_PIXELS,
        ),
      ).toHaveLength(1)
      expect(fake.calls).toHaveLength(
        maxPixels === QUICK_PREVIEW_MAX_PIXELS ? 1 : 2,
      )
      expect(fake.disposed()).toBe(1)
    })
  }

  it('disposes the session when aborted during the exposure decode', async () => {
    const controller = new AbortController()
    const fake = fakeRuntime((maxOutputPixels) => {
      if (maxOutputPixels !== QUICK_PREVIEW_MAX_PIXELS) return
      controller.abort()
      controller.signal.throwIfAborted()
    })
    await expect(
      iterate(fake, BOUNDED_HQ_PREVIEW_MAX_PIXELS, controller.signal),
    ).rejects.toThrow()
    expect(fake.disposed()).toBe(1)
  })
})
