/// <reference types="node" />

import { Buffer } from 'node:buffer'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { createLumaJpegRuntimeForNode } from './runtime-node'

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const artifactsDir = resolve(packageDir, '..', 'luma-native-artifacts')
const NATIVE_AVAILABLE = existsSync(join(artifactsDir, 'native/luma_jpeg.wasm'))

function makeRgbGradient(width: number, height: number): Uint8Array {
  const rows = new Uint8Array(width * height * 3)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 3
      rows[i] = (x * 255) / (width - 1)
      rows[i + 1] = (y * 255) / (height - 1)
      rows[i + 2] = ((x + y) * 255) / (width + height - 2)
    }
  }
  return rows
}

const describeWithNative = NATIVE_AVAILABLE ? describe : describe.skip

describeWithNative('createLumaJpegRuntimeForNode', () => {
  it('encodes a small RGB image to a JPEG byte stream', async () => {
    const runtime = await createLumaJpegRuntimeForNode()
    try {
      const encoder = runtime.createEncoder({
        width: 64,
        height: 32,
        quality: 0.85,
      })
      const rows = makeRgbGradient(64, 32)
      await encoder.writeRows(rows, 32)
      const bytes = await encoder.finish()

      expect(bytes).toBeInstanceOf(Uint8Array)
      expect(bytes.length).toBeGreaterThan(0)
      // JPEG magic bytes (SOI marker)
      expect(bytes[0]).toBe(0xFF)
      expect(bytes[1]).toBe(0xD8)
      // JPEG end-of-image (EOI marker)
      expect(bytes[bytes.length - 2]).toBe(0xFF)
      expect(bytes.at(-1)).toBe(0xD9)
    } finally {
      runtime.dispose()
    }
  }, 30_000)

  it('produces identical output for the same input bytes', async () => {
    const runtime = await createLumaJpegRuntimeForNode()
    try {
      const rows = makeRgbGradient(32, 16)

      const first = runtime.createEncoder({
        width: 32,
        height: 16,
        quality: 0.9,
      })
      await first.writeRows(rows, 16)
      const a = await first.finish()

      const second = runtime.createEncoder({
        width: 32,
        height: 16,
        quality: 0.9,
      })
      await second.writeRows(rows, 16)
      const b = await second.finish()

      expect(a.length).toBe(b.length)
      expect(Buffer.compare(Buffer.from(a), Buffer.from(b))).toBe(0)
    } finally {
      runtime.dispose()
    }
  }, 30_000)

  it('streams chunks when finishMode is chunks', async () => {
    const collected: Uint8Array[] = []
    const runtime = await createLumaJpegRuntimeForNode({
      onChunk: ({ bytes }) => {
        collected.push(bytes)
      },
    })
    try {
      const rows = makeRgbGradient(48, 24)
      const encoder = runtime.createEncoder({
        width: 48,
        height: 24,
        quality: 0.8,
        finishMode: 'chunks',
      })
      await encoder.writeRows(rows, 24)
      const tail = await encoder.finish()

      const totalChunkBytes = collected.reduce((sum, c) => sum + c.length, 0)
      expect(totalChunkBytes).toBeGreaterThan(0)
      // tail bytes are empty in chunks mode (chunks already emitted)
      expect(tail.length).toBe(0)
    } finally {
      runtime.dispose()
    }
  }, 30_000)

  it('rejects writeRows with a length mismatch', async () => {
    const runtime = await createLumaJpegRuntimeForNode()
    try {
      const encoder = runtime.createEncoder({
        width: 16,
        height: 8,
        quality: 0.8,
      })
      const wrongLength = new Uint8Array(16 * 7 * 3) // 7 rows declared as 8
      await expect(encoder.writeRows(wrongLength, 8)).rejects.toThrow()
    } finally {
      runtime.dispose()
    }
  }, 30_000)

  it('disposes safely and prevents further use', async () => {
    const runtime = await createLumaJpegRuntimeForNode()
    runtime.dispose()
    expect(() =>
      runtime.createEncoder({ width: 4, height: 4, quality: 0.5 }),
    ).toThrow(/DISPOSED/i)
  })
})

/** A native module stand-in whose encoder steps fail when told to. */
function fakeNativeModule(faults: { writeRows?: Error; abort?: Error } = {}) {
  const calls = { abort: 0, delete: 0 }
  class LumaJpegEncoder {
    writeRows() {
      if (faults.writeRows) throw faults.writeRows
    }

    finish() {
      return new Uint8Array([0xFF, 0xD8, 0xFF, 0xD9])
    }

    abort() {
      calls.abort += 1
      if (faults.abort) throw faults.abort
    }

    delete() {
      calls.delete += 1
    }
  }
  return { module: { LumaJpegEncoder }, calls }
}

describe('createLumaJpegRuntimeForNode abort', () => {
  const options = { width: 4, height: 2, quality: 0.8 }

  it('resolves once the native encoder is released', async () => {
    const { module, calls } = fakeNativeModule()
    const runtime = await createLumaJpegRuntimeForNode({
      nativeLoader: async () => module,
    })
    const encoder = runtime.createEncoder(options)
    await encoder.writeRows(new Uint8Array(4 * 3), 1)

    await expect(encoder.abort()).resolves.toBeUndefined()
    expect(calls).toEqual({ abort: 1, delete: 1 })
    await expect(encoder.finish()).rejects.toThrow('LUMA_JPEG_RUNTIME_ABORTED')
    await expect(encoder.abort()).resolves.toBeUndefined()
    expect(calls.abort).toBe(1)
  })

  it('settles an overlapping abort only once the first one has released the encoder', async () => {
    const { module, calls } = fakeNativeModule()
    const runtime = await createLumaJpegRuntimeForNode({
      nativeLoader: async () => module,
    })
    const encoder = runtime.createEncoder(options)
    const first = encoder.abort()

    await encoder.abort()
    expect(calls).toEqual({ abort: 1, delete: 1 })
    const next = runtime.createEncoder(options)
    await next.writeRows(new Uint8Array(4 * 2 * 3), 2)
    await expect(next.finish()).resolves.toBeInstanceOf(Uint8Array)
    await expect(first).resolves.toBeUndefined()
  })

  it('rejects every overlapping abort with the native failure', async () => {
    const abortError = new Error('NATIVE_ABORT_FAILED')
    const { module, calls } = fakeNativeModule({ abort: abortError })
    const runtime = await createLumaJpegRuntimeForNode({
      nativeLoader: async () => module,
    })
    const encoder = runtime.createEncoder(options)
    const first = encoder.abort()
    const second = encoder.abort()

    await expect(second).rejects.toBe(abortError)
    await expect(first).rejects.toBe(abortError)
    expect(calls).toEqual({ abort: 1, delete: 1 })
    // The failure is reported once; a later call has nothing left to release.
    await expect(encoder.abort()).resolves.toBeUndefined()
    expect(calls.abort).toBe(1)
  })

  it('rejects with the native failure and frees the runtime for the next encoder', async () => {
    const abortError = new Error('NATIVE_ABORT_FAILED')
    const { module, calls } = fakeNativeModule({ abort: abortError })
    const runtime = await createLumaJpegRuntimeForNode({
      nativeLoader: async () => module,
    })
    const encoder = runtime.createEncoder(options)
    await encoder.writeRows(new Uint8Array(4 * 3), 1)

    await expect(encoder.abort()).rejects.toBe(abortError)
    expect(calls).toEqual({ abort: 1, delete: 1 })
    const next = runtime.createEncoder(options)
    await next.writeRows(new Uint8Array(4 * 2 * 3), 2)
    await expect(next.finish()).resolves.toBeInstanceOf(Uint8Array)
  })

  it('resolves without a native abort when a failed write already released the encoder', async () => {
    const writeError = new Error('NATIVE_WRITE_FAILED')
    const { module, calls } = fakeNativeModule({ writeRows: writeError })
    const runtime = await createLumaJpegRuntimeForNode({
      nativeLoader: async () => module,
    })
    const encoder = runtime.createEncoder(options)
    await expect(encoder.writeRows(new Uint8Array(4 * 3), 1)).rejects.toBe(
      writeError,
    )

    await expect(encoder.abort()).resolves.toBeUndefined()
    expect(calls).toEqual({ abort: 0, delete: 1 })
  })

  it('resolves when the encoder was never created', async () => {
    const runtime = await createLumaJpegRuntimeForNode({
      nativeLoader: async () => {
        throw new Error('missing artifact')
      },
    })
    const encoder = runtime.createEncoder(options)
    const abort = encoder.abort()

    await expect(abort).resolves.toBeUndefined()
    await expect(encoder.finish()).rejects.toThrow('LUMA_JPEG_RUNTIME_ABORTED')
  })
})

if (!NATIVE_AVAILABLE) {
  describe('createLumaJpegRuntimeForNode — SKIPPED (native)', () => {
    it('native WASM missing; run native build or pnpm native:prepare', () => {
      expect(NATIVE_AVAILABLE).toBe(false)
    })
  })
}
