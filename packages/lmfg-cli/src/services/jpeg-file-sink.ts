import { basename } from 'node:path'

import type { LumaJpegNodeRuntime } from '@lumaforge/luma-jpeg-runtime/node'
import { createLumaJpegRuntimeForNode } from '@lumaforge/luma-jpeg-runtime/node'
import type {
  JpegExportMetadata,
  JpegRowSink,
} from '@lumaforge/render-engine/export'
import { createBytesOutputResult } from '@lumaforge/render-engine/export'

import type { StreamedJpegFile } from './jpeg-file-writer'
import { createStreamingJpegFileWriter } from './jpeg-file-writer'

export type FileJpegRowSink = JpegRowSink & {
  /** The streamed file once `close()` succeeded; `null` before that. */
  result: () => StreamedJpegFile | null
}

/**
 * Row sink for full-resolution export that never holds the JPEG in memory:
 * a dedicated JPEG runtime in chunk mode feeds `createStreamingJpegFileWriter`.
 * The engine still receives an (empty) bytes result so its contract holds;
 * callers read the file identity from `result()`.
 */
export function createFileJpegRowSink(input: {
  path: string
  metadata?: JpegExportMetadata | null
  createRuntime?: typeof createLumaJpegRuntimeForNode
}): FileJpegRowSink {
  let finished: StreamedJpegFile | null = null
  const createRuntime = input.createRuntime ?? createLumaJpegRuntimeForNode

  return {
    result: () => finished,
    createSession({ width, height, quality }) {
      const writer = createStreamingJpegFileWriter({
        path: input.path,
        metadata: input.metadata,
        width,
        height,
      })
      let runtime: LumaJpegNodeRuntime | null = null
      const encoderPromise = createRuntime({
        onChunk: (chunk) => writer.write(chunk.bytes),
      }).then((created) => {
        runtime = created
        return created.createEncoder({
          width,
          height,
          quality,
          finishMode: 'chunks',
        })
      })
      let state: 'open' | 'closed' | 'aborted' = 'open'

      async function abortSession(): Promise<void> {
        if (state !== 'open') return
        state = 'aborted'
        try {
          const encoder = await encoderPromise.catch(() => null)
          encoder?.abort()
        } finally {
          runtime?.dispose()
          await writer.abort()
        }
      }

      return {
        async writeRows(rows, rowCount) {
          if (state !== 'open') throw new Error('JPEG_WRITER_CLOSED')
          try {
            const encoder = await encoderPromise
            await encoder.writeRows(rows, rowCount)
          } catch (error) {
            await abortSession().catch(() => undefined)
            throw error
          }
        },
        async close() {
          if (state !== 'open') throw new Error('JPEG_WRITER_CLOSED')
          try {
            const encoder = await encoderPromise
            await encoder.finish()
            runtime?.dispose()
            finished = await writer.finish()
            state = 'closed'
            return createBytesOutputResult({
              filename: basename(input.path),
              bytes: new Uint8Array(0),
            })
          } catch (error) {
            await abortSession().catch(() => undefined)
            throw error
          }
        },
        async abort() {
          await abortSession()
        },
      }
    },
  }
}
