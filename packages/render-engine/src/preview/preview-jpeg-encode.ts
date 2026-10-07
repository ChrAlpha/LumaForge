// Thin wrapper around an injected JPEG encoder that streams RGBA preview
// pixels (the output of `renderCpuPreviewFrame`) into a JPEG byte stream.
// The encoder type below covers both `LumaJpegEncoder` (browser, returns
// Blob) and `LumaJpegNodeEncoder` (Node, returns Uint8Array) — the engine
// stays env-agnostic by treating the result as an opaque payload the
// caller knows how to handle.

const PREVIEW_ENCODE_ROW_BAND = 32

export type PreviewJpegEncoder = {
  writeRows: (rows: Uint8Array, rowCount: number) => Promise<void>
  finish: () => Promise<unknown>
  /** The Node encoder's abort settles once the encoder is released. */
  abort: () => void | Promise<void>
}

export type PreviewJpegEncoderFactory = (input: {
  width: number
  height: number
  quality: number
}) => PreviewJpegEncoder

export type EncodePreviewFrameToJpegInput = {
  /** RGBA8 bytes from `renderCpuPreviewFrame` (Uint8ClampedArray view OK). */
  readonly rgba: Uint8Array | Uint8ClampedArray
  readonly width: number
  readonly height: number
  /** 0..1. Defaults to 0.85. */
  readonly quality?: number
}

/**
 * Convert RGBA8 → RGB8 row-band by row-band, stream into the supplied
 * encoder, and resolve with whatever the encoder's `finish()` returns
 * (Blob in browsers, Uint8Array in Node — caller knows).
 */
export async function encodePreviewFrameToJpeg(
  createEncoder: PreviewJpegEncoderFactory,
  input: EncodePreviewFrameToJpegInput,
): Promise<unknown> {
  const { rgba, width, height } = input
  const quality = clampQuality(input.quality)
  const expectedRgbaLength = width * height * 4
  if (rgba.length !== expectedRgbaLength) {
    throw new Error('PREVIEW_JPEG_ENCODE_RGBA_LENGTH_MISMATCH')
  }

  const encoder = createEncoder({ width, height, quality })

  try {
    for (let row = 0; row < height; row += PREVIEW_ENCODE_ROW_BAND) {
      const rowCount = Math.min(PREVIEW_ENCODE_ROW_BAND, height - row)
      // Allocate a fresh buffer per band. The browser encoder transfers the
      // underlying ArrayBuffer to its worker via postMessage, which detaches
      // it — reusing a single band buffer across iterations means iteration
      // N+1 would read/write a detached typed array.
      const dst = new Uint8Array(width * rowCount * 3)
      const srcStart = row * width * 4
      for (let p = 0; p < width * rowCount; p += 1) {
        const s = srcStart + p * 4
        const d = p * 3
        dst[d + 0] = rgba[s + 0]
        dst[d + 1] = rgba[s + 1]
        dst[d + 2] = rgba[s + 2]
      }
      await encoder.writeRows(dst, rowCount)
    }
    return await encoder.finish()
  } catch (error) {
    try {
      await encoder.abort()
    } catch {
      // Preserve the original failure.
    }
    throw error
  }
}

function clampQuality(value: number | undefined): number {
  const fallback = 0.85
  if (value === undefined) return fallback
  if (!Number.isFinite(value) || value <= 0 || value > 1) return fallback
  return value
}
