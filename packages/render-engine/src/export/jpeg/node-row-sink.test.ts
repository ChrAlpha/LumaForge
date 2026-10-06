// @vitest-environment node
import { describe, expect, expectTypeOf, it, vi } from 'vitest'

import * as exportEntry from '../index'
import type { BytesJpegRuntime } from './node-row-sink'
import { createNodeJpegRowSink } from './node-row-sink'

function createMockRuntime(): BytesJpegRuntime & {
  calls: Array<{ type: string; rows?: Uint8Array; rowCount?: number }>
} {
  const calls: Array<{
    type: string
    rows?: Uint8Array
    rowCount?: number
  }> = []

  return {
    calls,
    createEncoder(_options) {
      return {
        async writeRows(rows, rowCount) {
          calls.push({ type: 'writeRows', rows, rowCount })
        },
        async finish() {
          calls.push({ type: 'finish' })
          return new Uint8Array([0xFF, 0xD8, 0xFF, 0xD9])
        },
        abort() {
          calls.push({ type: 'abort' })
        },
      }
    },
    dispose: vi.fn(),
  }
}

describe('createNodeJpegRowSink', () => {
  it('stays exported from the export entry with its runtime shape', () => {
    expect(exportEntry.createNodeJpegRowSink).toBe(createNodeJpegRowSink)
    expectTypeOf<exportEntry.BytesJpegRuntime>().toEqualTypeOf<BytesJpegRuntime>()
    expectTypeOf(createNodeJpegRowSink)
      .parameter(0)
      .toEqualTypeOf<exportEntry.BytesJpegRuntime>()
    expectTypeOf(
      createNodeJpegRowSink,
    ).returns.toEqualTypeOf<exportEntry.JpegRowSink>()
  })

  it('writes rows and returns BytesOutputResult on close', async () => {
    const runtime = createMockRuntime()
    const sink = createNodeJpegRowSink(runtime)
    const session = sink.createSession({ width: 2, height: 2, quality: 0.92 })

    await session.writeRows(new Uint8Array([255, 0, 0, 0, 255, 0]), 1)
    await session.writeRows(new Uint8Array([0, 0, 255, 255, 255, 255]), 1)

    const result = await session.close()

    expect(result).toMatchObject({
      kind: 'bytes',
      filename: 'export.jpg',
      mimeType: 'image/jpeg',
      byteLength: 4,
    })
    expect(result.kind === 'bytes' && result.bytes).toEqual(
      new Uint8Array([0xFF, 0xD8, 0xFF, 0xD9]),
    )
    expect(runtime.calls.map((c) => c.type)).toEqual([
      'writeRows',
      'writeRows',
      'finish',
    ])
  })

  it('aborts the encoder on write failure', async () => {
    const runtime: BytesJpegRuntime = {
      createEncoder() {
        return {
          async writeRows() {
            throw new Error('WASM_OOM')
          },
          async finish() {
            return new Uint8Array()
          },
          abort: vi.fn(),
        }
      },
      dispose: vi.fn(),
    }

    const sink = createNodeJpegRowSink(runtime)
    const session = sink.createSession({ width: 1, height: 1, quality: 0.9 })

    await expect(
      session.writeRows(new Uint8Array([0, 0, 0]), 1),
    ).rejects.toThrow('WASM_OOM')
  })

  it('rejects operations after abort', async () => {
    const runtime = createMockRuntime()
    const sink = createNodeJpegRowSink(runtime)
    const session = sink.createSession({ width: 1, height: 1, quality: 0.9 })

    await session.abort()

    await expect(
      session.writeRows(new Uint8Array([0, 0, 0]), 1),
    ).rejects.toThrow('JPEG_WRITER_ABORTED')
  })

  it('rejects operations after close', async () => {
    const runtime = createMockRuntime()
    const sink = createNodeJpegRowSink(runtime)
    const session = sink.createSession({ width: 1, height: 1, quality: 0.9 })

    await session.close()

    await expect(
      session.writeRows(new Uint8Array([0, 0, 0]), 1),
    ).rejects.toThrow('JPEG_WRITER_CLOSED')
  })
})
