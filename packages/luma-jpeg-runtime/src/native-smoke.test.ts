/// <reference types="node" />

import { Buffer } from 'node:buffer'
import { stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadNativeModuleForNode } from '@lumaforge/luma-native-artifacts/load-for-node'
import { beforeAll, describe, expect, it } from 'vitest'

import type { NativeJpegModule } from '../worker/native-adapter'
import { createNativeJpegEncoderFactory } from '../worker/native-adapter'
import type { LumaJpegChunk } from './runtime'
import { createLumaJpegRuntimeForNode } from './runtime-node'

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const nativeDir = join(packageDir, 'dist', 'native')
const artifactHint =
  'Run `pnpm --filter @lumaforge/luma-jpeg-runtime build:native` before `pnpm --filter @lumaforge/luma-jpeg-runtime test:native-smoke`.'
const JPEG_SOI_MARKER = 0xFF_D8
const JPEG_EOI_MARKER = 0xFF_D9
// Two rows of two RGB8 pixels.
const ROWS = new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255])

const loadNative = () => loadNativeModuleForNode({ kind: 'jpeg', nativeDir })

function readWord(bytes: Uint8Array, offset: number) {
  return (bytes[offset] << 8) | bytes[offset + 1]
}

async function encode(onChunk?: (chunk: LumaJpegChunk) => void) {
  const runtime = await createLumaJpegRuntimeForNode({
    nativeLoader: loadNative,
    onChunk,
  })
  try {
    const encoder = runtime.createEncoder({
      width: 2,
      height: 2,
      quality: 0.92,
      finishMode: onChunk ? 'chunks' : 'blob',
    })
    await encoder.writeRows(ROWS.subarray(0, 6), 1)
    await encoder.writeRows(ROWS.subarray(6), 1)
    return await encoder.finish()
  } finally {
    runtime.dispose()
  }
}

describe('native JPEG runtime smoke test', () => {
  beforeAll(async () => {
    for (const name of ['luma_jpeg.js', 'luma_jpeg.wasm']) {
      const path = join(nativeDir, name)
      const entry = await stat(path).catch(() => null)
      if (!entry?.isFile()) {
        throw new Error(
          `Missing native JPEG artifact: ${path}\n${artifactHint}`,
        )
      }
    }
  })

  it('encodes rows through the Node runtime, streamed or whole, to the same bytes', async () => {
    const whole = await encode()
    const chunks: LumaJpegChunk[] = []
    const empty = await encode((chunk) => chunks.push(chunk))

    expect(readWord(whole, 0)).toBe(JPEG_SOI_MARKER)
    expect(readWord(whole, whole.length - 2)).toBe(JPEG_EOI_MARKER)
    expect(empty.byteLength).toBe(0)
    expect(chunks.at(-1)?.final).toBe(true)
    let offset = 0
    for (const chunk of chunks) {
      expect(chunk.byteOffset).toBe(offset)
      offset += chunk.bytes.byteLength
    }
    expect(Buffer.concat(chunks.map((chunk) => chunk.bytes))).toEqual(
      Buffer.from(whole),
    )
  })

  it('refuses rows past the image height in the native encoder', async () => {
    const createEncoder = createNativeJpegEncoderFactory(
      (await loadNative()) as NativeJpegModule,
    )
    const encoder = createEncoder({ width: 1, height: 1, quality: 0.92 })
    await encoder.writeRows(new Uint8Array([0, 0, 0]), 1)

    await expect(
      encoder.writeRows(new Uint8Array([0, 0, 0]), 1),
    ).rejects.toThrow('JPEG_ROW_COUNT_EXCEEDED')
    await expect(encoder.finish()).rejects.toThrow('JPEG_RUNTIME_ABORTED')
  })
})
