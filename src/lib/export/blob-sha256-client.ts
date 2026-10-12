import { sha256OfBlob } from './blob-sha256'
import type {
  BlobSha256Request,
  BlobSha256Response,
} from './blob-sha256.worker'

export interface BlobSha256WorkerLike {
  postMessage: (msg: BlobSha256Request) => void
  terminate: () => void
  addEventListener: (type: string, listener: (event: never) => void) => void
  removeEventListener: (type: string, listener: (event: never) => void) => void
}

export interface Sha256OfBlobOffThreadOptions {
  /** Test seam; the default starts a worker per call. */
  workerFactory?: () => BlobSha256WorkerLike
}

const defaultWorkerFactory = (): BlobSha256WorkerLike =>
  new Worker(new URL('./blob-sha256.worker.ts', import.meta.url), {
    type: 'module',
  }) as unknown as BlobSha256WorkerLike

let nextRequestId = 1

/**
 * Streaming SHA-256 of a Blob or File on a worker. Hashing a RAW source on
 * the main thread held it for over a second at the end of every export; the
 * worker reads the same chunks without blocking input or rendering. A File
 * crosses to the worker by reference, not as a copy. Transport failures (no
 * Worker support, worker death) fall back to hashing on the calling thread;
 * a read error rejects either way. Each call has its own worker, terminated
 * once it answers.
 */
export function sha256OfBlobOffThread(
  blob: Blob,
  options: Sha256OfBlobOffThreadOptions = {},
): Promise<string> {
  let worker: BlobSha256WorkerLike
  try {
    worker = (options.workerFactory ?? defaultWorkerFactory)()
  } catch {
    return sha256OfBlob(blob)
  }

  return new Promise<string>((resolve, reject) => {
    const id = nextRequestId++

    const settle = () => {
      worker.removeEventListener('message', onMessage as never)
      worker.removeEventListener('error', onTransportFailure as never)
      worker.removeEventListener('messageerror', onTransportFailure as never)
      worker.terminate()
    }

    const onMessage = (event: MessageEvent<BlobSha256Response>) => {
      if (event.data.id !== id) return
      const response = event.data
      settle()
      if (response.ok) resolve(response.sha256)
      else reject(new Error(response.message))
    }

    const onTransportFailure = () => {
      settle()
      sha256OfBlob(blob).then(resolve, reject)
    }

    worker.addEventListener('message', onMessage as never)
    worker.addEventListener('error', onTransportFailure as never)
    worker.addEventListener('messageerror', onTransportFailure as never)

    try {
      worker.postMessage({ id, blob })
    } catch {
      onTransportFailure()
    }
  })
}
