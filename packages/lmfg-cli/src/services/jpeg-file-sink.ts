import { basename } from 'node:path'

import type { LumaJpegNodeRuntime } from '@lumaforge/luma-jpeg-runtime/node'
import { createLumaJpegRuntimeForNode } from '@lumaforge/luma-jpeg-runtime/node'
import type {
  JpegExportMetadata,
  JpegRowSink,
} from '@lumaforge/render-engine/export'
import { createBytesOutputResult } from '@lumaforge/render-engine/export'

import type { CleanupFailure } from '../protocol/errors'
import {
  attemptCleanup,
  cleanupFailuresOf,
  withCleanupFailures,
} from '../protocol/errors'
import type { StreamedJpegFile } from './jpeg-file-writer'
import { createStreamingJpegFileWriter } from './jpeg-file-writer'

export type FileJpegRowSink = JpegRowSink & {
  /** The streamed file once `close()` succeeded; `null` before that. */
  result: () => StreamedJpegFile | null
  /**
   * Every cleanup step that failed in this sink's sessions, in order. A
   * failing `writeRows` or `close` also lists its own on the error it
   * throws; an `abort()` resolves and records them here only.
   */
  cleanupFailures: () => readonly CleanupFailure[]
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
  const recorded: CleanupFailure[] = []
  const createRuntime = input.createRuntime ?? createLumaJpegRuntimeForNode

  return {
    result: () => finished,
    cleanupFailures: () => recorded,
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

      function disposeRuntime(): void {
        const created = runtime
        runtime = null
        created?.dispose()
      }

      /** Releases the encoder and the partial file; resolves what failed. */
      async function abortSession(): Promise<CleanupFailure[]> {
        if (state !== 'open') return []
        state = 'aborted'
        const failures: CleanupFailure[] = []
        // A runtime that never started is the operation's own failure.
        const encoder = await encoderPromise.catch(() => null)
        if (encoder) {
          await attemptCleanup(failures, 'abort_jpeg_encoder', () =>
            encoder.abort(),
          )
        }
        await attemptCleanup(failures, 'dispose_jpeg_runtime', disposeRuntime)
        failures.push(...(await writer.abort()))
        return failures
      }

      /** Rethrows `error` with the cleanup that followed it. */
      async function fail(error: unknown): Promise<never> {
        const failures = [
          ...cleanupFailuresOf(error),
          ...(await abortSession()),
        ]
        recorded.push(...failures)
        throw withCleanupFailures(error, failures)
      }

      return {
        async writeRows(rows, rowCount) {
          if (state !== 'open') throw new Error('JPEG_WRITER_CLOSED')
          try {
            const encoder = await encoderPromise
            await encoder.writeRows(rows, rowCount)
          } catch (error) {
            await fail(error)
          }
        },
        async close() {
          if (state !== 'open') throw new Error('JPEG_WRITER_CLOSED')
          try {
            const encoder = await encoderPromise
            await encoder.finish()
            disposeRuntime()
            finished = await writer.finish()
            state = 'closed'
            return createBytesOutputResult({
              filename: basename(input.path),
              bytes: new Uint8Array(0),
            })
          } catch (error) {
            return fail(error)
          }
        },
        async abort() {
          recorded.push(...(await abortSession()))
        },
      }
    },
  }
}
