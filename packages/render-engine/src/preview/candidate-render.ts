// Multi-param candidate render.
//
// Signature returns an AsyncIterable<CandidateResult> with a maxConcurrent
// cap, so callers can `for await (...)` and process / discard candidates
// as they complete instead of buffering N output blobs in memory. This is
// the floor of safety until a shared preview/candidate/export back-pressure
// budget (`render-budget`) exists.

import type { SupportedExportColorGraphDescriptor } from '@lumaforge/luma-color-runtime'

import type { PreviewJpegEncoderFactory } from './preview-jpeg-encode'
import { encodePreviewFrameToJpeg } from './preview-jpeg-encode'
import { renderCpuPreviewFrame } from './preview-render'

export type CandidateParams = {
  readonly graph: SupportedExportColorGraphDescriptor
  readonly quality?: number
  readonly tag?: string
}

export type CandidateResult = {
  readonly index: number
  readonly params: CandidateParams
  readonly width: number
  readonly height: number
  readonly rgba: Uint8ClampedArray
  /** Whatever the encoder's `finish()` returned (Blob in browser, Uint8Array in Node). */
  readonly outputBytes: unknown
}

export type CandidateRenderSource = {
  readonly data: Uint16Array
  readonly width: number
  readonly height: number
}

export type CandidateRenderOptions = {
  readonly source: CandidateRenderSource
  readonly params: readonly CandidateParams[]
  readonly maxConcurrent: number
  readonly createEncoder: PreviewJpegEncoderFactory
  readonly signal?: AbortSignal
}

/**
 * Render a slate of candidate parameter sets in parallel, yielding each
 * result as soon as it completes. Bounded by `maxConcurrent`; respects
 * `signal` between candidate boundaries.
 */
export function candidateRender(
  options: CandidateRenderOptions,
): AsyncIterable<CandidateResult> {
  return { [Symbol.asyncIterator]: () => createIterator(options) }
}

function createIterator(
  options: CandidateRenderOptions,
): AsyncIterator<CandidateResult> {
  const { params, signal } = options
  const maxConcurrent = Math.max(1, Math.floor(options.maxConcurrent))
  let nextStart = 0
  // Active set keyed by promise identity. Yielded by completion order via
  // Promise.race — a slow candidate 0 does NOT hold back a fast candidate
  // 1 from being surfaced, which is the documented streaming /
  // back-pressure contract.
  const inFlight = new Set<Promise<CandidateResult>>()
  let done = false

  function ensurePending(): void {
    while (inFlight.size < maxConcurrent && nextStart < params.length) {
      const index = nextStart
      nextStart += 1
      const promise: Promise<CandidateResult> = renderCandidate(
        options,
        index,
        params[index],
      ).finally(() => inFlight.delete(promise))
      inFlight.add(promise)
    }
  }

  return {
    async next(): Promise<IteratorResult<CandidateResult>> {
      if (done) return { value: undefined, done: true }
      if (signal?.aborted) {
        done = true
        throw signal.reason ?? new Error('CANDIDATE_RENDER_ABORTED')
      }
      ensurePending()
      if (inFlight.size === 0) {
        done = true
        return { value: undefined, done: true }
      }
      const next = await Promise.race(inFlight)
      return { value: next, done: false }
    },
    async return(): Promise<IteratorResult<CandidateResult>> {
      done = true
      await Promise.allSettled(inFlight)
      inFlight.clear()
      return { value: undefined, done: true }
    },
  }
}

async function renderCandidate(
  options: CandidateRenderOptions,
  index: number,
  param: CandidateParams,
): Promise<CandidateResult> {
  const { source, signal } = options
  if (signal?.aborted) {
    throw signal.reason ?? new Error('CANDIDATE_RENDER_ABORTED')
  }
  const rgba = renderCpuPreviewFrame({
    data: source.data,
    width: source.width,
    height: source.height,
    graph: param.graph,
  })
  const outputBytes = await encodePreviewFrameToJpeg(options.createEncoder, {
    rgba,
    width: source.width,
    height: source.height,
    quality: param.quality,
  })
  return {
    index,
    params: param,
    width: source.width,
    height: source.height,
    rgba,
    outputBytes,
  }
}
