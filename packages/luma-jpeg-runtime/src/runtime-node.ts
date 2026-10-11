import { loadNativeModuleForNode } from '@lumaforge/luma-native-artifacts/load-for-node'

import { createNativeJpegEncoderFactory } from '../worker/native-adapter'
import type {
  InternalJpegEncoderFactoryLoader,
  JpegWorkerRequest,
  JpegWorkerResponse,
} from '../worker/runtime-core'
import { createJpegRuntimeCore } from '../worker/runtime-core'
import type { LumaJpegChunk, LumaJpegEncoderOptions } from './runtime'

type JpegRequestType = JpegWorkerRequest['type']
type JpegRequestPayloadByType = {
  [R in JpegWorkerRequest as R['type']]: R['payload']
}
// runtime-core's JpegWorkerResponse is success-only (failures are thrown
// and converted to failure envelopes by the Worker shim). Indexing it by
// `type` gives the per-request response shape for the in-process path.
type JpegResponseByType = { [R in JpegWorkerResponse as R['type']]: R }

export type LumaJpegNodeNativeLoader = () => Promise<unknown>

export type LumaJpegNodeRuntimeOptions = {
  /**
   * Override the default native module loader (tests, custom artifact paths).
   * Returns the Emscripten module instance, matching the shape produced by
   * `@lumaforge/luma-native-artifacts/load-for-node`.
   */
  nativeLoader?: LumaJpegNodeNativeLoader
  /**
   * Optional callback invoked for each JPEG chunk produced when an encoder
   * is created with `finishMode: 'chunks'`. Receives Uint8Array bytes
   * directly (no Blob conversion). Both synchronous throws and async
   * rejections are surfaced via the awaiting `finish()`.
   */
  onChunk?: (chunk: LumaJpegChunk) => void | Promise<void>
}

export type LumaJpegNodeEncoder = {
  writeRows: (rows: Uint8Array, rowCount: number) => Promise<void>
  /** Resolves with the full JPEG byte stream (or empty in chunks mode). */
  finish: () => Promise<Uint8Array>
  /**
   * Releases the encoder. Resolves once it is released (or was never
   * created) and rejects when releasing it failed. A call made while an
   * abort is in flight settles with that abort.
   */
  abort: () => Promise<void>
}

export type LumaJpegNodeRuntime = {
  createEncoder: (options: LumaJpegEncoderOptions) => LumaJpegNodeEncoder
  dispose: () => void
}

const defaultNativeLoader: LumaJpegNodeNativeLoader = () =>
  loadNativeModuleForNode({ kind: 'jpeg' })

function makeRequestId(counter: { value: number }): string {
  counter.value += 1
  return `jpeg-node-${counter.value}`
}

/**
 * Convert a runtime-core Blob into a Uint8Array.
 *
 * Requires Node 18+ (global Blob with `arrayBuffer()`). jsdom-flavored test
 * environments may lack `arrayBuffer` on their Blob polyfill; the Node-entry
 * test file therefore uses `@vitest-environment node`.
 */
async function blobToUint8Array(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer())
}

export async function createLumaJpegRuntimeForNode(
  options: LumaJpegNodeRuntimeOptions = {},
): Promise<LumaJpegNodeRuntime> {
  const nativeLoader = options.nativeLoader ?? defaultNativeLoader

  const encoderFactoryLoader: InternalJpegEncoderFactoryLoader = async () => {
    let nativeModule: unknown
    try {
      nativeModule = await nativeLoader()
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error)
      throw new Error(`LUMA_JPEG_NATIVE_LOAD_FAILED: ${cause}`)
    }
    return createNativeJpegEncoderFactory(
      nativeModule as Parameters<typeof createNativeJpegEncoderFactory>[0],
    )
  }

  let disposed = false
  let encoderActive = false
  const counter = { value: 0 }
  const chunkQueue: Array<Promise<void>> = []

  const core = createJpegRuntimeCore(encoderFactoryLoader, {
    onResponse: async (response) => {
      if (!response.ok) return
      if (response.type !== 'chunk') return
      if (!options.onChunk) return
      // Promise.resolve().then(...) converts a synchronous throw inside
      // options.onChunk into an async rejection on `task`. Without this,
      // a sync throw escapes onResponse and rejects the current
      // dispatch (rows/finish) directly, inconsistent with the
      // "surfaced at finish()" contract.
      const task = Promise.resolve()
        .then(() => options.onChunk!(response.payload))
        .then(() => undefined)
      chunkQueue.push(task)
      try {
        await task
      } catch {
        // swallowed here; drainChunkQueue re-throws via Promise.all
      }
    },
  })

  function assertLive(): void {
    if (disposed) {
      throw new Error('LUMA_JPEG_RUNTIME_DISPOSED')
    }
  }

  async function dispatch<T extends JpegRequestType>(
    type: T,
    payload: JpegRequestPayloadByType[T],
  ): Promise<JpegResponseByType[T]> {
    const request = {
      id: makeRequestId(counter),
      type,
      payload,
    } as JpegWorkerRequest
    const response = (await core.handleRequest(request)) as JpegWorkerResponse
    if (!response.ok) {
      throw new Error('LUMA_JPEG_RUNTIME_UNEXPECTED_FAILURE')
    }
    return response as JpegResponseByType[T]
  }

  async function drainChunkQueue(): Promise<void> {
    const inFlight = [...chunkQueue]
    chunkQueue.length = 0
    await Promise.all(inFlight)
  }

  function createEncoder(
    encoderOptions: LumaJpegEncoderOptions,
  ): LumaJpegNodeEncoder {
    assertLive()
    if (encoderActive) {
      throw new Error('LUMA_JPEG_RUNTIME_ENCODER_ACTIVE')
    }
    encoderActive = true

    let state: 'open' | 'finished' | 'aborted' = 'open'
    let abortPromise: Promise<void> | undefined
    const createPromise = dispatch('create', encoderOptions).catch((error) => {
      state = 'aborted'
      encoderActive = false
      throw error
    })

    function assertOpen(): void {
      if (state === 'finished') {
        throw new Error('LUMA_JPEG_RUNTIME_FINISHED')
      }
      if (state === 'aborted') {
        throw new Error('LUMA_JPEG_RUNTIME_ABORTED')
      }
    }

    return {
      async writeRows(rows: Uint8Array, rowCount: number) {
        assertOpen()
        await createPromise
        assertOpen()
        await dispatch('rows', { rows, rowCount })
      },

      async finish() {
        assertOpen()
        await createPromise
        assertOpen()
        const response = await dispatch('finish', {})
        await drainChunkQueue()
        state = 'finished'
        encoderActive = false
        return blobToUint8Array(response.payload.blob)
      },

      abort() {
        // A call made while an abort is in flight settles with it, so none
        // reports the encoder released before it is. Once that abort has
        // settled, later calls resolve at once like any other closed encoder.
        if (abortPromise) return abortPromise
        if (state !== 'open') return Promise.resolve()
        state = 'aborted'
        abortPromise = (async () => {
          try {
            // An encoder that was never created has nothing to release; its
            // creation failure is reported by the call that awaited it.
            const created = await createPromise.then(
              () => true,
              () => false,
            )
            if (created) await dispatch('abort', {})
          } finally {
            encoderActive = false
            abortPromise = undefined
          }
        })()
        return abortPromise
      },
    }
  }

  return {
    createEncoder,
    dispose() {
      disposed = true
    },
  }
}
