import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  parseConcurrency,
  renderCandidates,
  resolveConcurrency,
  shareFrame,
} from './candidate-pool'

/**
 * A stand-in worker that speaks the pool protocol without WASM: it echoes a
 * JPEG made of the candidate index and can be told to fail or stall.
 */
const FAKE_WORKER = `
import { parentPort, workerData } from 'node:worker_threads'
const frame = new Uint16Array(workerData.frame.buffer)
parentPort.on('message', (request) => {
  if (request.type === 'close') { parentPort.close(); return }
  const delay = request.graph.delayMs ?? 0
  setTimeout(() => {
    if (request.graph.fail) {
      parentPort.postMessage({ type: 'error', index: request.index, message: 'boom' })
      return
    }
    const jpeg = new Uint8Array([0xff, 0xd8, request.index, frame[0] & 0xff, 0xff, 0xd9])
    parentPort.postMessage({
      type: 'done',
      index: request.index,
      width: workerData.frame.width,
      height: workerData.frame.height,
      jpeg,
      sha256: 'sha-' + request.index,
      metrics: { schema: 'lmfg.metrics.v1', width: 1, height: 1, sampled_pixels: 1,
        luma: { mean: 0, p1: 0, p50: 0, p99: 0, clipped_highlight_ratio: 0, clipped_shadow_ratio: 0 },
        chroma: { mean_saturation: 0, colorfulness: 0 }, histogram: { bins: 1, luma: [1] }, approximate: false },
      tile: { rgba: new Uint8ClampedArray(4), width: 1, height: 1 },
    }, [jpeg.buffer])
  }, delay)
})
parentPort.postMessage({ type: 'ready' })
`

let dir: string
let workerScript: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lmfg-pool-'))
  workerScript = join(dir, 'fake-worker.mjs')
  await writeFile(workerScript, FAKE_WORKER)
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const frame = {
  data: new Uint16Array([7, 8, 9, 10, 11, 12]),
  width: 2,
  height: 1,
}
const graph = (extra: Record<string, unknown> = {}) =>
  ({
    outputGamut: 'srgb-rec709',
    outputTransfer: 'srgb',
    lutProfile: null,
    steps: [],
    ...extra,
  }) as never

function collect(run: {
  results: AsyncIterable<{ index: number; jpeg: Uint8Array }>
}) {
  return (async () => {
    const seen: number[] = []
    for await (const result of run.results) {
      expect(result.jpeg[2]).toBe(result.index)
      seen.push(result.index)
    }
    return seen
  })()
}

describe('parseConcurrency / resolveConcurrency', () => {
  it('accepts auto and bounded integers', () => {
    expect(parseConcurrency('auto')).toBe('auto')
    expect(parseConcurrency('3')).toBe(3)
    for (const bad of ['0', '-1', '65', '2.5', 'two', '']) {
      expect(() => parseConcurrency(bad)).toThrow(
        expect.objectContaining({ code: 'args.invalid', exitCode: 2 }),
      )
    }
  })

  it('keeps a core free, caps at eight, and stays serial on low-memory', () => {
    expect(
      resolveConcurrency({
        requested: 'auto',
        candidates: 64,
        memoryProfile: 'desktop',
        parallelism: 16,
      }),
    ).toBe(8)
    expect(
      resolveConcurrency({
        requested: 'auto',
        candidates: 64,
        memoryProfile: 'desktop',
        parallelism: 4,
      }),
    ).toBe(3)
    expect(
      resolveConcurrency({
        requested: 'auto',
        candidates: 2,
        memoryProfile: 'desktop',
        parallelism: 16,
      }),
    ).toBe(2)
    expect(
      resolveConcurrency({
        requested: 'auto',
        candidates: 64,
        memoryProfile: 'low-memory',
        parallelism: 16,
      }),
    ).toBe(1)
    expect(
      resolveConcurrency({
        requested: 6,
        candidates: 64,
        memoryProfile: 'low-memory',
      }),
    ).toBe(6)
    expect(
      resolveConcurrency({
        requested: 6,
        candidates: 2,
        memoryProfile: 'desktop',
      }),
    ).toBe(2)
  })
})

describe('shareFrame', () => {
  it('copies the frame into shared memory once', () => {
    const shared = shareFrame(frame)
    expect(shared.buffer).toBeInstanceOf(SharedArrayBuffer)
    expect([...new Uint16Array(shared.buffer)]).toEqual([...frame.data])
    expect(shared.width).toBe(2)
  })
})

describe('renderCandidates', () => {
  it('runs every candidate exactly once across the pool and reads the shared frame', async () => {
    const tasks = Array.from({ length: 7 }, (_, index) => ({
      graph: graph({ delayMs: (7 - index) * 3 }),
      quality: 0.8,
    }))
    const run = renderCandidates({
      frame,
      tasks,
      tile: { width: 1, height: 1 },
      concurrency: 3,
      workerScript,
      createEncoder: () => {
        throw new Error('inline path must not run')
      },
    })
    expect(run.concurrency).toBe(3)
    const seen = await collect(run)
    expect([...seen].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(seen).not.toEqual([0, 1, 2, 3, 4, 5, 6])
  })

  it('never exceeds the candidate count and falls back inline without a worker script', () => {
    const run = renderCandidates({
      frame,
      tasks: [{ graph: graph(), quality: 0.8 }],
      tile: { width: 1, height: 1 },
      concurrency: 4,
      workerScript,
      createEncoder: () => {
        throw new Error('unused')
      },
    })
    expect(run.concurrency).toBe(1)
    const inline = renderCandidates({
      frame,
      tasks: [
        { graph: graph(), quality: 0.8 },
        { graph: graph(), quality: 0.8 },
      ],
      tile: { width: 1, height: 1 },
      concurrency: 2,
      workerScript: null,
      createEncoder: () => {
        throw new Error('unused')
      },
    })
    expect(inline.concurrency).toBe(1)
  })

  it('surfaces a candidate failure as render.failed and stops the pool', async () => {
    const run = renderCandidates({
      frame,
      tasks: [
        { graph: graph({ delayMs: 20 }), quality: 0.8 },
        { graph: graph({ fail: true }), quality: 0.8 },
        { graph: graph({ delayMs: 40 }), quality: 0.8 },
      ],
      tile: { width: 1, height: 1 },
      concurrency: 2,
      workerScript,
      createEncoder: () => {
        throw new Error('unused')
      },
    })
    await expect(collect(run)).rejects.toMatchObject({
      code: 'render.failed',
      exitCode: 7,
      message: expect.stringContaining('Candidate 2 failed: boom'),
    })
  })

  it('stops on abort with the signal reason', async () => {
    const controller = new AbortController()
    const run = renderCandidates({
      frame,
      tasks: [0, 1, 2, 3].map(() => ({
        graph: graph({ delayMs: 200 }),
        quality: 0.8,
      })),
      tile: { width: 1, height: 1 },
      concurrency: 2,
      workerScript,
      createEncoder: () => {
        throw new Error('unused')
      },
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(new Error('Timed out after 1 ms.')), 30)
    await expect(collect(run)).rejects.toThrow('Timed out after 1 ms.')
  })
  it('fails with render.failed when a worker crashes before it is ready', async () => {
    const crashing = join(dir, 'crash-worker.mjs')
    await writeFile(crashing, "throw new Error('boot failure')\n")
    const run = renderCandidates({
      frame,
      tasks: [
        { graph: graph(), quality: 0.8 },
        { graph: graph(), quality: 0.8 },
      ],
      tile: { width: 1, height: 1 },
      concurrency: 2,
      workerScript: crashing,
      createEncoder: () => {
        throw new Error('unused')
      },
    })
    await expect(collect(run)).rejects.toMatchObject({
      code: 'render.failed',
      exitCode: 7,
    })
  })
})
