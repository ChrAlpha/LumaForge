import { describe, expect, it, vi } from 'vitest'

import {
  createWasmJpegRowSink,
  isWasmJpegRuntimeAvailable,
  JPEG_RUNTIME_UNAVAILABLE_MESSAGE,
} from './wasm-row-sink'

describe('createWasmJpegRowSink', () => {
  it('forwards row chunks to the JPEG runtime', async () => {
    const calls: string[] = []
    const sink = createWasmJpegRowSink(() => ({
      createEncoder() {
        return {
          async writeRows() {
            calls.push('rows')
          },
          async finish() {
            calls.push('finish')
            return new Blob([new Uint8Array([0xFF, 0xD8, 0xFF, 0xD9])], {
              type: 'image/jpeg',
            })
          },
          abort() {
            calls.push('abort')
          },
        }
      },
      dispose() {
        calls.push('dispose')
      },
    }))

    const session = sink.createSession({
      width: 1,
      height: 1,
      quality: 0.9,
    })

    await session.writeRows(new Uint8Array([255, 255, 255]), 1)
    const output = await session.close()

    expect(output).toMatchObject({
      kind: 'blob',
      filename: 'export.jpg',
      mimeType: 'image/jpeg',
      byteLength: 4,
    })
    if (output.kind !== 'blob') {
      throw new Error('expected blob-backed output')
    }
    expect(output.blob.type).toBe('image/jpeg')
    expect(calls).toEqual(['rows', 'finish', 'dispose'])
  })

  it('creates a fresh runtime per session and aborts on encoder failure', async () => {
    const calls: string[] = []
    let runtimeCount = 0
    const sink = createWasmJpegRowSink(() => {
      const runtimeId = ++runtimeCount
      return {
        createEncoder() {
          return {
            async writeRows() {
              calls.push(`rows:${runtimeId}`)
              throw new Error('JPEG_RUNTIME_UNAVAILABLE')
            },
            async finish() {
              calls.push(`finish:${runtimeId}`)
              return new Blob()
            },
            abort() {
              calls.push(`abort:${runtimeId}`)
            },
          }
        },
        dispose() {
          calls.push(`dispose:${runtimeId}`)
        },
      }
    })

    const first = sink.createSession({ width: 1, height: 1, quality: 0.9 })
    const second = sink.createSession({ width: 1, height: 1, quality: 0.9 })

    await expect(first.writeRows(new Uint8Array([0, 0, 0]), 1)).rejects.toThrow(
      JPEG_RUNTIME_UNAVAILABLE_MESSAGE,
    )
    await second.abort()

    expect(runtimeCount).toBe(2)
    expect(calls).toEqual([
      'rows:1',
      'abort:1',
      'dispose:1',
      'abort:2',
      'dispose:2',
    ])
  })

  it('disposes the runtime if encoder creation fails during session construction', () => {
    const calls: string[] = []
    const sink = createWasmJpegRowSink(() => ({
      createEncoder() {
        calls.push('createEncoder')
        throw new Error('JPEG_RUNTIME_UNAVAILABLE')
      },
      dispose() {
        calls.push('dispose')
      },
    }))

    expect(() =>
      sink.createSession({ width: 1, height: 1, quality: 0.9 }),
    ).toThrow(JPEG_RUNTIME_UNAVAILABLE_MESSAGE)
    expect(calls).toEqual(['createEncoder', 'dispose'])
  })

  it('wraps async row and finish failures with the product message', async () => {
    const rowCause = new Error('JPEG_RUNTIME_ROWS_FAILED')
    const finishCause = new Error('JPEG_RUNTIME_FINISH_FAILED')
    const rowSink = createWasmJpegRowSink(() => ({
      createEncoder() {
        return {
          async writeRows() {
            throw rowCause
          },
          async finish() {
            return new Blob()
          },
          abort: vi.fn(),
        }
      },
      dispose: vi.fn(),
    }))
    const finishSink = createWasmJpegRowSink(() => ({
      createEncoder() {
        return {
          async writeRows() {},
          async finish() {
            throw finishCause
          },
          abort: vi.fn(),
        }
      },
      dispose: vi.fn(),
    }))

    const rowSession = rowSink.createSession({
      width: 1,
      height: 1,
      quality: 0.9,
    })
    const finishSession = finishSink.createSession({
      width: 1,
      height: 1,
      quality: 0.9,
    })
    let rowError: unknown
    let finishError: unknown

    try {
      await rowSession.writeRows(new Uint8Array([0, 0, 0]), 1)
    } catch (error) {
      rowError = error
    }
    await finishSession.writeRows(new Uint8Array([0, 0, 0]), 1)
    try {
      await finishSession.close()
    } catch (error) {
      finishError = error
    }

    expect(rowError).toMatchObject({
      message: JPEG_RUNTIME_UNAVAILABLE_MESSAGE,
    })
    expect(rowError).toHaveProperty('cause', rowCause)
    expect(finishError).toMatchObject({
      message: JPEG_RUNTIME_UNAVAILABLE_MESSAGE,
    })
    expect(finishError).toHaveProperty('cause', finishCause)
  })

  it('rejects rows after the session is aborted or closed', async () => {
    const sink = createWasmJpegRowSink(() => ({
      createEncoder() {
        return {
          async writeRows() {},
          async finish() {
            return new Blob([new Uint8Array([0xFF, 0xD8, 0xFF, 0xD9])])
          },
          abort: vi.fn(),
        }
      },
      dispose: vi.fn(),
    }))

    const aborted = sink.createSession({ width: 1, height: 1, quality: 0.9 })
    await aborted.abort()
    await expect(
      aborted.writeRows(new Uint8Array([0, 0, 0]), 1),
    ).rejects.toThrow('JPEG_WRITER_ABORTED')
    await expect(aborted.close()).rejects.toThrow('JPEG_WRITER_ABORTED')

    const closed = sink.createSession({ width: 1, height: 1, quality: 0.9 })
    await closed.writeRows(new Uint8Array([0, 0, 0]), 1)
    await closed.close()
    await expect(
      closed.writeRows(new Uint8Array([0, 0, 0]), 1),
    ).rejects.toThrow('JPEG_WRITER_CLOSED')
    await expect(closed.close()).rejects.toThrow('JPEG_WRITER_CLOSED')
  })

  it('awaits a minimal encode before reporting the WASM JPEG runtime available', async () => {
    const calls: string[] = []

    await expect(
      isWasmJpegRuntimeAvailable(() => ({
        createEncoder() {
          calls.push('create')
          return {
            async writeRows() {
              calls.push('rows')
              throw new Error('async create failed')
            },
            async finish() {
              calls.push('finish')
              return new Blob()
            },
            abort() {
              calls.push('abort')
            },
          }
        },
        dispose() {
          calls.push('dispose')
        },
      })),
    ).resolves.toBe(false)

    expect(calls).toEqual(['create', 'rows', 'abort', 'dispose'])
  })
})
