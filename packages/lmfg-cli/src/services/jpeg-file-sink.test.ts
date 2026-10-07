// @vitest-environment node
import { createHash } from 'node:crypto'
import type { FileHandle } from 'node:fs/promises'
import { mkdtemp, open, readdir, readFile, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import { createLumaJpegRuntimeForNode } from '@lumaforge/luma-jpeg-runtime/node'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LmfgError, toLmfgError } from '../protocol/errors'
import { createFileJpegRowSink } from './jpeg-file-sink'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: vi.fn(actual.open),
    rename: vi.fn(actual.rename),
    rm: vi.fn(actual.rm),
  }
})

const actualFs =
  await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')

/** Filesystem failures the next export hits; `null` lets the call through. */
const faults: {
  write: Error | null
  closeWritten: Error | null
  closeRead: Error | null
  rename: Error | null
  unlink: Error | null
} = {
  write: null,
  closeWritten: null,
  closeRead: null,
  rename: null,
  unlink: null,
}

function fsError(code: string, syscall: string, path: string): Error {
  return Object.assign(
    new Error(`${code}: injected ${syscall} failure, ${syscall} '${path}'`),
    { code, syscall, path },
  )
}

/** A real file handle whose write and close fail when told to. */
function faultyHandle(handle: FileHandle, flags: unknown): FileHandle {
  const written = flags === 'w'
  return new Proxy(handle, {
    get(target, property) {
      if (property === 'write' && written && faults.write) {
        const failure = faults.write
        return async () => {
          throw failure
        }
      }
      const closeFault = written ? faults.closeWritten : faults.closeRead
      if (property === 'close' && closeFault) {
        return async () => {
          // Release the descriptor so the test leaks nothing, then fail.
          await target.close()
          throw closeFault
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lmfg-jpeg-sink-'))
  faults.write = null
  faults.closeWritten = null
  faults.closeRead = null
  faults.rename = null
  faults.unlink = null
  vi.mocked(open).mockImplementation((async (
    path: Parameters<typeof actualFs.open>[0],
    flags?: Parameters<typeof actualFs.open>[1],
    mode?: Parameters<typeof actualFs.open>[2],
  ) =>
    faultyHandle(await actualFs.open(path, flags, mode), flags)) as typeof open)
  vi.mocked(rename).mockImplementation(async (from, to) => {
    if (faults.rename) throw faults.rename
    return actualFs.rename(from, to)
  })
  vi.mocked(rm).mockImplementation(async (path, options) => {
    if (faults.unlink) throw faults.unlink
    return actualFs.rm(path, options)
  })
})
afterEach(async () => {
  await actualFs.rm(dir, { recursive: true, force: true })
})

const JPEG = new Uint8Array([0xFF, 0xD8, 0xFF, 0xDB, 0x00, 0x02, 0xFF, 0xD9])

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true, recursive: true })
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)))
    .sort()
}

/** A chunk-mode JPEG runtime that emits `JPEG` on finish unless told to fail. */
function fakeRuntime(
  options: {
    writeError?: Error
    finishError?: Error
    abortError?: Error
    disposeError?: Error
    bytes?: Uint8Array
    /** Emitted on every row write, so the temp file exists before close. */
    rowChunk?: Uint8Array
  } = {},
) {
  const encoder = {
    writeRows: vi.fn(async () => {
      if (options.writeError) throw options.writeError
    }),
    finish: vi.fn(async () => {}),
    abort: vi.fn(async () => {
      if (options.abortError) throw options.abortError
    }),
  }
  const dispose = vi.fn(() => {
    if (options.disposeError) throw options.disposeError
  })
  const createRuntime = (async (
    runtimeOptions?: Parameters<typeof createLumaJpegRuntimeForNode>[0],
  ) => ({
    createEncoder: () => ({
      ...encoder,
      writeRows: async () => {
        await encoder.writeRows()
        if (options.rowChunk) {
          await runtimeOptions?.onChunk?.({ bytes: options.rowChunk } as never)
        }
      },
      finish: async () => {
        await encoder.finish()
        if (options.finishError) throw options.finishError
        await runtimeOptions?.onChunk?.({
          bytes: options.bytes ?? JPEG,
        } as never)
        return new Uint8Array(0)
      },
    }),
    dispose,
  })) as unknown as typeof createLumaJpegRuntimeForNode
  return { createRuntime, encoder, dispose }
}

function openSession(createRuntime: typeof createLumaJpegRuntimeForNode) {
  const path = join(dir, 'exports', 'final.jpg')
  const sink = createFileJpegRowSink({ path, createRuntime })
  const session = sink.createSession({ width: 1, height: 1, quality: 0.9 })
  return { path, sink, session }
}

describe('createFileJpegRowSink', () => {
  it('keeps a closed JPEG provisional until commit, and discard removes it', async () => {
    const { createRuntime } = fakeRuntime()
    const { path, sink, session } = openSession(createRuntime)
    expect(sink.result()).toBeNull()

    await session.writeRows(new Uint8Array(3), 1)
    await session.close()
    const streamed = sink.result()
    expect(streamed?.path).toBe(path)
    expect(await listFiles(dir)).toEqual([relative(dir, streamed!.tmpPath)])

    await streamed!.discard()
    expect(await listFiles(dir)).toEqual([])
    await expect(streamed!.commit()).rejects.toMatchObject({
      code: 'export.refused',
    })
    expect(await listFiles(dir)).toEqual([])
  })

  it('publishes the closed JPEG only on commit', async () => {
    const { createRuntime } = fakeRuntime()
    const { path, sink, session } = openSession(createRuntime)

    await session.writeRows(new Uint8Array(3), 1)
    await session.close()
    const streamed = sink.result()!
    await streamed.commit()
    expect(await listFiles(dir)).toEqual(['exports/final.jpg'])
    const jpeg = await readFile(path)
    expect(jpeg.byteLength).toBe(streamed.byteLength)
    expect(createHash('sha256').update(jpeg).digest('hex')).toBe(
      streamed.sha256,
    )
    expect([...jpeg.subarray(0, 2), ...jpeg.subarray(-2)]).toEqual([
      0xFF, 0xD8, 0xFF, 0xD9,
    ])
  })

  it('rethrows a row write failure and leaves no file', async () => {
    const writeError = new Error('LUMA_JPEG_WRITE_FAILED')
    const { createRuntime, encoder, dispose } = fakeRuntime({ writeError })
    const { sink, session } = openSession(createRuntime)

    await expect(session.writeRows(new Uint8Array(3), 1)).rejects.toBe(
      writeError,
    )
    expect(encoder.abort).toHaveBeenCalledTimes(1)
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(sink.result()).toBeNull()
    await expect(session.close()).rejects.toThrow('JPEG_WRITER_CLOSED')
    expect(await listFiles(dir)).toEqual([])
  })

  it('rethrows a finish failure without exposing a result or a file', async () => {
    const finishError = new Error('LUMA_JPEG_FINISH_FAILED')
    const { createRuntime, encoder } = fakeRuntime({ finishError })
    const { sink, session } = openSession(createRuntime)

    await session.writeRows(new Uint8Array(3), 1)
    await expect(session.close()).rejects.toBe(finishError)
    expect(encoder.abort).toHaveBeenCalledTimes(1)
    expect(sink.result()).toBeNull()
    expect(await listFiles(dir)).toEqual([])
  })

  it('aborts an open session without leaving a file', async () => {
    const { createRuntime, encoder } = fakeRuntime()
    const { sink, session } = openSession(createRuntime)

    await session.writeRows(new Uint8Array(3), 1)
    await session.abort()
    await session.abort()
    expect(encoder.abort).toHaveBeenCalledTimes(1)
    expect(sink.result()).toBeNull()
    expect(await listFiles(dir)).toEqual([])
  })
})

/** A JPEG-shaped chunk past the 64 KiB header scan, so the temp file opens. */
function largeChunk(): Uint8Array {
  const bytes = new Uint8Array(70_000)
  bytes.set([0xFF, 0xD8, 0xFF, 0xDB, 0x00, 0x02])
  return bytes
}

function envelopeOf(error: unknown) {
  return toLmfgError(error).toEnvelope().error
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected a rejection')
    },
    (error: unknown) => error,
  )
}

async function tempFiles(): Promise<string[]> {
  return (await listFiles(dir)).filter((name) => name.endsWith('.tmp'))
}

async function closedSession(options: Parameters<typeof fakeRuntime>[0] = {}) {
  const { createRuntime } = fakeRuntime(options)
  const opened = openSession(createRuntime)
  await opened.session.writeRows(new Uint8Array(3), 1)
  await opened.session.close()
  return { ...opened, streamed: opened.sink.result()! }
}

describe('createFileJpegRowSink cleanup failures', () => {
  it('keeps a write failure as is when the temp file is removed', async () => {
    const { createRuntime } = fakeRuntime()
    const { sink, session } = openSession(createRuntime)
    faults.write = fsError('ENOSPC', 'write', dir)

    await session.writeRows(new Uint8Array(3), 1)
    const error = await rejectionOf(session.close())

    expect(error).toBe(faults.write)
    expect(sink.result()).toBeNull()
    expect(sink.cleanupFailures()).toEqual([])
    expect(await listFiles(dir)).toEqual([])
  })

  it('keeps a write failure when the temp file cannot be removed', async () => {
    const { createRuntime } = fakeRuntime()
    const { sink, session } = openSession(createRuntime)
    const writeFault = fsError('ENOSPC', 'write', dir)
    faults.write = writeFault
    faults.unlink = fsError('EACCES', 'unlink', dir)

    await session.writeRows(new Uint8Array(3), 1)
    const error = await rejectionOf(session.close())

    expect(error).toBeInstanceOf(LmfgError)
    expect((error as LmfgError).cause).toBe(writeFault)
    const envelope = envelopeOf(error)
    expect(envelope).toMatchObject({
      code: 'internal',
      message: writeFault.message,
      details: {
        cleanup_failures: [
          {
            step: 'remove_temp_file',
            code: 'permission.denied',
            errno: 'EACCES',
          },
        ],
      },
    })
    expect(JSON.stringify(envelope.details)).not.toContain(dir)
    expect(sink.result()).toBeNull()
    expect(sink.cleanupFailures()).toEqual(envelope.details?.cleanup_failures)
    expect(await tempFiles()).toHaveLength(1)
  })

  it('keeps a close failure when the temp file cannot be removed', async () => {
    const { createRuntime } = fakeRuntime()
    const { sink, session } = openSession(createRuntime)
    const closeFault = fsError('EIO', 'close', dir)
    faults.closeWritten = closeFault

    await session.writeRows(new Uint8Array(3), 1)
    expect(await rejectionOf(session.close())).toBe(closeFault)
    expect(await listFiles(dir)).toEqual([])

    const second = openSession(createRuntime)
    faults.unlink = fsError('EBUSY', 'unlink', dir)
    await second.session.writeRows(new Uint8Array(3), 1)
    const error = await rejectionOf(second.session.close())
    expect(envelopeOf(error)).toMatchObject({
      code: 'internal',
      message: closeFault.message,
      details: {
        cleanup_failures: [
          { step: 'remove_temp_file', code: 'internal', errno: 'EBUSY' },
        ],
      },
    })
    expect(sink.result()).toBeNull()
    expect(await tempFiles()).toHaveLength(1)
  })

  it('refuses an incomplete stream even when its check cannot close the file', async () => {
    faults.closeRead = fsError('EIO', 'close', dir)
    const { createRuntime } = fakeRuntime({
      bytes: new Uint8Array([0xFF, 0xD8, 0x00, 0x00, 0x00]),
    })
    const { sink, session } = openSession(createRuntime)

    await session.writeRows(new Uint8Array(3), 1)
    const error = await rejectionOf(session.close())

    expect(envelopeOf(error)).toMatchObject({
      code: 'export.refused',
      details: {
        cleanup_failures: [
          { step: 'close_temp_file', code: 'internal', errno: 'EIO' },
        ],
      },
    })
    expect(sink.result()).toBeNull()
    expect(await listFiles(dir)).toEqual([])
  })

  it('fails a complete stream whose check cannot close the file', async () => {
    const closeFault = fsError('EIO', 'close', dir)
    faults.closeRead = closeFault
    const { createRuntime } = fakeRuntime()
    const { sink, session } = openSession(createRuntime)

    await session.writeRows(new Uint8Array(3), 1)
    expect(await rejectionOf(session.close())).toBe(closeFault)
    expect(sink.result()).toBeNull()
    expect(await listFiles(dir)).toEqual([])
  })

  it('drops the temp file when the rename that publishes it fails', async () => {
    const { streamed } = await closedSession()
    const renameFault = fsError('EXDEV', 'rename', dir)
    faults.rename = renameFault

    expect(await rejectionOf(streamed.commit())).toBe(renameFault)
    expect(await listFiles(dir)).toEqual([])
    faults.rename = null
    await expect(streamed.commit()).rejects.toMatchObject({
      code: 'export.refused',
    })
    expect(await listFiles(dir)).toEqual([])
  })

  it('keeps a rename failure when the temp file cannot be removed either', async () => {
    const { streamed } = await closedSession()
    const renameFault = fsError('EXDEV', 'rename', dir)
    faults.rename = renameFault
    faults.unlink = fsError('EACCES', 'unlink', dir)

    const error = await rejectionOf(streamed.commit())

    expect((error as LmfgError).cause).toBe(renameFault)
    expect(envelopeOf(error)).toMatchObject({
      code: 'internal',
      message: renameFault.message,
      details: {
        cleanup_failures: [
          {
            step: 'remove_temp_file',
            code: 'permission.denied',
            errno: 'EACCES',
          },
        ],
      },
    })
    expect(await listFiles(dir)).toEqual([relative(dir, streamed.tmpPath)])
  })

  it('rejects a discard that cannot remove the temp file and lets it retry', async () => {
    const { streamed } = await closedSession()
    const unlinkFault = fsError('EACCES', 'unlink', dir)
    faults.unlink = unlinkFault

    expect(await rejectionOf(streamed.discard())).toBe(unlinkFault)
    expect(await listFiles(dir)).toEqual([relative(dir, streamed.tmpPath)])

    faults.unlink = null
    await streamed.discard()
    await expect(streamed.commit()).rejects.toMatchObject({
      code: 'export.refused',
    })
    expect(await listFiles(dir)).toEqual([])
  })

  it('records the failed steps of an engine abort without throwing', async () => {
    const { createRuntime } = fakeRuntime({
      rowChunk: largeChunk(),
      abortError: new Error('ENCODER_ABORT_FAILED'),
    })
    const { sink, session } = openSession(createRuntime)
    await session.writeRows(new Uint8Array(3), 1)
    expect(await tempFiles()).toHaveLength(1)
    faults.closeWritten = fsError('EIO', 'close', dir)
    faults.unlink = fsError('EACCES', 'unlink', dir)

    await session.abort()
    await session.abort()

    expect(sink.cleanupFailures()).toEqual([
      { step: 'abort_jpeg_encoder', code: 'internal' },
      { step: 'close_temp_file', code: 'internal', errno: 'EIO' },
      { step: 'remove_temp_file', code: 'permission.denied', errno: 'EACCES' },
    ])
    expect(sink.result()).toBeNull()
    expect(await tempFiles()).toHaveLength(1)
  })

  it('keeps an encoder failure when aborting and disposing the encoder fail too', async () => {
    const writeError = new Error('LUMA_JPEG_WRITE_FAILED')
    const { createRuntime, encoder, dispose } = fakeRuntime({
      writeError,
      abortError: new Error('ENCODER_ABORT_FAILED'),
      disposeError: new Error('RUNTIME_DISPOSE_FAILED'),
    })
    const { sink, session } = openSession(createRuntime)

    const error = await rejectionOf(session.writeRows(new Uint8Array(3), 1))

    expect((error as LmfgError).cause).toBe(writeError)
    expect(envelopeOf(error)).toMatchObject({
      code: 'render.failed',
      message: 'LUMA_JPEG_WRITE_FAILED',
      details: {
        cleanup_failures: [
          { step: 'abort_jpeg_encoder', code: 'internal' },
          { step: 'dispose_jpeg_runtime', code: 'internal' },
        ],
      },
    })
    expect(encoder.abort).toHaveBeenCalledTimes(1)
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(sink.cleanupFailures()).toHaveLength(2)
    expect(await listFiles(dir)).toEqual([])
  })
})

/**
 * The Node JPEG runtime over a native module stand-in: every row write emits
 * a chunk large enough to open the temp file, and abort fails when told to.
 */
function nodeRuntime(faults: { abort?: Error } = {}) {
  const calls = { abort: 0 }
  class LumaJpegEncoder {
    private pending: Array<{
      bytes: Uint8Array
      byteOffset: number
      final: boolean
    }> = []

    writeRows() {
      this.pending.push({ bytes: largeChunk(), byteOffset: 0, final: false })
    }

    finish() {
      this.pending.push({
        bytes: new Uint8Array([0xFF, 0xD9]),
        byteOffset: 0,
        final: true,
      })
      return new Uint8Array(0)
    }

    drainChunks() {
      const chunks = this.pending
      this.pending = []
      return chunks
    }

    abort() {
      calls.abort += 1
      if (faults.abort) throw faults.abort
    }

    delete() {}
  }
  const createRuntime = ((
    options?: Parameters<typeof createLumaJpegRuntimeForNode>[0],
  ) =>
    createLumaJpegRuntimeForNode({
      ...options,
      nativeLoader: async () => ({ LumaJpegEncoder }),
    })) as typeof createLumaJpegRuntimeForNode
  return { createRuntime, calls }
}

describe('createFileJpegRowSink with the Node JPEG runtime', () => {
  it('records a native abort failure when the engine aborts the session', async () => {
    const { createRuntime, calls } = nodeRuntime({
      abort: new Error('NATIVE_ABORT_FAILED'),
    })
    const { sink, session } = openSession(createRuntime)
    await session.writeRows(new Uint8Array(3), 1)
    expect(await tempFiles()).toHaveLength(1)

    await session.abort()

    expect(calls.abort).toBe(1)
    expect(sink.cleanupFailures()).toEqual([
      { step: 'abort_jpeg_encoder', code: 'internal' },
    ])
    expect(sink.result()).toBeNull()
    expect(await listFiles(dir)).toEqual([])
  })

  it('keeps a refused row write when the native abort fails too', async () => {
    const { createRuntime, calls } = nodeRuntime({
      abort: new Error('NATIVE_ABORT_FAILED'),
    })
    const { sink, session } = openSession(createRuntime)
    await session.writeRows(new Uint8Array(3), 1)
    faults.unlink = fsError('EACCES', 'unlink', dir)

    // One row declared as two: the runtime refuses it and keeps the encoder.
    const error = await rejectionOf(session.writeRows(new Uint8Array(3), 2))

    expect((error as LmfgError).cause).toMatchObject({
      message: 'JPEG_ROW_LENGTH_MISMATCH',
    })
    const envelope = envelopeOf(error)
    expect(envelope).toMatchObject({
      message: 'JPEG_ROW_LENGTH_MISMATCH',
      details: {
        cleanup_failures: [
          { step: 'abort_jpeg_encoder', code: 'internal' },
          {
            step: 'remove_temp_file',
            code: 'permission.denied',
            errno: 'EACCES',
          },
        ],
      },
    })
    expect(JSON.stringify(envelope.details)).not.toContain(dir)
    expect(calls.abort).toBe(1)
    expect(sink.cleanupFailures()).toEqual(envelope.details?.cleanup_failures)
    expect(await tempFiles()).toHaveLength(1)
  })

  it('records nothing when the native abort succeeds', async () => {
    const { createRuntime, calls } = nodeRuntime()
    const { sink, session } = openSession(createRuntime)
    await session.writeRows(new Uint8Array(3), 1)

    await session.abort()

    expect(calls.abort).toBe(1)
    expect(sink.cleanupFailures()).toEqual([])
    expect(await listFiles(dir)).toEqual([])
  })
})
