import type {
  CreatePreviewHistogramProcessorInput,
  PreviewHistogramSource,
  ReadyPreviewHistogram,
} from '@lumaforge/luma-color-runtime'
import { createPreviewHistogramProcessor } from '@lumaforge/luma-color-runtime'

import {
  createHistogramRowSampler,
  HISTOGRAM_ROW_BAND_ROWS,
  histogramRowStep,
} from './histogram-sampling'

type HistogramGraph = CreatePreviewHistogramProcessorInput['graph']

export type HistogramWorkerRequest =
  | {
      /**
       * The rows of a frame every later run samples, until the next frame
       * replaces them: every `rowStep`-th row of a `width` x `height` frame,
       * packed from the first.
       */
      type: 'frame'
      frameKey: string
      source: PreviewHistogramSource
      width: number
      height: number
      rowStep: number
      rows: Uint16Array
    }
  | {
      /** The 3D LUT a run's graph names by `lutId` instead of carrying it. */
      type: 'lut'
      lutId: number
      data: Float32Array
    }
  | {
      type: 'run'
      runId: number
      frameKey: string
      /** Set when the graph's one 3D LUT step left its data behind. */
      lutId: number | null
      graph: HistogramGraph
      /** The most pixels of the frame this run samples. */
      sampleBudget: number
    }
  | { type: 'cancel'; runId: number }

export type HistogramWorkerResponse =
  | { type: 'result'; runId: number; histogram: ReadyPreviewHistogram }
  | { type: 'failed'; runId: number; message: string }

/** How long a run works before it lets a cancel reach it. */
const WORKER_SLICE_MS = 16

type FrameRequest = Extract<HistogramWorkerRequest, { type: 'frame' }>
type RunRequest = Extract<HistogramWorkerRequest, { type: 'run' }>

/**
 * The histogram worker's side of the protocol. It holds the rows of one
 * frame and one LUT, so a run carries only its graph; a run works in slices
 * and stops at the next one once cancelled.
 */
export function createHistogramWorkerRuntime(
  post: (response: HistogramWorkerResponse) => void,
  yieldToMessages: () => Promise<void>,
) {
  let frame: FrameRequest | null = null
  let lut: { id: number; data: Float32Array } | null = null
  const running = new Set<number>()
  const cancelled = new Set<number>()

  function withLut(graph: HistogramGraph, lutId: number | null) {
    if (lutId === null) return graph
    if (lut?.id !== lutId) throw new Error('HISTOGRAM_WORKER_LUT_MISSING')
    const data = lut.data
    return {
      ...graph,
      steps: graph.steps.map((step) =>
        step.kind === 'lut3d' ? { ...step, data } : step,
      ),
    }
  }

  async function run(request: RunRequest) {
    const { runId } = request
    running.add(runId)
    try {
      const current = frame
      if (current?.frameKey !== request.frameKey) {
        throw new Error('HISTOGRAM_WORKER_FRAME_MISSING')
      }
      const { width, height } = current
      const processor = createPreviewHistogramProcessor({
        width,
        rowBandRows: HISTOGRAM_ROW_BAND_ROWS,
        graph: withLut(request.graph, request.lutId),
      })
      // The run's own step over the whole frame, taken over the rows held.
      const step = Math.max(
        1,
        Math.round(
          histogramRowStep(width, height, request.sampleBudget) /
            current.rowStep,
        ),
      )
      const sampler = createHistogramRowSampler(
        processor,
        {
          width,
          rows: current.rows.length / (width * 3),
          data: current.rows,
        },
        step,
      )
      let sliceStart = performance.now()
      while (!sampler.done) {
        sampler.feed(HISTOGRAM_ROW_BAND_ROWS)
        if (performance.now() - sliceStart < WORKER_SLICE_MS) continue
        await yieldToMessages()
        if (cancelled.has(runId)) return
        sliceStart = performance.now()
      }
      if (cancelled.has(runId)) return
      post({
        type: 'result',
        runId,
        histogram: processor.finish({
          source: current.source,
          width,
          height,
          totalRows: sampler.sampledRows,
          ownership: 'worker-copy-accepted-under-budget',
          inputByteLength: current.rows.byteLength,
        }),
      })
    } catch (error) {
      if (cancelled.has(runId)) return
      post({
        type: 'failed',
        runId,
        message: error instanceof Error ? error.message : String(error),
      })
    } finally {
      running.delete(runId)
      cancelled.delete(runId)
    }
  }

  return {
    handle(request: HistogramWorkerRequest) {
      switch (request.type) {
        case 'frame':
          frame = request
          return
        case 'lut':
          lut = { id: request.lutId, data: request.data }
          return
        case 'cancel':
          if (running.has(request.runId)) cancelled.add(request.runId)
          return
        case 'run':
          void run(request)
      }
    },
  }
}
