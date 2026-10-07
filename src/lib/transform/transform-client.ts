import type { Matrix3 } from '@lumaforge/render-engine/geometry'

import type { UprightAnalysis } from '~/lib/transform/geometry/types'
import type { PreviewFrame } from '~/lib/transform/preview-types'
import type { RenderedPreview } from '~/lib/transform/transform-types'
import type {
  TransformRenderRequest,
  TransformWorkerRequest,
  TransformWorkerResponse,
} from '~/lib/transform/worker-protocol'

export type { TransformRenderRequest } from '~/lib/transform/worker-protocol'

/**
 * Why a render produced no frame: the worker refused the geometry
 * (`transform`), or the frame could not be rendered at all (`processing`).
 */
export type TransformRenderFailure = 'transform' | 'processing'

/**
 * What the client publishes. Every event answers the frame most recently
 * loaded, and every render event answers the newest render asked of it;
 * replies to anything replaced, cleared or disposed are never published.
 */
export interface TransformClientEvents {
  analyzed: (analysis: UprightAnalysis, elapsedMs: number) => void
  analysisFailed: () => void
  /** `request` is the request as posted, geometry included. */
  rendered: (request: TransformRenderRequest, result: RenderedPreview) => void
  renderFailed: (
    request: TransformRenderRequest,
    failure: TransformRenderFailure,
  ) => void
  /** The worker died while a frame was loaded; nothing answers it any more. */
  crashed: () => void
}

export interface TransformClientOptions {
  createWorker?: () => Worker
}

export interface TransformRenderTicket {
  request: TransformRenderRequest
  /**
   * False when no worker can answer the request. It is then neither in
   * flight nor queued, so nothing waits on a reply that cannot come.
   */
  posted: boolean
}

export interface TransformClient {
  /**
   * Replace the frame under analysis, retiring everything asked of the
   * previous one. Returns false when the frame could not be handed to a
   * worker.
   */
  load: (frame: PreviewFrame) => boolean
  /** Ask for the frame rendered through `geometry`; the newest ask wins. */
  render: (geometry: {
    matrix: Matrix3
    constrainCrop: boolean
  }) => TransformRenderTicket
  /** Drop the frame but keep a live worker for the next one. */
  clear: () => void
  /** Stop the worker and retire every reply. A later `load` starts over. */
  dispose: () => void
}

function createProductionWorker() {
  return new Worker(new URL('./transform.worker.ts', import.meta.url), {
    type: 'module',
  })
}

/**
 * The only owner of the Transform worker: one worker, monotonic source and
 * request ids, at most one render in flight, and only the newest render
 * waiting behind it.
 */
export function createTransformClient(
  events: TransformClientEvents,
  { createWorker = createProductionWorker }: TransformClientOptions = {},
): TransformClient {
  let worker: Worker | null = null
  let sourceId = 0
  // The source id of the frame the worker holds; differs from `sourceId`
  // once that frame was cleared or the client disposed.
  let loadedSourceId = 0
  let requestId = 0
  let latest: TransformRenderRequest | null = null
  let inFlight = false
  let pending: TransformRenderRequest | null = null

  const retire = () => {
    inFlight = false
    pending = null
    latest = null
  }

  /**
   * Returns false when there is no worker to answer the request. Marking a
   * render in flight against a terminated worker would strand the queue
   * forever, because only a reply clears it.
   */
  const post = (request: TransformRenderRequest) => {
    if (!worker) return false
    if (inFlight) pending = request
    else {
      inFlight = true
      worker.postMessage(request)
    }
    return true
  }

  const receive = (data: TransformWorkerResponse) => {
    if (data.sourceId !== sourceId) return
    if (data.type === 'analyzed') {
      events.analyzed(data.analysis, data.elapsedMs)
      return
    }
    inFlight = false
    const answered = latest
    if (
      answered &&
      data.sourceId === answered.sourceId &&
      data.requestId === answered.requestId
    ) {
      if (data.type === 'rendered') events.rendered(answered, data.result)
      else
        events.renderFailed(
          answered,
          data.message === 'invalid-transform' ? 'transform' : 'processing',
        )
    } else if (data.type === 'error' && data.requestId === undefined) {
      events.analysisFailed()
    }
    if (pending) {
      const next = pending
      pending = null
      post(next)
    }
  }

  const attach = (next: Worker) => {
    next.onerror = () => {
      if (worker !== next) return
      worker = null
      next.terminate()
      inFlight = false
      pending = null
      if (loadedSourceId === sourceId) events.crashed()
    }
    next.onmessage = ({ data }: MessageEvent<TransformWorkerResponse>) => {
      if (worker === next) receive(data)
    }
  }

  return {
    load(frame) {
      const id = ++sourceId
      loadedSourceId = id
      retire()
      try {
        if (!worker) {
          const next = createWorker()
          attach(next)
          worker = next
        }
        worker.postMessage({
          type: 'analyze',
          sourceId: id,
          frame,
        } satisfies TransformWorkerRequest)
        return true
      } catch {
        return false
      }
    },
    render({ matrix, constrainCrop }) {
      const request: TransformRenderRequest = {
        type: 'render',
        sourceId,
        requestId: ++requestId,
        matrix,
        constrainCrop,
      }
      latest = request
      return { request, posted: post(request) }
    },
    clear() {
      const id = ++sourceId
      retire()
      worker?.postMessage({
        type: 'clear',
        sourceId: id,
      } satisfies TransformWorkerRequest)
    },
    dispose() {
      ++sourceId
      retire()
      worker?.terminate()
      worker = null
    },
  }
}
