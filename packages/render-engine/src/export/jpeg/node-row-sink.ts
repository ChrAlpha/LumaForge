import { createBytesOutputResult } from './output-result'
import type { JpegRowSink } from './row-writer'

/**
 * @deprecated Only `createNodeJpegRowSink` takes this encoder shape, and it
 * is deprecated.
 */
export type BytesJpegEncoder = {
  writeRows: (rows: Uint8Array, rowCount: number) => Promise<void>
  finish: () => Promise<Uint8Array>
  abort: () => void
}

/**
 * @deprecated Only `createNodeJpegRowSink` takes this runtime shape, and it
 * is deprecated.
 */
export type BytesJpegRuntime = {
  createEncoder: (options: {
    width: number
    height: number
    quality: number
  }) => BytesJpegEncoder
  dispose: () => void
}

/**
 * A row sink that keeps the whole encoded JPEG in memory and returns it as a
 * bytes output named `export.jpg`.
 *
 * @deprecated Nothing in the engine, the app or `lmfg` uses this sink, and it
 * holds the full-resolution JPEG in memory. Implement `JpegRowSink` over a
 * streaming encoder instead, or omit `jpegSink` so
 * `runFullResolutionJpegExport` uses `createWasmJpegRowSink`. The function
 * keeps its behavior and is still exported from
 * `@lumaforge/render-engine/export`.
 */
export function createNodeJpegRowSink(runtime: BytesJpegRuntime): JpegRowSink {
  return {
    createSession({ width, height, quality }) {
      const encoder = runtime.createEncoder({ width, height, quality })
      let state: 'open' | 'closed' | 'aborted' = 'open'

      function ensureOpen() {
        if (state === 'aborted') {
          throw new Error('JPEG_WRITER_ABORTED')
        }
        if (state === 'closed') {
          throw new Error('JPEG_WRITER_CLOSED')
        }
      }

      function abortEncoder() {
        if (state === 'aborted' || state === 'closed') {
          return
        }
        state = 'aborted'
        encoder.abort()
      }

      return {
        async writeRows(rows, rowCount) {
          ensureOpen()

          try {
            await encoder.writeRows(rows, rowCount)
          } catch (error) {
            try {
              abortEncoder()
            } catch {
              // Preserve the original encoder failure.
            }
            throw error
          }
        },
        async close() {
          ensureOpen()

          try {
            const bytes = await encoder.finish()
            state = 'closed'
            return createBytesOutputResult({
              filename: 'export.jpg',
              bytes,
            })
          } catch (error) {
            try {
              abortEncoder()
            } catch {
              // Preserve the original finish failure.
            }
            throw error
          }
        },
        async abort() {
          abortEncoder()
        },
      }
    },
  }
}
