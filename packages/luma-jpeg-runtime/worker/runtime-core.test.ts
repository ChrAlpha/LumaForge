import type { InternalJpegEncoder, JpegWorkerChunk } from './runtime-core'
import { createJpegRuntimeCore } from './runtime-core'

const ROW = new Uint8Array([255, 255, 255])

/**
 * Streams the start-of-image marker with the first rows and the
 * end-of-image marker, marked final, from finish.
 */
function createStreamingEncoder(
  overrides: Partial<InternalJpegEncoder> = {},
): InternalJpegEncoder {
  let offset = 0
  const chunk = (bytes: number[], final: boolean): JpegWorkerChunk => {
    const next = { bytes: new Uint8Array(bytes), byteOffset: offset, final }
    offset += bytes.length
    return next
  }
  return {
    async writeRows() {
      return offset === 0 ? [chunk([255, 216], false)] : []
    },
    async finish() {
      return [chunk([255, 217], true)]
    },
    abort() {},
    ...overrides,
  }
}

function createRuntime(
  overrides: Partial<InternalJpegEncoder> = {},
  onResponse?: (response: unknown) => void,
) {
  return createJpegRuntimeCore(
    async () => () => createStreamingEncoder(overrides),
    { onResponse },
  )
}

describe('createJpegRuntimeCore', () => {
  it('tracks written rows after create', async () => {
    const core = createRuntime()

    await expect(
      core.handleRequest({
        id: 'create-1',
        type: 'create',
        payload: { width: 1, height: 2, quality: 0.9 },
      }),
    ).resolves.toMatchObject({
      ok: true,
      type: 'create',
      payload: { created: true },
    })

    await expect(
      core.handleRequest({
        id: 'rows-1',
        type: 'rows',
        payload: { rows: ROW, rowCount: 1 },
      }),
    ).resolves.toMatchObject({
      ok: true,
      type: 'rows',
      payload: { writtenRows: 1 },
    })
  })

  it('assembles the finish blob from the streamed chunks in blob mode', async () => {
    const emitted: unknown[] = []
    const core = createRuntime({}, (response) => emitted.push(response))

    await core.handleRequest({
      id: 'create-blob',
      type: 'create',
      payload: { width: 1, height: 2, quality: 0.9 },
    })
    await core.handleRequest({
      id: 'rows-blob-1',
      type: 'rows',
      payload: { rows: ROW, rowCount: 1 },
    })
    await core.handleRequest({
      id: 'rows-blob-2',
      type: 'rows',
      payload: { rows: ROW, rowCount: 1 },
    })
    const response = await core.handleRequest({
      id: 'finish-blob',
      type: 'finish',
      payload: {},
    })

    if (response.type !== 'finish') {
      throw new Error('expected finish response')
    }
    expect(response.payload.blob.type).toBe('image/jpeg')
    expect(new Uint8Array(await response.payload.blob.arrayBuffer())).toEqual(
      new Uint8Array([255, 216, 255, 217]),
    )
    expect(emitted).toEqual([])
  })

  it('posts each chunk under the request that produced it in chunks mode', async () => {
    const emitted: unknown[] = []
    const core = createRuntime({}, (response) => emitted.push(response))

    await core.handleRequest({
      id: 'create-chunks',
      type: 'create',
      payload: { width: 1, height: 2, quality: 0.9, finishMode: 'chunks' },
    })
    await core.handleRequest({
      id: 'rows-chunks-1',
      type: 'rows',
      payload: { rows: ROW, rowCount: 1 },
    })
    expect(emitted).toHaveLength(1)
    await core.handleRequest({
      id: 'rows-chunks-2',
      type: 'rows',
      payload: { rows: ROW, rowCount: 1 },
    })
    const response = await core.handleRequest({
      id: 'finish-chunks',
      type: 'finish',
      payload: {},
    })

    expect(emitted).toEqual([
      {
        id: 'rows-chunks-1',
        ok: true,
        type: 'chunk',
        payload: {
          bytes: new Uint8Array([255, 216]),
          byteOffset: 0,
          final: false,
        },
      },
      {
        id: 'finish-chunks',
        ok: true,
        type: 'chunk',
        payload: {
          bytes: new Uint8Array([255, 217]),
          byteOffset: 2,
          final: true,
        },
      },
    ])
    if (response.type !== 'finish') {
      throw new Error('expected finish response')
    }
    expect(response.payload.blob.size).toBe(0)
  })

  it('fails the encoder when finish completes without any output', async () => {
    const core = createRuntime({
      async writeRows() {
        return []
      },
      async finish() {
        return []
      },
    })

    await core.handleRequest({
      id: 'create-empty',
      type: 'create',
      payload: { width: 1, height: 1, quality: 0.9, finishMode: 'chunks' },
    })
    await core.handleRequest({
      id: 'rows-empty',
      type: 'rows',
      payload: { rows: ROW, rowCount: 1 },
    })

    await expect(
      core.handleRequest({ id: 'finish-empty', type: 'finish', payload: {} }),
    ).rejects.toThrow('JPEG_RUNTIME_NO_OUTPUT')
    await expect(
      core.handleRequest({ id: 'finish-again', type: 'finish', payload: {} }),
    ).rejects.toThrow('JPEG_RUNTIME_ABORTED')
  })

  it('rejects finish before create', async () => {
    const core = createRuntime()

    await expect(
      core.handleRequest({
        id: 'finish-before-create',
        type: 'finish',
        payload: {},
      }),
    ).rejects.toThrow('JPEG_RUNTIME_NOT_CREATED')
  })

  it('rejects rows before create', async () => {
    const core = createRuntime()

    await expect(
      core.handleRequest({
        id: 'rows-before-create',
        type: 'rows',
        payload: {
          rows: new Uint8Array([255, 255, 255]),
          rowCount: 1,
        },
      }),
    ).rejects.toThrow('JPEG_RUNTIME_NOT_CREATED')
  })

  it('rejects non-positive row counts', async () => {
    const core = createRuntime()

    await core.handleRequest({
      id: 'create-3',
      type: 'create',
      payload: { width: 1, height: 1, quality: 0.9 },
    })

    await expect(
      core.handleRequest({
        id: 'rows-invalid-count',
        type: 'rows',
        payload: {
          rows: new Uint8Array([]),
          rowCount: 0,
        },
      }),
    ).rejects.toThrow('JPEG_INVALID_ROW_COUNT')
  })

  it('rejects row length mismatches before writing to the backend', async () => {
    let wroteRows = false
    const core = createRuntime({
      async writeRows() {
        wroteRows = true
        return []
      },
    })

    await core.handleRequest({
      id: 'create-length-mismatch',
      type: 'create',
      payload: { width: 2, height: 1, quality: 0.9 },
    })

    await expect(
      core.handleRequest({
        id: 'rows-length-mismatch',
        type: 'rows',
        payload: {
          rows: new Uint8Array([255, 255, 255]),
          rowCount: 1,
        },
      }),
    ).rejects.toThrow('JPEG_ROW_LENGTH_MISMATCH')
    expect(wroteRows).toBe(false)
  })

  it('rejects rows after abort', async () => {
    const core = createRuntime()

    await core.handleRequest({
      id: 'create-4',
      type: 'create',
      payload: { width: 1, height: 1, quality: 0.9 },
    })
    await core.handleRequest({
      id: 'abort-1',
      type: 'abort',
      payload: {},
    })

    await expect(
      core.handleRequest({
        id: 'rows-after-abort',
        type: 'rows',
        payload: {
          rows: new Uint8Array([255, 255, 255]),
          rowCount: 1,
        },
      }),
    ).rejects.toThrow('JPEG_RUNTIME_ABORTED')
  })

  it('rejects invalid JPEG quality at create time', async () => {
    const core = createRuntime()

    await expect(
      core.handleRequest({
        id: 'create-invalid-quality',
        type: 'create',
        payload: { width: 1, height: 1, quality: 0 },
      }),
    ).rejects.toThrow('JPEG_INVALID_QUALITY')
  })

  it('rejects create while an encoder is ready', async () => {
    const core = createRuntime()

    await core.handleRequest({
      id: 'create-active',
      type: 'create',
      payload: { width: 1, height: 1, quality: 0.9 },
    })

    await expect(
      core.handleRequest({
        id: 'create-active-2',
        type: 'create',
        payload: { width: 1, height: 1, quality: 0.9 },
      }),
    ).rejects.toThrow('JPEG_RUNTIME_ENCODER_ACTIVE')
  })

  it('rejects in-flight rows when abort wins the worker boundary', async () => {
    let resolveWriteRows: (() => void) | undefined
    const core = createRuntime({
      writeRows: () =>
        new Promise<readonly JpegWorkerChunk[]>((resolve) => {
          resolveWriteRows = () => resolve([])
        }),
    })

    await core.handleRequest({
      id: 'create-in-flight-rows',
      type: 'create',
      payload: { width: 1, height: 1, quality: 0.9 },
    })
    const rowsPromise = core.handleRequest({
      id: 'rows-in-flight',
      type: 'rows',
      payload: { rows: new Uint8Array([255, 255, 255]), rowCount: 1 },
    })

    await core.handleRequest({
      id: 'abort-in-flight-rows',
      type: 'abort',
      payload: {},
    })
    resolveWriteRows?.()

    await expect(rowsPromise).rejects.toThrow('JPEG_RUNTIME_ABORTED')
  })

  it('rejects in-flight finish when abort wins the worker boundary', async () => {
    let resolveFinish: (() => void) | undefined
    const core = createRuntime({
      finish: () =>
        new Promise<readonly JpegWorkerChunk[]>((resolve) => {
          resolveFinish = () => resolve([])
        }),
    })

    await core.handleRequest({
      id: 'create-in-flight-finish',
      type: 'create',
      payload: { width: 1, height: 1, quality: 0.9 },
    })
    await core.handleRequest({
      id: 'rows-before-finish',
      type: 'rows',
      payload: { rows: new Uint8Array([255, 255, 255]), rowCount: 1 },
    })
    const finishPromise = core.handleRequest({
      id: 'finish-in-flight',
      type: 'finish',
      payload: {},
    })

    await core.handleRequest({
      id: 'abort-in-flight-finish',
      type: 'abort',
      payload: {},
    })
    resolveFinish?.()

    await expect(finishPromise).rejects.toThrow('JPEG_RUNTIME_ABORTED')
  })

  it('marks backend write failures terminal without reusing the encoder', async () => {
    let createCalls = 0
    let writeRowsCalls = 0
    let finishCalls = 0
    const core = createJpegRuntimeCore(async () => () => {
      createCalls += 1

      return createStreamingEncoder({
        async writeRows() {
          writeRowsCalls += 1
          throw new Error('JPEG_NATIVE_WRITE_FAILED')
        },
        async finish() {
          finishCalls += 1
          return []
        },
      })
    })

    await core.handleRequest({
      id: 'create-write-failure',
      type: 'create',
      payload: { width: 1, height: 1, quality: 0.9 },
    })

    await expect(
      core.handleRequest({
        id: 'rows-write-failure',
        type: 'rows',
        payload: { rows: new Uint8Array([255, 255, 255]), rowCount: 1 },
      }),
    ).rejects.toThrow('JPEG_NATIVE_WRITE_FAILED')
    await expect(
      core.handleRequest({
        id: 'rows-after-write-failure',
        type: 'rows',
        payload: { rows: new Uint8Array([255, 255, 255]), rowCount: 1 },
      }),
    ).rejects.toThrow('JPEG_RUNTIME_ABORTED')
    await expect(
      core.handleRequest({
        id: 'finish-after-write-failure',
        type: 'finish',
        payload: {},
      }),
    ).rejects.toThrow('JPEG_RUNTIME_ABORTED')
    await expect(
      core.handleRequest({
        id: 'create-after-write-failure',
        type: 'create',
        payload: { width: 1, height: 1, quality: 0.9 },
      }),
    ).rejects.toThrow('JPEG_RUNTIME_ABORTED')

    expect(createCalls).toBe(1)
    expect(writeRowsCalls).toBe(1)
    expect(finishCalls).toBe(0)
  })

  it('marks backend finish failures terminal without reusing the encoder', async () => {
    let createCalls = 0
    let writeRowsCalls = 0
    let finishCalls = 0
    const core = createJpegRuntimeCore(async () => () => {
      createCalls += 1

      return createStreamingEncoder({
        async writeRows() {
          writeRowsCalls += 1
          return []
        },
        async finish() {
          finishCalls += 1
          throw new Error('JPEG_NATIVE_FINISH_FAILED')
        },
      })
    })

    await core.handleRequest({
      id: 'create-finish-failure',
      type: 'create',
      payload: { width: 1, height: 1, quality: 0.9 },
    })
    await core.handleRequest({
      id: 'rows-before-finish-failure',
      type: 'rows',
      payload: { rows: new Uint8Array([255, 255, 255]), rowCount: 1 },
    })

    await expect(
      core.handleRequest({
        id: 'finish-failure',
        type: 'finish',
        payload: {},
      }),
    ).rejects.toThrow('JPEG_NATIVE_FINISH_FAILED')
    await expect(
      core.handleRequest({
        id: 'finish-after-finish-failure',
        type: 'finish',
        payload: {},
      }),
    ).rejects.toThrow('JPEG_RUNTIME_ABORTED')
    await expect(
      core.handleRequest({
        id: 'rows-after-finish-failure',
        type: 'rows',
        payload: { rows: new Uint8Array([255, 255, 255]), rowCount: 1 },
      }),
    ).rejects.toThrow('JPEG_RUNTIME_ABORTED')
    await expect(
      core.handleRequest({
        id: 'create-after-finish-failure',
        type: 'create',
        payload: { width: 1, height: 1, quality: 0.9 },
      }),
    ).rejects.toThrow('JPEG_RUNTIME_ABORTED')

    expect(createCalls).toBe(1)
    expect(writeRowsCalls).toBe(1)
    expect(finishCalls).toBe(1)
  })
})
