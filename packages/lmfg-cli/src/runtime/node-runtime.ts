import type { LumaJpegNodeRuntime } from '@lumaforge/luma-jpeg-runtime/node'
import { createLumaJpegRuntimeForNode } from '@lumaforge/luma-jpeg-runtime/node'
import type { LumaRawNodeRuntime } from '@lumaforge/luma-raw-runtime/node'
import { createLumaRawRuntimeForNode } from '@lumaforge/luma-raw-runtime/node'

import { LmfgError, toLmfgError } from '../protocol/errors'
import type { MemoryProfile } from './versions'

export type LmfgRuntime = {
  readonly memoryProfile: MemoryProfile
  raw: () => Promise<LumaRawNodeRuntime>
  jpeg: () => Promise<LumaJpegNodeRuntime>
  dispose: () => void
}

export function createLmfgRuntime(input: {
  memoryProfile: MemoryProfile
}): LmfgRuntime {
  let rawPromise: Promise<LumaRawNodeRuntime> | null = null
  let jpegPromise: Promise<LumaJpegNodeRuntime> | null = null
  let disposed = false

  function assertLive() {
    if (disposed)
      throw new LmfgError('internal', { message: 'Runtime already disposed.' })
  }

  return {
    memoryProfile: input.memoryProfile,
    raw() {
      assertLive()
      rawPromise ??= (async () => {
        try {
          const runtime = await createLumaRawRuntimeForNode({
            memoryProfile: input.memoryProfile,
          })
          await runtime.init()
          return runtime
        } catch (error) {
          const mapped = toLmfgError(error)
          throw mapped.code === 'internal'
            ? new LmfgError('runtime.unavailable', {
                message: `RAW runtime failed to start: ${mapped.message}`,
                cause: error,
              })
            : mapped
        }
      })()
      return rawPromise
    },
    jpeg() {
      assertLive()
      jpegPromise ??= createLumaJpegRuntimeForNode().catch((error: unknown) => {
        throw new LmfgError('runtime.unavailable', {
          message: `JPEG runtime failed to start: ${String(error)}`,
          cause: error,
        })
      })
      return jpegPromise
    },
    dispose() {
      if (disposed) return
      disposed = true
      void rawPromise
        ?.then((runtime) => runtime.dispose())
        .catch(() => undefined)
      void jpegPromise
        ?.then((runtime) => runtime.dispose())
        .catch(() => undefined)
    },
  }
}
