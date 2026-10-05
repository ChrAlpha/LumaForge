import type { ParsedLUT } from '@lumaforge/luma-color-runtime'
import { parseCubeLUT } from '@lumaforge/luma-color-runtime'

import type { CubeParseRequest, CubeParseResponse } from './cube-parse.worker'
import { restorePersistedLUTContract } from './profile-resolution'

export interface CubeParseWorkerLike {
  postMessage: (msg: CubeParseRequest) => void
  terminate: () => void
  addEventListener: (type: string, listener: (event: never) => void) => void
  removeEventListener: (type: string, listener: (event: never) => void) => void
}

export interface ParseCubeOffThreadOptions {
  sourceName?: string
  /** Test seam; per-call workers are not cached. */
  workerFactory?: () => CubeParseWorkerLike
}

const defaultWorkerFactory = (): CubeParseWorkerLike =>
  new Worker(new URL('./cube-parse.worker.ts', import.meta.url), {
    type: 'module',
  }) as unknown as CubeParseWorkerLike

let sharedWorker: CubeParseWorkerLike | null = null
let nextRequestId = 1

function decodeSource(source: string | Uint8Array): string {
  return typeof source === 'string' ? source : new TextDecoder().decode(source)
}

function parseSyncFallback(
  source: string | Uint8Array,
  sourceName?: string,
): ParsedLUT {
  return restorePersistedLUTContract(
    parseCubeLUT(decodeSource(source), { sourceName }),
  )
}

function disposeSharedWorker(worker: CubeParseWorkerLike): void {
  if (sharedWorker === worker) sharedWorker = null
  worker.terminate()
}

/**
 * Parse a .cube on a worker so the 50k–800k line text scan does not block the
 * main thread (a 65³ cube freezes interaction for ~0.8–1.6 s otherwise).
 * Transport failures (no Worker support, worker death) fall back to the
 * synchronous parser; real parse errors reject either way. Both paths parse
 * without storage, then persisted user contracts are restored here by
 * fingerprint, since the worker cannot read them.
 */
export function parseCubeLUTOffThread(
  source: string | Uint8Array,
  options: ParseCubeOffThreadOptions = {},
): Promise<ParsedLUT> {
  const { sourceName, workerFactory } = options
  const usesSharedWorker = !workerFactory

  let worker: CubeParseWorkerLike
  try {
    worker = workerFactory
      ? workerFactory()
      : (sharedWorker ??= defaultWorkerFactory())
  } catch {
    return Promise.resolve().then(() => parseSyncFallback(source, sourceName))
  }

  return new Promise<ParsedLUT>((resolve, reject) => {
    const id = nextRequestId++

    const settle = (run: () => void) => {
      worker.removeEventListener('message', onMessage as never)
      worker.removeEventListener('error', onTransportFailure as never)
      worker.removeEventListener('messageerror', onTransportFailure as never)
      run()
    }

    const fallback = () =>
      settle(() => {
        if (usesSharedWorker) disposeSharedWorker(worker)
        else worker.terminate()
        try {
          resolve(parseSyncFallback(source, sourceName))
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      })

    const onMessage = (event: MessageEvent<CubeParseResponse>) => {
      if (event.data.id !== id) return

      const response = event.data
      settle(() => {
        if (!usesSharedWorker) worker.terminate()
        if (!response.ok) {
          reject(new Error(response.message))
          return
        }
        try {
          resolve(restorePersistedLUTContract(response.parsed))
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      })
    }

    const onTransportFailure = () => fallback()

    worker.addEventListener('message', onMessage as never)
    worker.addEventListener('error', onTransportFailure as never)
    worker.addEventListener('messageerror', onTransportFailure as never)

    try {
      worker.postMessage({ id, source, sourceName })
    } catch {
      fallback()
    }
  })
}
