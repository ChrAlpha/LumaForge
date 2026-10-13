import { LumaRawRuntimeError } from './errors'
import type {
  LumaRawWorkerPayloadByType,
  LumaRawWorkerRequest,
  LumaRawWorkerRequestPayloadByType,
  LumaRawWorkerRequestType,
  LumaRawWorkerResponse,
} from './worker-protocol'
import { collectTransferables } from './worker-protocol'

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
  cleanup: () => void
  signal?: AbortSignal
  abortListener?: () => void
}

let requestCounter = 0

function nextRequestId() {
  requestCounter += 1
  return `raw-job-${requestCounter}`
}

export class LumaRawWorkerClient {
  private worker: Worker | null = null
  private disposed = false
  private readonly pending = new Map<string, PendingRequest>()

  constructor(private readonly createWorker: () => Worker) {}

  request<T extends LumaRawWorkerRequestType>(
    type: T,
    payload: LumaRawWorkerRequestPayloadByType[T],
    transfer: Transferable[] = collectTransferables(payload),
    signal?: AbortSignal,
  ): Promise<LumaRawWorkerPayloadByType[T]> {
    const id = nextRequestId()

    return new Promise<LumaRawWorkerPayloadByType[T]>((resolve, reject) => {
      if (this.disposed) {
        reject(
          new LumaRawRuntimeError(
            'RAW_RUNTIME_UNAVAILABLE',
            'RAW runtime worker was disposed.',
          ),
        )
        return
      }

      if (signal?.aborted) {
        reject(
          new LumaRawRuntimeError(
            'RAW_JOB_CANCELLED',
            'RAW runtime job was cancelled.',
          ),
        )
        return
      }

      let worker: Worker
      try {
        worker = this.ensureWorker()
      } catch (error) {
        reject(
          new LumaRawRuntimeError(
            'RAW_WORKER_PROTOCOL_ERROR',
            error instanceof Error
              ? error.message
              : 'RAW runtime worker failed to initialize.',
            { cause: error },
          ),
        )
        return
      }

      const pending: PendingRequest = {
        resolve: resolve as (value: unknown) => void,
        reject,
        signal,
        cleanup: () => {
          if (pending.abortListener && pending.signal) {
            pending.signal.removeEventListener('abort', pending.abortListener)
          }
          this.pending.delete(id)
        },
      }

      pending.abortListener = () => {
        this.rejectPending(
          id,
          new LumaRawRuntimeError(
            'RAW_JOB_CANCELLED',
            'RAW runtime job was cancelled.',
          ),
        )
        try {
          worker.postMessage({
            id: nextRequestId(),
            type: 'cancel',
            payload: { targetJobId: id },
          } satisfies LumaRawWorkerRequest<'cancel'>)
        } catch {
          // Cancellation best-effort only; the original request is already settled.
        }
      }

      signal?.addEventListener('abort', pending.abortListener, { once: true })
      this.pending.set(id, pending)

      try {
        const request = { id, type, payload } satisfies LumaRawWorkerRequest<T>
        worker.postMessage(request, transfer)
      } catch (error) {
        this.rejectPending(
          id,
          new LumaRawRuntimeError(
            'RAW_WORKER_PROTOCOL_ERROR',
            error instanceof Error
              ? error.message
              : 'RAW runtime worker failed to post the request.',
            { cause: error },
          ),
        )
      }
    })
  }

  dispose() {
    const worker = this.worker
    this.worker = null
    this.disposed = true
    this.rejectAllPending(
      new LumaRawRuntimeError(
        'RAW_RUNTIME_UNAVAILABLE',
        'RAW runtime worker was disposed.',
      ),
    )
    worker?.terminate()
  }

  private ensureWorker() {
    if (this.worker) return this.worker

    const worker = this.createWorker()
    worker.onmessage = (event: MessageEvent<LumaRawWorkerResponse>) => {
      this.handleResponse(event.data)
    }
    worker.onerror = (event) => {
      this.worker = null
      const error = new LumaRawRuntimeError(
        'RAW_WORKER_PROTOCOL_ERROR',
        event.message || 'RAW runtime worker failed.',
      )
      this.rejectAllPending(error)
      worker.terminate()
    }
    this.worker = worker
    return worker
  }

  private handleResponse(response: LumaRawWorkerResponse) {
    if (response.ok) {
      this.resolvePending(response.id, response.payload)
      return
    }

    this.rejectPending(
      response.id,
      new LumaRawRuntimeError(response.error.code, response.error.message),
    )
  }

  private resolvePending(id: string, value: unknown) {
    const pending = this.pending.get(id)
    if (!pending) return
    pending.cleanup()
    pending.resolve(value)
  }

  private rejectPending(id: string, reason: unknown) {
    const pending = this.pending.get(id)
    if (!pending) return
    pending.cleanup()
    pending.reject(reason)
  }

  private rejectAllPending(reason: unknown) {
    for (const id of [...this.pending.keys()]) {
      this.rejectPending(id, reason)
    }
  }
}
