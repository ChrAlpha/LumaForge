import type { SupportedExportColorGraphDescriptor } from '@lumaforge/luma-color-runtime'

import type {
  CpuPreviewFailureReason,
  CpuPreviewRequest,
  CpuPreviewResponse,
  CpuPreviewVariant,
} from './protocol'

export type CpuPreviewWorkerLike = {
  postMessage: (msg: CpuPreviewRequest, transfer?: Transferable[]) => void
  onmessage: ((e: { data: CpuPreviewResponse }) => void) | null
  onerror: ((e: unknown) => void) | null
  terminate: () => void
}

export type CpuPreviewFrame = {
  requestId: number
  sourceId: string
  rgba: Uint8ClampedArray
  width: number
  height: number
}

type PendingRender = {
  variant: CpuPreviewVariant
  graph: SupportedExportColorGraphDescriptor
}

const defaultWorkerFactory = (): CpuPreviewWorkerLike =>
  new Worker(new URL('./browser-worker.ts', import.meta.url), {
    type: 'module',
  }) as unknown as CpuPreviewWorkerLike

export class CpuPreviewClient {
  private worker: CpuPreviewWorkerLike | null = null
  private sourceId: string | null = null
  private nextRequestId = 1
  private inFlightId: number | null = null
  private inFlightRequest: PendingRender | null = null
  private pending: PendingRender | null = null
  private frameHandler:
    | ((f: CpuPreviewFrame, request: PendingRender) => void)
    | null = null
  private errorHandler: ((r: CpuPreviewFailureReason) => void) | null = null

  constructor(
    private readonly factory: () => CpuPreviewWorkerLike = defaultWorkerFactory,
  ) {}

  /**
   * Each frame comes with the request it answers: the render that was in
   * flight, not a request still queued behind it.
   */
  onFrame(fn: (f: CpuPreviewFrame, request: PendingRender) => void) {
    this.frameHandler = fn
  }
  onError(fn: (r: CpuPreviewFailureReason) => void) {
    this.errorHandler = fn
  }

  private ensureWorker(): CpuPreviewWorkerLike | null {
    if (this.worker) return this.worker
    let worker: CpuPreviewWorkerLike
    try {
      worker = this.factory()
    } catch {
      this.errorHandler?.('worker-construction-failed')
      return null
    }
    worker.onmessage = (e) => this.handle(e.data)
    worker.onerror = () => {
      this.inFlightId = null
      this.pending = null
      this.errorHandler?.('worker-module-load-failed')
    }
    this.worker = worker
    return worker
  }

  loadSource(input: {
    sourceId: string
    width: number
    height: number
    data: Uint16Array
  }) {
    const worker = this.ensureWorker()
    if (!worker) return
    // Release the previously-owned source in the worker before loading a new
    // one, so the worker's source map does not retain stale image buffers.
    if (this.sourceId && this.sourceId !== input.sourceId) {
      try {
        worker.postMessage({ type: 'disposeSource', sourceId: this.sourceId })
      } catch {
        // Best-effort cleanup; a failed cleanup must not crash the workspace.
      }
    }
    this.sourceId = input.sourceId
    this.inFlightId = null
    this.pending = null
    try {
      const copy = input.data.slice()
      worker.postMessage(
        {
          type: 'loadSource',
          sourceId: input.sourceId,
          width: input.width,
          height: input.height,
          data: copy,
        },
        [copy.buffer],
      )
    } catch {
      this.sourceId = null
      this.errorHandler?.('source-transfer-failed')
    }
  }

  requestRender(req: PendingRender) {
    if (!this.sourceId) {
      // Callers arm their in-flight state before requesting; dropping the
      // request silently (e.g. after a failed source transfer) would leave
      // that state wedged forever, so report it through the error channel.
      this.errorHandler?.('render-failed')
      return
    }
    if (this.inFlightId != null) {
      this.pending = req
      return
    }
    this.post(req)
  }

  private post(req: PendingRender) {
    const worker = this.ensureWorker()
    if (!worker) return
    const requestId = this.nextRequestId++
    this.inFlightId = requestId
    this.inFlightRequest = req
    try {
      worker.postMessage({
        type: 'render',
        sourceId: this.sourceId!,
        requestId,
        graph: req.graph,
        variant: req.variant,
      })
    } catch {
      this.inFlightId = null
      this.errorHandler?.('render-failed')
    }
  }

  private handle(res: CpuPreviewResponse) {
    if (res.type === 'error') {
      const sourceMatches = res.sourceId === this.sourceId
      const requestMatches =
        res.requestId == null || res.requestId === this.inFlightId
      if (!sourceMatches || !requestMatches) {
        return
      }
      this.inFlightId = null
      this.errorHandler?.(res.reason)
      this.flushPending()
      return
    }
    const request = this.inFlightRequest
    const isLatest =
      res.requestId === this.inFlightId && res.sourceId === this.sourceId
    this.inFlightId = null
    this.inFlightRequest = null
    if (isLatest && request) {
      this.frameHandler?.(
        {
          requestId: res.requestId,
          sourceId: res.sourceId,
          rgba: res.rgba,
          width: res.width,
          height: res.height,
        },
        request,
      )
    }
    this.flushPending()
  }

  private flushPending() {
    if (this.pending && this.sourceId) {
      const next = this.pending
      this.pending = null
      this.post(next)
    }
  }

  dispose() {
    if (this.worker && this.sourceId) {
      this.worker.postMessage({
        type: 'disposeSource',
        sourceId: this.sourceId,
      })
    }
    this.worker?.terminate()
    this.worker = null
    this.sourceId = null
    this.inFlightId = null
    this.pending = null
  }
}
