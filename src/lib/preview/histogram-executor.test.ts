import type {
  CreatePreviewHistogramProcessorInput,
  LUTData,
  ReadyPreviewHistogram,
} from '@lumaforge/luma-color-runtime'
import { NEUTRAL_USER_COLOR_INTENT } from '@lumaforge/luma-color-runtime'
import { resolvePreviewColorPlan } from '@lumaforge/render-engine/preview'
import { describe, expect, it, vi } from 'vitest'

import type {
  HistogramExecutor,
  HistogramRunHandlers,
  HistogramRunInput,
  HistogramWorkerLike,
} from './histogram-executor'
import {
  createMainThreadHistogramExecutor,
  createWorkerHistogramExecutor,
} from './histogram-executor'
import { HISTOGRAM_FULL_SAMPLE_PIXELS } from './histogram-sampling'
import type {
  HistogramWorkerRequest,
  HistogramWorkerResponse,
} from './histogram-worker-runtime'
import { createHistogramWorkerRuntime } from './histogram-worker-runtime'

type Graph = CreatePreviewHistogramProcessorInput['graph']

const lut: LUTData = {
  size: 2,
  data: new Float32Array([
    0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1, 1, 1, 1,
  ]),
  domainMin: [0, 0, 0],
  domainMax: [1, 1, 1],
  profileResolution: {
    kind: 'confirmed',
    confidence: 'metadata',
    profile: {
      id: 'test-linear',
      label: 'Test linear',
      role: 'scene-creative',
      inputGamut: 'prophoto-rgb',
      inputTransfer: 'linear',
      inputRange: 'full',
      outputGamut: 'srgb-rec709',
      outputTransfer: 'srgb',
      outputRange: 'full',
      aliases: [],
    },
  },
}

function graphFor(withLut: boolean): Graph {
  const plan = resolvePreviewColorPlan({
    intent: {
      ...NEUTRAL_USER_COLOR_INTENT,
      userExposureEv: 0.4,
      intensity: 0.8,
      styleKind: withLut ? 'custom' : 'none',
      builtinPreset: null,
    },
    lut: withLut ? lut : null,
    rawRenderExposure: { ev: 0, multiplier: 1, source: 'identity' },
    executor: 'webgpu',
  })
  if (plan.histogram.kind !== 'graph') throw new Error('no graph')
  return plan.histogram.graph
}

/** Varied RGB16; 40 x 37 by default, enough rows for several bands. */
function frameInput(
  overrides: Partial<HistogramRunInput> = {},
  { width = 40, height = 37 } = {},
): HistogramRunInput {
  const data = new Uint16Array(width * height * 3)
  for (let index = 0; index < data.length; index += 1) {
    data[index] = (index * 2654435761) % 65536
  }
  return {
    frameKey: 'session:frame-1',
    frame: { source: 'quick', width, height, data },
    graph: graphFor(false),
    sampleBudget: HISTOGRAM_FULL_SAMPLE_PIXELS,
    bandsPerChunk: 1,
    ...overrides,
  }
}

/**
 * A worker that runs the real runtime in this thread. Messages cross
 * asynchronously, as they would between threads; a transferred buffer is
 * detached like a real transfer.
 */
class InProcessWorker implements HistogramWorkerLike {
  posted: HistogramWorkerRequest[] = []
  transfers: Transferable[][] = []
  terminated = false
  private listeners = new Map<string, ((event: never) => void)[]>()
  private runtime = createHistogramWorkerRuntime(
    (response) =>
      setTimeout(() => this.emit('message', { data: response } as never)),
    () => new Promise<void>((resolve) => setTimeout(resolve)),
  )

  postMessage(request: HistogramWorkerRequest, transfer: Transferable[] = []) {
    const delivered =
      transfer.length > 0 ? structuredClone(request, { transfer }) : request
    // What the worker receives: a transferred buffer is the worker's now.
    this.posted.push(delivered)
    this.transfers.push(transfer)
    setTimeout(() => {
      if (!this.terminated) this.runtime.handle(delivered)
    })
  }

  terminate() {
    this.terminated = true
  }

  addEventListener(type: string, listener: (event: never) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  emit(type: string, event: never) {
    if (this.terminated) return
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

function runOn(
  executor: HistogramExecutor,
  input: HistogramRunInput,
): Promise<ReadyPreviewHistogram> {
  return new Promise((resolve, reject) => {
    executor.run(input, {
      onResult: (histogram) => resolve(histogram),
      onError: reject,
    })
  })
}

function workerExecutor(fallback?: HistogramExecutor) {
  const workers: InProcessWorker[] = []
  const executor = createWorkerHistogramExecutor({
    workerFactory: () => {
      const worker = new InProcessWorker()
      workers.push(worker)
      return worker
    },
    fallback,
  })
  return { executor, workers }
}

function postedOf(
  worker: InProcessWorker,
  type: HistogramWorkerRequest['type'],
) {
  return worker.posted.filter((request) => request.type === type)
}

describe('worker histogram executor', () => {
  it('measures a settled histogram as the main thread does, LUT included', async () => {
    // One frame inside the sample budget, one past it (every second row).
    for (const size of [
      { width: 40, height: 37 },
      { width: 1000, height: 600 },
    ]) {
      for (const withLut of [false, true]) {
        const input = frameInput({ graph: graphFor(withLut) }, size)
        const { executor } = workerExecutor()
        const onWorker = await runOn(executor, input)
        const onMain = await runOn(createMainThreadHistogramExecutor(), input)
        expect(onWorker.bins).toEqual(onMain.bins)
        expect(onWorker.clipping).toEqual(onMain.clipping)
        expect(onWorker.sampledPixels).toBe(onMain.sampledPixels)
        expect(onWorker).toMatchObject({
          width: size.width,
          height: size.height,
          totalPixels: size.width * size.height,
        })
      }
    }
  })

  it('holds only the rows a settled histogram reads, and samples a scrub from them', async () => {
    const { executor, workers } = workerExecutor()
    const input = frameInput({}, { width: 1000, height: 600 })
    await runOn(executor, input)
    const [frame] = postedOf(workers[0]!, 'frame')
    // 600k pixels against a 500k budget: every second row, 300 of them.
    expect(frame).toMatchObject({ width: 1000, height: 600, rowStep: 2 })
    expect(frame?.type === 'frame' && frame.rows.length).toBe(300 * 1000 * 3)

    const scrub = await runOn(executor, { ...input, sampleBudget: 40_000 })
    // Every 16th row of the frame (rounded from 15 to the held rows), as
    // dense as the main thread's scrub sample.
    const onMain = await runOn(createMainThreadHistogramExecutor(), {
      ...input,
      sampleBudget: 40_000,
    })
    expect(scrub.sampledPixels).toBe(38 * 1000)
    expect(onMain.sampledPixels).toBe(40 * 1000)
  })

  it('hands the worker a copy of each frame once, and the LUT once', async () => {
    const { executor, workers } = workerExecutor()
    const input = frameInput({ graph: graphFor(true) })
    await runOn(executor, input)
    await runOn(executor, { ...input, sampleBudget: 400 })
    const [worker] = workers
    expect(workers).toHaveLength(1)
    expect(postedOf(worker!, 'frame')).toHaveLength(1)
    expect(postedOf(worker!, 'lut')).toHaveLength(1)
    // The frame's rows cross as a transferred copy: the workflow keeps its
    // own frame whole.
    expect(worker!.transfers[0]).toHaveLength(1)
    expect(input.frame.data.length).toBe(40 * 37 * 3)
    // A run names the LUT rather than carrying its table.
    for (const run of postedOf(worker!, 'run')) {
      if (run.type !== 'run') continue
      expect(run.lutId).toBe(1)
      const step = run.graph.steps.find((s) => s.kind === 'lut3d')
      expect(step?.kind === 'lut3d' && step.data.length).toBe(0)
    }

    await runOn(executor, { ...input, frameKey: 'session:frame-2' })
    expect(postedOf(worker!, 'frame')).toHaveLength(2)
    expect(postedOf(worker!, 'lut')).toHaveLength(1)
  })

  it('calls nothing for a cancelled run and tells the worker to stop', async () => {
    vi.useFakeTimers()
    try {
      const { executor, workers } = workerExecutor()
      const handlers: HistogramRunHandlers = {
        onResult: vi.fn(),
        onError: vi.fn(),
      }
      const handle = executor.run(frameInput(), handlers)
      handle.cancel()
      await vi.runAllTimersAsync()
      expect(handlers.onResult).not.toHaveBeenCalled()
      expect(handlers.onError).not.toHaveBeenCalled()
      expect(postedOf(workers[0]!, 'cancel')).toEqual([
        { type: 'cancel', runId: 1 },
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('hands its runs to the main thread once the worker fails', async () => {
    const fallback = createMainThreadHistogramExecutor()
    const fallbackRun = vi.spyOn(fallback, 'run')
    const { executor, workers } = workerExecutor(fallback)
    const input = frameInput()
    const answered = runOn(executor, input)
    workers[0]!.emit('error', new Event('error') as never)
    const histogram = await answered
    expect(fallbackRun).toHaveBeenCalledTimes(1)
    expect(histogram.state).toBe('ready')
    expect(workers[0]!.terminated).toBe(true)

    await runOn(executor, input)
    expect(workers).toHaveLength(1)
    expect(fallbackRun).toHaveBeenCalledTimes(2)
  })

  it('reports a run the worker could not measure', async () => {
    const { executor, workers } = workerExecutor()
    const failed = runOn(executor, frameInput())
    // A run the worker answers with a failure fails; the executor does not
    // retry it elsewhere.
    const worker = workers[0]!
    const respond = (response: HistogramWorkerResponse) =>
      worker.emit('message', { data: response } as never)
    respond({
      type: 'failed',
      runId: 1,
      message: 'HISTOGRAM_WORKER_FRAME_MISSING',
    })
    await expect(failed).rejects.toThrow('HISTOGRAM_WORKER_FRAME_MISSING')
  })

  it('lets go of the worker and its frame on release', async () => {
    const { executor, workers } = workerExecutor()
    const input = frameInput()
    await runOn(executor, input)
    executor.release()
    expect(workers[0]!.terminated).toBe(true)

    await runOn(executor, input)
    expect(workers).toHaveLength(2)
    expect(postedOf(workers[1]!, 'frame')).toHaveLength(1)
  })
})
