// @vitest-environment node
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import type { createLumaJpegRuntimeForNode } from '@lumaforge/luma-jpeg-runtime/node'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createFileJpegRowSink } from './jpeg-file-sink'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lmfg-jpeg-sink-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
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
  options: { writeError?: Error; finishError?: Error } = {},
) {
  const encoder = {
    writeRows: vi.fn(async () => {
      if (options.writeError) throw options.writeError
    }),
    finish: vi.fn(async () => {}),
    abort: vi.fn(),
  }
  const dispose = vi.fn()
  const createRuntime = (async (
    runtimeOptions?: Parameters<typeof createLumaJpegRuntimeForNode>[0],
  ) => ({
    createEncoder: () => ({
      ...encoder,
      finish: async () => {
        await encoder.finish()
        if (options.finishError) throw options.finishError
        await runtimeOptions?.onChunk?.({ bytes: JPEG } as never)
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
    await streamed!.commit()
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
