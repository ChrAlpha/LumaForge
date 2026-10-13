import type {
  JpegWorkerChunk,
  JpegWorkerErrorResponse,
  JpegWorkerRequest,
  JpegWorkerResponse,
} from '../worker/runtime-core'

export type LumaJpegEncoderOptions = {
  width: number
  height: number
  quality: number
  finishMode?: 'blob' | 'chunks'
}

export type LumaJpegEncoder = {
  writeRows: (rows: Uint8Array, rowCount: number) => Promise<void>
  finish: () => Promise<Blob>
  abort: () => void
}

/** One run of the JPEG stream, at its offset; the last one is final. */
export type LumaJpegChunk = JpegWorkerChunk

export type LumaJpegRuntime = {
  createEncoder: (options: LumaJpegEncoderOptions) => LumaJpegEncoder
  dispose: () => void
}

export type LumaJpegRuntimeOptions = {
  workerFactory?: () => Worker
  onChunk?: (chunk: LumaJpegChunk) => void | Promise<void>
}

type WorkerResponse = JpegWorkerResponse | JpegWorkerErrorResponse

type RowTransfer = {
  rows: Uint8Array
  transfer: Transferable[]
}

const defaultWorkerFactory = () =>
  new Worker(new URL('../worker/runtime.worker.ts', import.meta.url), {
    type: 'module',
  })

function createRowTransfer(rows: Uint8Array): RowTransfer {
  if (
    rows.buffer instanceof ArrayBuffer &&
    rows.byteOffset === 0 &&
    rows.byteLength === rows.buffer.byteLength
  ) {
    return { rows, transfer: [rows.buffer] }
  }

  const tightRows = new Uint8Array(rows.byteLength)
  tightRows.set(rows)
  return { rows: tightRows, transfer: [tightRows.buffer] }
}

export function createLumaJpegRuntime(
  options: LumaJpegRuntimeOptions = {},
): LumaJpegRuntime {
  const worker = (options.workerFactory ?? defaultWorkerFactory)()
  const pending = new Map<
    string,
    {
      resolve: (response: JpegWorkerResponse) => void
      reject: (error: Error) => void
      chunkQueue: Promise<void>
    }
  >()
  let nextRequestId = 0
  let disposed = false
  let encoderActive = false

  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const response = event.data
    const request = pending.get(response.id)
    if (!request) {
      return
    }

    if (response.ok) {
      if (response.type === 'chunk') {
        if (options.onChunk) {
          request.chunkQueue = request.chunkQueue.then(() =>
            options.onChunk!(response.payload),
          )
          void request.chunkQueue.catch(() => {})
        }
        return
      }

      if (response.type === 'finish') {
        request.chunkQueue.then(
          () => {
            if (pending.get(response.id) !== request) {
              return
            }
            pending.delete(response.id)
            request.resolve(response)
          },
          (error) => {
            if (pending.get(response.id) !== request) {
              return
            }
            pending.delete(response.id)
            request.reject(
              error instanceof Error ? error : new Error(String(error)),
            )
          },
        )
      } else {
        pending.delete(response.id)
        request.resolve(response)
      }
      return
    }

    pending.delete(response.id)
    request.reject(
      new Error(response.error.message || 'JPEG_RUNTIME_WORKER_ERROR'),
    )
  }

  worker.onerror = (event) => {
    const message = event.message || 'JPEG_RUNTIME_WORKER_ERROR'
    for (const request of pending.values()) {
      request.reject(new Error(message))
    }
    pending.clear()
  }

  function sendRequest(
    request: Omit<JpegWorkerRequest, 'id'>,
    transfer: Transferable[] = [],
  ) {
    if (disposed) {
      return Promise.reject(new Error('JPEG_RUNTIME_DISPOSED'))
    }

    const id = `jpeg-${(nextRequestId += 1)}`
    const message = { ...request, id } as JpegWorkerRequest

    return new Promise<JpegWorkerResponse>((resolve, reject) => {
      pending.set(id, { resolve, reject, chunkQueue: Promise.resolve() })
      try {
        worker.postMessage(message, transfer)
      } catch (error) {
        pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  return {
    createEncoder(encoderOptions) {
      if (encoderActive) {
        throw new Error('JPEG_RUNTIME_ENCODER_ACTIVE')
      }

      let state: 'open' | 'finished' | 'aborted' = 'open'
      encoderActive = true
      const createPromise = sendRequest({
        type: 'create',
        payload: encoderOptions,
      }).catch((error) => {
        encoderActive = false
        throw error
      })

      function assertOpen() {
        if (state === 'finished') {
          throw new Error('JPEG_RUNTIME_FINISHED')
        }
        if (state === 'aborted') {
          throw new Error('JPEG_RUNTIME_ABORTED')
        }
      }

      return {
        async writeRows(rows, rowCount) {
          assertOpen()

          await createPromise
          assertOpen()

          const rowTransfer = createRowTransfer(rows)
          await sendRequest(
            {
              type: 'rows',
              payload: { rows: rowTransfer.rows, rowCount },
            },
            rowTransfer.transfer,
          )
        },

        async finish() {
          assertOpen()

          await createPromise
          assertOpen()

          const response = await sendRequest({
            type: 'finish',
            payload: {},
          })
          assertOpen()
          if (response.type !== 'finish') {
            throw new Error('JPEG_RUNTIME_UNEXPECTED_RESPONSE')
          }

          state = 'finished'
          encoderActive = false
          return response.payload.blob
        },

        abort() {
          if (state !== 'open') {
            return
          }

          state = 'aborted'
          void createPromise
            .then(() =>
              sendRequest({
                type: 'abort',
                payload: {},
              }),
            )
            .finally(() => {
              encoderActive = false
            })
            .catch(() => {})
        },
      }
    },

    dispose() {
      if (disposed) {
        return
      }

      disposed = true
      for (const request of pending.values()) {
        request.reject(new Error('JPEG_RUNTIME_DISPOSED'))
      }
      pending.clear()
      worker.terminate()
    },
  }
}
