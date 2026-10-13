import type { InternalJpegEncoder, JpegWorkerChunk } from './runtime-core'

// Encoders built with chunk streaming return an empty array from finish and
// hand out the stream, in JS-owned arrays, through drainChunks. The JPEG
// artifact in luma-native-artifacts 0.0.5 predates streaming: it has no
// drainChunks and returns the whole stream from finish.
type NativeJpegEncoder = {
  writeRows: (rows: Uint8Array, rowCount: number) => unknown
  finish: () => Uint8Array
  drainChunks?: () => JpegWorkerChunk[]
  abort: () => void
  delete?: () => void
}

export type NativeJpegModule = {
  LumaJpegEncoder: new (
    width: number,
    height: number,
    quality: number,
  ) => NativeJpegEncoder
  getExceptionMessage?: (error: unknown) => string[] | undefined
  decrementExceptionRefcount?: (error: unknown) => void
}

export type NativeJpegEncoderFactoryInput = {
  width: number
  height: number
  quality: number
}

function normalizeNativeError(module: NativeJpegModule, error: unknown) {
  if (error instanceof Error) {
    return error
  }

  let message: string | undefined
  if (module.getExceptionMessage) {
    try {
      message = module.getExceptionMessage(error)?.[1]
    } finally {
      module.decrementExceptionRefcount?.(error)
    }
  }

  if (typeof message === 'string' && message.length > 0) {
    return new Error(message, { cause: error })
  }

  return new Error(String(error), { cause: error })
}

function deleteNativeEncoder(encoder: NativeJpegEncoder) {
  try {
    encoder.delete?.()
  } catch {
    // Native delete is a cleanup path; preserve the operation error that made
    // the wrapper terminal.
  }
}

export function createNativeJpegEncoderFactory(module: NativeJpegModule) {
  return (input: NativeJpegEncoderFactoryInput): InternalJpegEncoder => {
    let encoder: NativeJpegEncoder
    try {
      encoder = new module.LumaJpegEncoder(
        input.width,
        input.height,
        input.quality,
      )
    } catch (error) {
      throw normalizeNativeError(module, error)
    }

    let aborted = false
    let finished = false
    let streamedBytes = 0

    function drain(): JpegWorkerChunk[] {
      const chunks = encoder.drainChunks?.() ?? []
      for (const chunk of chunks) streamedBytes += chunk.bytes.byteLength
      return chunks
    }

    return {
      async writeRows(rows, rowCount) {
        if (aborted) throw new Error('JPEG_RUNTIME_ABORTED')
        if (finished) throw new Error('JPEG_RUNTIME_FINISHED')
        try {
          encoder.writeRows(rows, rowCount)
          return drain()
        } catch (error) {
          aborted = true
          deleteNativeEncoder(encoder)
          throw normalizeNativeError(module, error)
        }
      },
      async finish() {
        if (aborted) throw new Error('JPEG_RUNTIME_ABORTED')
        if (finished) throw new Error('JPEG_RUNTIME_FINISHED')
        let chunks: JpegWorkerChunk[]
        try {
          const whole = encoder.finish()
          chunks = drain()
          if (whole.byteLength > 0) {
            chunks.push({
              bytes: whole,
              byteOffset: streamedBytes,
              final: true,
            })
          }
        } catch (error) {
          finished = true
          deleteNativeEncoder(encoder)
          throw normalizeNativeError(module, error)
        }
        finished = true
        deleteNativeEncoder(encoder)
        return chunks
      },
      abort() {
        if (aborted || finished) return
        aborted = true
        try {
          encoder.abort()
        } catch (error) {
          deleteNativeEncoder(encoder)
          throw normalizeNativeError(module, error)
        }
        deleteNativeEncoder(encoder)
      },
    }
  }
}
