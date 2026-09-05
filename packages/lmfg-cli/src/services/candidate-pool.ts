import { availableParallelism } from 'node:os'
import { Worker } from 'node:worker_threads'

import type { SupportedExportColorGraphDescriptor } from '@lumaforge/luma-color-runtime'
import { sha256Hex } from '@lumaforge/render-engine'
import type { PreviewJpegEncoderFactory } from '@lumaforge/render-engine/preview'
import { candidateRender } from '@lumaforge/render-engine/preview'

import { LmfgError } from '../protocol/errors'
import type { MemoryProfile } from '../runtime/versions'
import type { Metrics } from '../schemas/results'
import { downsampleRgba } from './contact-sheet'
import { computeImageMetrics } from './metrics'

export const MAX_CONCURRENCY = 64
const AUTO_CONCURRENCY_CAP = 8

export type CandidateTask = {
  graph: SupportedExportColorGraphDescriptor
  quality: number
}

export type CandidateOutput = {
  index: number
  width: number
  height: number
  jpeg: Uint8Array
  sha256: string
  metrics: Metrics
  tile: { rgba: Uint8ClampedArray; width: number; height: number }
}

export type SharedFrame = {
  buffer: SharedArrayBuffer
  width: number
  height: number
}

/** Messages the pool sends to a candidate worker. */
export type CandidateWorkerRequest =
  | {
      type: 'render'
      index: number
      graph: SupportedExportColorGraphDescriptor
      quality: number
    }
  | { type: 'close' }

/** Messages a candidate worker posts back. */
export type CandidateWorkerResponse =
  | { type: 'ready' }
  | {
      type: 'done'
      index: number
      width: number
      height: number
      jpeg: Uint8Array
      sha256: string
      metrics: Metrics
      tile: { rgba: Uint8ClampedArray; width: number; height: number }
    }
  | { type: 'error'; index: number | null; message: string; stack?: string }

export type CandidateWorkerData = {
  frame: SharedFrame
  tile: { width: number; height: number }
}

export type ConcurrencyRequest = number | 'auto'

export function parseConcurrency(value: string): ConcurrencyRequest {
  if (value === 'auto') return 'auto'
  const parsed = Number.parseInt(value, 10)
  if (
    !Number.isFinite(parsed) ||
    parsed <= 0 ||
    parsed > MAX_CONCURRENCY ||
    String(parsed) !== value.trim()
  ) {
    throw new LmfgError('args.invalid', {
      message: `--concurrency must be "auto" or an integer between 1 and ${MAX_CONCURRENCY}, got ${JSON.stringify(value)}.`,
    })
  }
  return parsed
}

/**
 * Pool size actually used for a run. `auto` keeps one core free, caps at
 * eight (JPEG encode and color math stop scaling well past that on a shared
 * frame), never exceeds the candidate count, and stays single-threaded on
 * the low-memory profile unless a number was given explicitly.
 */
export function resolveConcurrency(input: {
  requested: ConcurrencyRequest
  candidates: number
  memoryProfile: MemoryProfile
  parallelism?: number
}): number {
  const candidates = Math.max(1, input.candidates)
  if (input.requested === 'auto') {
    if (input.memoryProfile === 'low-memory') return 1
    const cores = input.parallelism ?? availableParallelism()
    return Math.max(1, Math.min(cores - 1, AUTO_CONCURRENCY_CAP, candidates))
  }
  return Math.max(1, Math.min(input.requested, candidates))
}

export function shareFrame(frame: {
  data: Uint16Array
  width: number
  height: number
}): SharedFrame {
  const buffer = new SharedArrayBuffer(frame.data.byteLength)
  new Uint16Array(buffer).set(frame.data)
  return { buffer, width: frame.width, height: frame.height }
}

/** The per-candidate work every executor (inline or worker) performs identically. */
export function finishCandidate(input: {
  index: number
  width: number
  height: number
  rgba: Uint8ClampedArray
  jpeg: Uint8Array
  tile: { width: number; height: number }
}): CandidateOutput {
  return {
    index: input.index,
    width: input.width,
    height: input.height,
    jpeg: input.jpeg,
    sha256: sha256Hex(input.jpeg),
    metrics: computeImageMetrics(input.rgba, input.width, input.height),
    tile: {
      rgba: downsampleRgba(
        input.rgba,
        input.width,
        input.height,
        input.tile.width,
        input.tile.height,
      ),
      width: input.tile.width,
      height: input.tile.height,
    },
  }
}

export type RenderCandidatesInput = {
  frame: { data: Uint16Array; width: number; height: number }
  tasks: readonly CandidateTask[]
  tile: { width: number; height: number }
  concurrency: number
  /** Absolute path of the built worker script; `null` forces the inline path. */
  workerScript: string | null
  createEncoder: PreviewJpegEncoderFactory
  signal?: AbortSignal
}

export type RenderCandidatesRun = {
  /** Pool size actually used (1 when the inline path ran). */
  concurrency: number
  results: AsyncIterable<CandidateOutput>
}

export function renderCandidates(
  input: RenderCandidatesInput,
): RenderCandidatesRun {
  const concurrency = Math.max(
    1,
    Math.min(input.concurrency, input.tasks.length),
  )
  if (concurrency === 1 || !input.workerScript) {
    return { concurrency: 1, results: renderInline(input) }
  }
  return {
    concurrency,
    results: renderWithWorkers(input, concurrency, input.workerScript),
  }
}

async function* renderInline(
  input: RenderCandidatesInput,
): AsyncGenerator<CandidateOutput> {
  for await (const result of candidateRender({
    source: input.frame,
    params: input.tasks.map((task, index) => ({
      graph: task.graph,
      quality: task.quality,
      tag: String(index),
    })),
    maxConcurrent: 1,
    createEncoder: input.createEncoder,
    signal: input.signal,
  })) {
    yield finishCandidate({
      index: result.index,
      width: result.width,
      height: result.height,
      rgba: result.rgba,
      jpeg: result.outputBytes as Uint8Array,
      tile: input.tile,
    })
  }
}

type PendingSlot = {
  worker: Worker
  busy: boolean
}

async function* renderWithWorkers(
  input: RenderCandidatesInput,
  concurrency: number,
  workerScript: string,
): AsyncGenerator<CandidateOutput> {
  const frame = shareFrame(input.frame)
  const workerData: CandidateWorkerData = { frame, tile: input.tile }
  const slots: PendingSlot[] = []
  const queue: CandidateOutput[] = []
  let nextIndex = 0
  let completed = 0
  let failure: unknown = null
  let wake: (() => void) | null = null

  const notify = () => {
    const resolve = wake
    wake = null
    resolve?.()
  }
  const waitForEvent = () =>
    new Promise<void>((resolve) => {
      wake = resolve
    })

  const fail = (error: unknown) => {
    failure ??= error
    notify()
  }

  const dispatch = (slot: PendingSlot) => {
    if (failure || nextIndex >= input.tasks.length) return
    const index = nextIndex
    nextIndex += 1
    slot.busy = true
    const task = input.tasks[index]
    const message: CandidateWorkerRequest = {
      type: 'render',
      index,
      graph: task.graph,
      quality: task.quality,
    }
    slot.worker.postMessage(message)
  }

  const onAbort = () => {
    fail(input.signal?.reason ?? new Error('CANDIDATE_RENDER_ABORTED'))
  }
  input.signal?.addEventListener('abort', onAbort, { once: true })

  const terminateAll = async () => {
    input.signal?.removeEventListener('abort', onAbort)
    await Promise.allSettled(slots.map((slot) => slot.worker.terminate()))
  }

  try {
    if (input.signal?.aborted) onAbort()
    for (let i = 0; i < concurrency; i += 1) {
      if (failure) break
      const worker = new Worker(workerScript, { workerData })
      const slot: PendingSlot = { worker, busy: false }
      slots.push(slot)
      worker.on('message', (response: CandidateWorkerResponse) => {
        if (response.type === 'ready') {
          dispatch(slot)
          notify()
          return
        }
        if (response.type === 'error') {
          fail(
            new LmfgError('render.failed', {
              message:
                response.index === null
                  ? `Candidate worker failed: ${response.message}`
                  : `Candidate ${response.index + 1} failed: ${response.message}`,
              details: response.stack ? { stack: response.stack } : undefined,
            }),
          )
          return
        }
        slot.busy = false
        completed += 1
        queue.push({
          index: response.index,
          width: response.width,
          height: response.height,
          jpeg: response.jpeg,
          sha256: response.sha256,
          metrics: response.metrics,
          tile: response.tile,
        })
        dispatch(slot)
        notify()
      })
      worker.on('error', (error: unknown) => {
        fail(
          new LmfgError('render.failed', {
            message: `Candidate worker crashed: ${error instanceof Error ? error.message : String(error)}`,
            cause: error,
          }),
        )
      })
      worker.on('messageerror', (error: unknown) => {
        fail(
          new LmfgError('render.failed', {
            message: `Candidate worker message could not be deserialized: ${error instanceof Error ? error.message : String(error)}`,
          }),
        )
      })
      worker.on('exit', (code) => {
        if (code !== 0 && !failure && completed < input.tasks.length) {
          fail(
            new LmfgError('render.failed', {
              message: `Candidate worker exited with code ${code}.`,
            }),
          )
        }
      })
    }

    for (;;) {
      if (failure) throw failure
      if (queue.length > 0) {
        yield queue.shift()!
        continue
      }
      if (completed >= input.tasks.length) break
      await waitForEvent()
    }
  } finally {
    await terminateAll()
  }
}
