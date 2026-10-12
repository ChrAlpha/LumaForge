import { createHash } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

import { sha256OfBlob } from './blob-sha256'
import type {
  BlobSha256Request,
  BlobSha256Response,
} from './blob-sha256.worker'
import type { BlobSha256WorkerLike } from './blob-sha256-client'
import { sha256OfBlobOffThread } from './blob-sha256-client'

const bytes = new Uint8Array(70_000).map((_, i) => i % 251)
const expected = createHash('sha256').update(bytes).digest('hex')

type Listener = (event: never) => void

/** A worker double that answers each request through `answer`. */
function fakeWorker(
  answer: (
    request: BlobSha256Request,
    emit: (type: string, event: unknown) => void,
  ) => void,
) {
  const listeners = new Map<string, Set<Listener>>()
  const emit = (type: string, event: unknown) => {
    for (const listener of listeners.get(type) ?? []) listener(event as never)
  }
  const worker = {
    postMessage: vi.fn((request: BlobSha256Request) => {
      queueMicrotask(() => answer(request, emit))
    }),
    terminate: vi.fn(),
    addEventListener: (type: string, listener: Listener) => {
      const set = listeners.get(type) ?? new Set()
      set.add(listener)
      listeners.set(type, set)
    },
    removeEventListener: (type: string, listener: Listener) => {
      listeners.get(type)?.delete(listener)
    },
  } satisfies BlobSha256WorkerLike
  return worker
}

describe('sha256OfBlob', () => {
  it('matches node crypto for the same bytes', async () => {
    expect(await sha256OfBlob(new Blob([bytes]))).toBe(expected)
  })
})

describe('sha256OfBlobOffThread', () => {
  it('returns the worker digest and terminates the worker', async () => {
    const worker = fakeWorker((request, emit) => {
      emit('message', {
        data: { id: request.id, ok: true, sha256: 'from-worker' },
      } satisfies { data: BlobSha256Response })
    })
    const blob = new Blob([bytes])

    await expect(
      sha256OfBlobOffThread(blob, { workerFactory: () => worker }),
    ).resolves.toBe('from-worker')
    expect(worker.postMessage.mock.lastCall?.[0].blob).toBe(blob)
    expect(worker.terminate).toHaveBeenCalledOnce()
  })

  it('rejects with the worker read error', async () => {
    const worker = fakeWorker((request, emit) => {
      emit('message', {
        data: { id: request.id, ok: false, message: 'NotReadableError' },
      })
    })

    await expect(
      sha256OfBlobOffThread(new Blob([bytes]), {
        workerFactory: () => worker,
      }),
    ).rejects.toThrow('NotReadableError')
    expect(worker.terminate).toHaveBeenCalledOnce()
  })

  it('hashes on the calling thread when the worker dies', async () => {
    const worker = fakeWorker((_request, emit) => {
      emit('error', new Event('error'))
    })

    await expect(
      sha256OfBlobOffThread(new Blob([bytes]), {
        workerFactory: () => worker,
      }),
    ).resolves.toBe(expected)
    expect(worker.terminate).toHaveBeenCalledOnce()
  })

  it('hashes on the calling thread without worker support', async () => {
    await expect(
      sha256OfBlobOffThread(new Blob([bytes]), {
        workerFactory: () => {
          throw new ReferenceError('Worker is not defined')
        },
      }),
    ).resolves.toBe(expected)
  })
})
