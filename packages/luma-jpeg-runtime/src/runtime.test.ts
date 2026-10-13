import type {
  JpegWorkerRequest,
  JpegWorkerResponse,
} from '../worker/runtime-core'
import { createJpegRuntimeCore } from '../worker/runtime-core'
import type { LumaJpegChunk } from './runtime'
import { createLumaJpegRuntime } from './runtime'

type JpegWorkerErrorResponse = {
  id: string
  ok: false
  type: JpegWorkerRequest['type']
  error: { message: string }
}

type WorkerResponse = JpegWorkerResponse | JpegWorkerErrorResponse

type PostedMessage = {
  request: JpegWorkerRequest
  transfer: Transferable[]
}

class CoreBackedWorker {
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  // Streams the start-of-image marker with the first rows and the
  // end-of-image marker from finish.
  private readonly core = createJpegRuntimeCore(async () => () => {
    let offset = 0
    return {
      async writeRows() {
        if (offset > 0) return []
        offset = 2
        return [
          { bytes: new Uint8Array([255, 216]), byteOffset: 0, final: false },
        ]
      },
      async finish() {
        return [
          {
            bytes: new Uint8Array([255, 217]),
            byteOffset: offset,
            final: true,
          },
        ]
      },
      abort() {},
    }
  })

  postMessage(request: JpegWorkerRequest) {
    void this.core
      .handleRequest(request)
      .then((response) => {
        queueMicrotask(() => {
          this.onmessage?.({ data: response } as MessageEvent<WorkerResponse>)
        })
      })
      .catch((error) => {
        queueMicrotask(() => {
          this.onmessage?.({
            data: {
              id: request.id,
              ok: false,
              type: request.type,
              error: {
                message: error instanceof Error ? error.message : String(error),
              },
            },
          } as MessageEvent<WorkerResponse>)
        })
      })
  }

  terminate() {}
}

class ManualWorker {
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  readonly posts: PostedMessage[] = []

  postMessage(request: JpegWorkerRequest, transfer: Transferable[] = []) {
    this.posts.push({ request, transfer })
  }

  respond(request: JpegWorkerRequest, response?: Partial<JpegWorkerResponse>) {
    const payload =
      response?.payload ??
      (request.type === 'finish'
        ? {
            blob: new Blob([new Uint8Array([0xFF, 0xD8, 0xFF, 0xD9])], {
              type: 'image/jpeg',
            }),
          }
        : request.type === 'rows'
          ? { writtenRows: 1 }
          : request.type === 'abort'
            ? { aborted: true }
            : { created: true })

    queueMicrotask(() => {
      this.onmessage?.({
        data: {
          id: request.id,
          ok: true,
          type: request.type,
          payload,
        } as JpegWorkerResponse,
      } as MessageEvent<WorkerResponse>)
    })
  }

  emit(response: WorkerResponse) {
    queueMicrotask(() => {
      this.onmessage?.({
        data: response,
      } as MessageEvent<WorkerResponse>)
    })
  }

  terminate() {}
}

async function drainMicrotasks() {
  await Promise.resolve()
  await Promise.resolve()
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve
    reject = innerReject
  })

  return { promise, resolve, reject }
}

describe('createLumaJpegRuntime', () => {
  it('returns the worker-assembled JPEG blob from finish', async () => {
    const runtime = createLumaJpegRuntime({
      workerFactory: () => new CoreBackedWorker() as unknown as Worker,
    })
    const encoder = runtime.createEncoder({ width: 3, height: 5, quality: 0.9 })

    await encoder.writeRows(
      new Uint8Array([
        255, 255, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0,
        255, 0, 255, 0, 255, 255, 64, 64, 64,
      ]),
      3,
    )
    await encoder.writeRows(
      new Uint8Array([
        128, 0, 0, 0, 128, 0, 0, 0, 128, 255, 128, 0, 0, 128, 255, 128, 128,
        128,
      ]),
      2,
    )
    const blob = await encoder.finish()

    expect(blob.type).toBe('image/jpeg')
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(
      new Uint8Array([255, 216, 255, 217]),
    )
    runtime.dispose()
  })

  it('preserves worker failure messages', async () => {
    const runtime = createLumaJpegRuntime({
      workerFactory: () => new CoreBackedWorker() as unknown as Worker,
    })
    const encoder = runtime.createEncoder({ width: 2, height: 1, quality: 0.9 })

    await expect(
      encoder.writeRows(new Uint8Array([255, 255, 255]), 1),
    ).rejects.toThrow('JPEG_ROW_LENGTH_MISMATCH')
    runtime.dispose()
  })

  it('rejects a second public encoder while one is active', async () => {
    const worker = new ManualWorker()
    const runtime = createLumaJpegRuntime({
      workerFactory: () => worker as unknown as Worker,
    })

    runtime.createEncoder({ width: 1, height: 1, quality: 0.9 })

    expect(() =>
      runtime.createEncoder({ width: 1, height: 1, quality: 0.9 }),
    ).toThrow('JPEG_RUNTIME_ENCODER_ACTIVE')
    worker.respond(worker.posts[0].request)
    await drainMicrotasks()
    runtime.dispose()
  })

  it('does not post rows when abort wins the create boundary', async () => {
    const worker = new ManualWorker()
    const runtime = createLumaJpegRuntime({
      workerFactory: () => worker as unknown as Worker,
    })
    const encoder = runtime.createEncoder({ width: 1, height: 1, quality: 0.9 })
    const writePromise = encoder.writeRows(new Uint8Array([255, 255, 255]), 1)

    encoder.abort()
    worker.respond(worker.posts[0].request)

    await expect(writePromise).rejects.toThrow('JPEG_RUNTIME_ABORTED')
    expect(worker.posts.map((post) => post.request.type)).toEqual([
      'create',
      'abort',
    ])
    worker.respond(worker.posts[1].request)
    await drainMicrotasks()
    runtime.dispose()
  })

  it('does not post finish when abort wins the create boundary', async () => {
    const worker = new ManualWorker()
    const runtime = createLumaJpegRuntime({
      workerFactory: () => worker as unknown as Worker,
    })
    const encoder = runtime.createEncoder({ width: 1, height: 1, quality: 0.9 })
    const finishPromise = encoder.finish()

    encoder.abort()
    worker.respond(worker.posts[0].request)

    await expect(finishPromise).rejects.toThrow('JPEG_RUNTIME_ABORTED')
    expect(worker.posts.map((post) => post.request.type)).toEqual([
      'create',
      'abort',
    ])
    worker.respond(worker.posts[1].request)
    await drainMicrotasks()
    runtime.dispose()
  })

  it('transfers tight row buffers and copies sliced row views before posting', async () => {
    const worker = new ManualWorker()
    const runtime = createLumaJpegRuntime({
      workerFactory: () => worker as unknown as Worker,
    })
    const encoder = runtime.createEncoder({ width: 1, height: 2, quality: 0.9 })
    worker.respond(worker.posts[0].request)

    const tightRows = new Uint8Array([255, 255, 255])
    const tightWrite = encoder.writeRows(tightRows, 1)
    await drainMicrotasks()
    worker.respond(worker.posts[1].request)
    await tightWrite

    const backingRows = new Uint8Array([0, 99, 99, 99, 0])
    const slicedRows = backingRows.subarray(1, 4)
    const slicedWrite = encoder.writeRows(slicedRows, 1)
    await drainMicrotasks()
    worker.respond(worker.posts[2].request)
    await slicedWrite

    const tightPost = worker.posts[1]
    const slicedPost = worker.posts[2]

    expect(tightPost.transfer).toEqual([tightRows.buffer])
    expect(tightPost.request.type).toBe('rows')
    if (tightPost.request.type !== 'rows') {
      throw new Error('expected rows request')
    }
    expect(tightPost.request.payload.rows.buffer).toBe(tightRows.buffer)

    expect(slicedPost.request.type).toBe('rows')
    if (slicedPost.request.type !== 'rows') {
      throw new Error('expected rows request')
    }
    expect(slicedPost.request.payload.rows).toEqual(
      new Uint8Array([99, 99, 99]),
    )
    expect(slicedPost.request.payload.rows.buffer).not.toBe(backingRows.buffer)
    expect(slicedPost.request.payload.rows.byteOffset).toBe(0)
    expect(slicedPost.request.payload.rows.byteLength).toBe(
      slicedPost.request.payload.rows.buffer.byteLength,
    )
    expect(slicedPost.transfer).toEqual([
      slicedPost.request.payload.rows.buffer,
    ])
    runtime.dispose()
  })

  it('routes chunk responses to onChunk without resolving the active request', async () => {
    const worker = new ManualWorker()
    const chunks: LumaJpegChunk[] = []
    const runtime = createLumaJpegRuntime({
      workerFactory: () => worker as unknown as Worker,
      onChunk: (chunk) => {
        chunks.push(chunk)
      },
    })
    const encoder = runtime.createEncoder({ width: 1, height: 1, quality: 0.9 })
    worker.respond(worker.posts[0].request)
    await drainMicrotasks()

    const finishPromise = encoder.finish()
    let settled = false
    void finishPromise
      .finally(() => {
        settled = true
      })
      .catch(() => {})
    await drainMicrotasks()
    const finishPost = worker.posts[1]
    worker.emit({
      id: finishPost.request.id,
      ok: true,
      type: 'chunk',
      payload: {
        bytes: new Uint8Array([0xFF, 0xD8]),
        byteOffset: 0,
        final: false,
      },
    } as WorkerResponse)
    await drainMicrotasks()

    await drainMicrotasks()

    expect(chunks).toEqual([
      {
        bytes: new Uint8Array([0xFF, 0xD8]),
        byteOffset: 0,
        final: false,
      },
    ])
    expect(settled).toBe(false)

    worker.respond(finishPost.request)
    await expect(finishPromise).resolves.toMatchObject({
      type: 'image/jpeg',
    })
    runtime.dispose()
  })

  it('waits for async chunk handling before resolving finish', async () => {
    const worker = new ManualWorker()
    const chunkHandled = deferred<void>()
    const chunks: LumaJpegChunk[] = []
    const runtime = createLumaJpegRuntime({
      workerFactory: () => worker as unknown as Worker,
      async onChunk(chunk) {
        chunks.push(chunk)
        await chunkHandled.promise
      },
    })
    const encoder = runtime.createEncoder({ width: 1, height: 1, quality: 0.9 })
    worker.respond(worker.posts[0].request)
    await drainMicrotasks()

    const finishPromise = encoder.finish()
    let settled = false
    void finishPromise
      .finally(() => {
        settled = true
      })
      .catch(() => {})
    await drainMicrotasks()
    const finishPost = worker.posts[1]
    worker.emit({
      id: finishPost.request.id,
      ok: true,
      type: 'chunk',
      payload: {
        bytes: new Uint8Array([0xFF, 0xD8]),
        byteOffset: 0,
        final: true,
      },
    } as WorkerResponse)
    await drainMicrotasks()
    worker.respond(finishPost.request)
    await drainMicrotasks()

    expect(settled).toBe(false)
    expect(chunks).toHaveLength(1)

    chunkHandled.resolve()
    await expect(finishPromise).resolves.toMatchObject({
      type: 'image/jpeg',
    })
    runtime.dispose()
  })

  it('rejects finish when async chunk handling fails', async () => {
    const worker = new ManualWorker()
    const runtime = createLumaJpegRuntime({
      workerFactory: () => worker as unknown as Worker,
      async onChunk() {
        throw new Error('OPFS_CHUNK_WRITE_FAILED')
      },
    })
    const encoder = runtime.createEncoder({ width: 1, height: 1, quality: 0.9 })
    worker.respond(worker.posts[0].request)
    await drainMicrotasks()

    const finishPromise = encoder.finish()
    await drainMicrotasks()
    const finishPost = worker.posts[1]
    worker.emit({
      id: finishPost.request.id,
      ok: true,
      type: 'chunk',
      payload: {
        bytes: new Uint8Array([0xFF, 0xD8]),
        byteOffset: 0,
        final: true,
      },
    } as WorkerResponse)
    await drainMicrotasks()
    worker.respond(finishPost.request)

    await expect(finishPromise).rejects.toThrow('OPFS_CHUNK_WRITE_FAILED')
    runtime.dispose()
  })

  it('rejects finish when dispose wins during async chunk handling', async () => {
    const worker = new ManualWorker()
    const chunkHandled = deferred<void>()
    const runtime = createLumaJpegRuntime({
      workerFactory: () => worker as unknown as Worker,
      async onChunk() {
        await chunkHandled.promise
      },
    })
    const encoder = runtime.createEncoder({ width: 1, height: 1, quality: 0.9 })
    worker.respond(worker.posts[0].request)
    await drainMicrotasks()

    const finishPromise = encoder.finish()
    await drainMicrotasks()
    const finishPost = worker.posts[1]
    worker.emit({
      id: finishPost.request.id,
      ok: true,
      type: 'chunk',
      payload: {
        bytes: new Uint8Array([0xFF, 0xD8]),
        byteOffset: 0,
        final: true,
      },
    } as WorkerResponse)
    await drainMicrotasks()
    worker.respond(finishPost.request)
    await drainMicrotasks()

    runtime.dispose()
    chunkHandled.resolve()

    await expect(finishPromise).rejects.toThrow('JPEG_RUNTIME_DISPOSED')
  })

  it('rejects finish when abort wins during async chunk handling', async () => {
    const worker = new ManualWorker()
    const chunkHandled = deferred<void>()
    const runtime = createLumaJpegRuntime({
      workerFactory: () => worker as unknown as Worker,
      async onChunk() {
        await chunkHandled.promise
      },
    })
    const encoder = runtime.createEncoder({ width: 1, height: 1, quality: 0.9 })
    worker.respond(worker.posts[0].request)
    await drainMicrotasks()

    const finishPromise = encoder.finish()
    await drainMicrotasks()
    const finishPost = worker.posts[1]
    worker.emit({
      id: finishPost.request.id,
      ok: true,
      type: 'chunk',
      payload: {
        bytes: new Uint8Array([0xFF, 0xD8]),
        byteOffset: 0,
        final: true,
      },
    } as WorkerResponse)
    await drainMicrotasks()
    worker.respond(finishPost.request)
    await drainMicrotasks()

    encoder.abort()
    chunkHandled.resolve()

    await expect(finishPromise).rejects.toThrow('JPEG_RUNTIME_ABORTED')
    runtime.dispose()
  })
})
