import type {
  CreatePreviewHistogramProcessorInput,
  ReadyPreviewHistogram,
} from '@lumaforge/luma-color-runtime'
import { createPreviewHistogramProcessor } from '@lumaforge/luma-color-runtime'

import type { HistogramFrame } from './histogram-sampling'
import {
  createHistogramRowSampler,
  HISTOGRAM_FULL_SAMPLE_PIXELS,
  HISTOGRAM_ROW_BAND_ROWS,
  histogramRowStep,
  packHistogramRows,
} from './histogram-sampling'
import type {
  HistogramWorkerRequest,
  HistogramWorkerResponse,
} from './histogram-worker-runtime'

type HistogramGraph = CreatePreviewHistogramProcessorInput['graph']

/** Rows a main-thread chunk processes between looks at the clock. */
const CHUNK_CLOCK_ROWS = 4
/**
 * A main-thread chunk yields once it has run this long, even short of its
 * rows: a band at the full budget is tens of milliseconds on a slow device,
 * and a scrub resumed meanwhile would wait for all of it before its pointer
 * move lands.
 */
const HISTOGRAM_CHUNK_BUDGET_MS = 6

export interface HistogramRunInput {
  /** Names the frame: the same key is the same pixels. */
  frameKey: string
  frame: HistogramFrame
  graph: HistogramGraph
  /** The most pixels of the frame the run samples. */
  sampleBudget: number
  /** Bands a main-thread chunk may take, and the budget it may spend. */
  bandsPerChunk: number
}

export interface HistogramRunHandlers {
  /** `busyMs` is the main thread's time on the run. */
  onResult: (histogram: ReadyPreviewHistogram, busyMs: number) => void
  onError: (error: unknown) => void
}

export interface HistogramRunHandle {
  /** No handler is called after a cancel. */
  cancel: () => void
}

export interface HistogramExecutor {
  run: (
    input: HistogramRunInput,
    handlers: HistogramRunHandlers,
  ) => HistogramRunHandle
  /** Drops what the executor holds (a worker and its copy of the frame). */
  release: () => void
}

/**
 * Measures on the calling thread, in chunks across macrotasks that each
 * stop after a few milliseconds, so input lands between them.
 */
export function createMainThreadHistogramExecutor(): HistogramExecutor {
  return {
    run({ frame, graph, sampleBudget, bandsPerChunk }, handlers) {
      let cancelled = false
      let timer: ReturnType<typeof setTimeout> | null = null
      let busyMs = 0
      const chunkRows = HISTOGRAM_ROW_BAND_ROWS * bandsPerChunk
      const chunkBudgetMs = HISTOGRAM_CHUNK_BUDGET_MS * bandsPerChunk
      let processor: ReturnType<typeof createPreviewHistogramProcessor>
      let sampler: ReturnType<typeof createHistogramRowSampler>

      const processNextChunk = () => {
        timer = null
        if (cancelled) return
        const startedAt = performance.now()
        try {
          processor ??= createPreviewHistogramProcessor({
            width: frame.width,
            rowBandRows: HISTOGRAM_ROW_BAND_ROWS,
            graph,
          })
          sampler ??= createHistogramRowSampler(
            processor,
            { width: frame.width, rows: frame.height, data: frame.data },
            histogramRowStep(frame.width, frame.height, sampleBudget),
          )
          let rows = 0
          while (rows < chunkRows && !sampler.done) {
            rows += sampler.feed(Math.min(CHUNK_CLOCK_ROWS, chunkRows - rows))
            if (performance.now() - startedAt >= chunkBudgetMs) break
          }
          busyMs += performance.now() - startedAt
          if (!sampler.done) {
            timer = setTimeout(processNextChunk, 0)
            return
          }
          const histogram = processor.finish({
            source: frame.source,
            width: frame.width,
            height: frame.height,
            totalRows: sampler.sampledRows,
          })
          handlers.onResult(histogram, busyMs)
        } catch (error) {
          handlers.onError(error)
        }
      }

      processNextChunk()
      return {
        cancel() {
          cancelled = true
          if (timer !== null) clearTimeout(timer)
          timer = null
        },
      }
    },
    release() {},
  }
}

export interface HistogramWorkerLike {
  postMessage: (
    request: HistogramWorkerRequest,
    transfer?: Transferable[],
  ) => void
  terminate: () => void
  addEventListener: (type: string, listener: (event: never) => void) => void
}

export interface WorkerHistogramExecutorOptions {
  /** Test seam; the default starts the histogram worker. */
  workerFactory?: () => HistogramWorkerLike
  /** Takes every run once the worker fails. */
  fallback?: HistogramExecutor
}

const defaultWorkerFactory = (): HistogramWorkerLike =>
  new Worker(new URL('./histogram.worker.ts', import.meta.url), {
    type: 'module',
  }) as unknown as HistogramWorkerLike

const DETACHED_LUT = new Float32Array(0)

interface WorkerRun {
  input: HistogramRunInput
  handlers: HistogramRunHandlers
  /** Set once a transport failure moved the run to the fallback. */
  moved: HistogramRunHandle | null
}

/**
 * Measures on a worker. A run never reads more than the rows a settled
 * histogram samples, so the worker holds a packed copy of only those rows
 * (about 3 MB whatever the frame's size), made once per frame; the main
 * thread spends that copy and none of the sampling. A settled run reads the
 * same rows the main thread would. The worker starts with the first run and
 * holds one frame and one LUT; a run carries its graph alone. A worker that
 * fails to start or dies hands its runs, and every later one, to the
 * main-thread executor.
 */
export function createWorkerHistogramExecutor({
  workerFactory = defaultWorkerFactory,
  fallback = createMainThreadHistogramExecutor(),
}: WorkerHistogramExecutorOptions = {}): HistogramExecutor {
  let worker: HistogramWorkerLike | null = null
  let failed = false
  let sentFrameKey: string | null = null
  let sentLutId: number | null = null
  const lutIds = new WeakMap<Float32Array, number>()
  let nextLutId = 1
  let nextRunId = 1
  const pending = new Map<number, WorkerRun>()

  const forget = () => {
    worker?.terminate()
    worker = null
    sentFrameKey = null
    sentLutId = null
  }

  const failOver = () => {
    if (failed) return
    failed = true
    forget()
    const runs = [...pending.values()]
    pending.clear()
    for (const run of runs) run.moved = fallback.run(run.input, run.handlers)
  }

  const onMessage = (event: MessageEvent<HistogramWorkerResponse>) => {
    const response = event.data
    const run = pending.get(response.runId)
    if (!run) return
    pending.delete(response.runId)
    if (response.type === 'result') run.handlers.onResult(response.histogram, 0)
    else run.handlers.onError(new Error(response.message))
  }

  const started = () => {
    if (worker) return worker
    const next = workerFactory()
    next.addEventListener('message', onMessage as never)
    next.addEventListener('error', failOver)
    next.addEventListener('messageerror', failOver)
    worker = next
    return next
  }

  // The graph's one 3D LUT goes across once and is named by id after that.
  const detachLut = (target: HistogramWorkerLike, graph: HistogramGraph) => {
    const lutSteps = graph.steps.filter((step) => step.kind === 'lut3d')
    if (lutSteps.length !== 1) return { graph, lutId: null }
    const { data } = lutSteps[0]!
    let lutId = lutIds.get(data)
    if (lutId === undefined) {
      lutId = nextLutId++
      lutIds.set(data, lutId)
    }
    if (sentLutId !== lutId) {
      target.postMessage({ type: 'lut', lutId, data })
      sentLutId = lutId
    }
    return {
      graph: {
        ...graph,
        steps: graph.steps.map((step) =>
          step.kind === 'lut3d' ? { ...step, data: DETACHED_LUT } : step,
        ),
      },
      lutId,
    }
  }

  return {
    run(input, handlers) {
      if (failed) return fallback.run(input, handlers)
      const runId = nextRunId++
      const run: WorkerRun = { input, handlers, moved: null }
      try {
        const target = started()
        if (sentFrameKey !== input.frameKey) {
          const { frame } = input
          const rowStep = histogramRowStep(
            frame.width,
            frame.height,
            HISTOGRAM_FULL_SAMPLE_PIXELS,
          )
          // Handed over rather than cloned again.
          const rows = packHistogramRows(frame, rowStep)
          target.postMessage(
            {
              type: 'frame',
              frameKey: input.frameKey,
              source: frame.source,
              width: frame.width,
              height: frame.height,
              rowStep,
              rows,
            },
            [rows.buffer],
          )
          sentFrameKey = input.frameKey
        }
        const { graph, lutId } = detachLut(target, input.graph)
        pending.set(runId, run)
        target.postMessage({
          type: 'run',
          runId,
          frameKey: input.frameKey,
          lutId,
          graph,
          sampleBudget: input.sampleBudget,
        })
      } catch {
        pending.delete(runId)
        failOver()
        run.moved = fallback.run(input, handlers)
      }
      return {
        cancel() {
          if (run.moved) {
            run.moved.cancel()
            return
          }
          if (pending.delete(runId))
            worker?.postMessage({ type: 'cancel', runId })
        },
      }
    },
    release() {
      pending.clear()
      forget()
      fallback.release()
    },
  }
}

/** The worker executor where the browser runs module workers. */
export function createPreviewHistogramExecutor(): HistogramExecutor {
  return typeof Worker === 'undefined'
    ? createMainThreadHistogramExecutor()
    : createWorkerHistogramExecutor()
}
