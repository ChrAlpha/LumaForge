import { createHash } from 'node:crypto'

import { vi } from 'vitest'

import {
  createBlobOutputResult,
  createMemoryFileBackedOutputResult,
  createOpfsFileBackedOutputResult,
  createOpfsOutputWritable,
  materializeOutputBlob,
} from './output-sink'

function createMemoryOpfsStorage() {
  const files = new Map<string, Blob>()

  function createBlob(parts: BlobPart[]) {
    const blob = new Blob(parts, { type: 'image/jpeg' })
    if (typeof blob.arrayBuffer !== 'function') {
      Object.defineProperty(blob, 'arrayBuffer', {
        configurable: true,
        value: async () => {
          const buffers = parts.map((part) =>
            part instanceof ArrayBuffer
              ? new Uint8Array(part)
              : ArrayBuffer.isView(part)
                ? new Uint8Array(part.buffer, part.byteOffset, part.byteLength)
                : part instanceof Uint8Array
                  ? part
                  : new TextEncoder().encode(String(part)),
          )
          const byteLength = buffers.reduce(
            (total, buffer) => total + buffer.byteLength,
            0,
          )
          const bytes = new Uint8Array(byteLength)
          let offset = 0
          for (const buffer of buffers) {
            bytes.set(buffer, offset)
            offset += buffer.byteLength
          }
          return bytes.buffer
        },
      })
    }
    return blob
  }

  function createDirectory(path: string): FileSystemDirectoryHandle {
    return {
      kind: 'directory',
      name: path.split('/').at(-1) ?? '',
      async getDirectoryHandle(name: string) {
        return createDirectory(`${path}/${name}`)
      },
      async getFileHandle(name: string, options?: FileSystemGetFileOptions) {
        const filePath = `${path}/${name}`
        if (!files.has(filePath) && !options?.create) {
          throw new Error(`missing-file:${filePath}`)
        }
        return {
          kind: 'file',
          name,
          async createWritable() {
            const chunks: BlobPart[] = []
            return {
              async write(chunk: BlobPart) {
                chunks.push(chunk)
              },
              async abort() {
                chunks.length = 0
              },
              async close() {
                files.set(filePath, createBlob(chunks))
              },
            } as FileSystemWritableFileStream
          },
          async getFile() {
            return (
              files.get(filePath) ?? new File([], name, { type: 'image/jpeg' })
            )
          },
        } as FileSystemFileHandle
      },
      async removeEntry(name: string) {
        files.delete(`${path}/${name}`)
      },
    } as FileSystemDirectoryHandle
  }

  return {
    storage: {
      getDirectory: async () => createDirectory(''),
    } as Pick<StorageManager, 'getDirectory'>,
    files,
  }
}

describe('export output sink', () => {
  it('materializes file-backed output only at handoff and protects copied bytes', async () => {
    const bytes = new Uint8Array([1, 2, 3])
    const result = createMemoryFileBackedOutputResult({
      exportId: 'export-1',
      filename: 'frame.jpg',
      mimeType: 'image/jpeg',
      bytes,
    })

    bytes[0] = 9

    expect(result.kind).toBe('file-backed')
    expect(result.exportId).toBe('export-1')
    expect(result.filename).toBe('frame.jpg')
    expect(result.mimeType).toBe('image/jpeg')
    expect(result.byteLength).toBe(3)

    const blob = await materializeOutputBlob(result)

    expect(blob.type).toBe('image/jpeg')
    expect(blob.size).toBe(3)
    await expect(blob.arrayBuffer()).resolves.toEqual(
      new Uint8Array([1, 2, 3]).buffer,
    )
  })

  it('keeps Blob-backed output explicit for non-ios handoff', async () => {
    const blob = new Blob(['jpeg'], { type: 'image/jpeg' })
    const result = createBlobOutputResult({ blob, filename: 'frame.jpg' })

    expect(result).toMatchObject({
      kind: 'blob',
      filename: 'frame.jpg',
      byteLength: 4,
      mimeType: 'image/jpeg',
    })
    await expect(materializeOutputBlob(result)).resolves.toBe(blob)
  })

  it('opens and cleans up OPFS-backed output lazily', async () => {
    const { storage, files } = createMemoryOpfsStorage()
    const writable = await createOpfsOutputWritable({
      exportId: 'export-opfs',
      storage,
    })
    await writable.write(new Uint8Array([1, 2, 3]))
    await writable.close()

    const result = createOpfsFileBackedOutputResult({
      exportId: 'export-opfs',
      filename: 'frame.jpg',
      byteLength: 3,
      mimeType: 'image/jpeg',
      storage,
    })

    expect(result.kind).toBe('file-backed')
    expect(result.byteLength).toBe(3)
    const blob = await materializeOutputBlob(result)
    expect(blob.type).toBe('image/jpeg')
    expect(blob.size).toBe(3)

    await result.cleanup?.()
    expect(files.size).toBe(0)
  })

  it('publishes OPFS output only after a finalized temp write', async () => {
    const { storage, files } = createMemoryOpfsStorage()
    const writable = await createOpfsOutputWritable({
      exportId: 'export-opfs-finalized',
      storage,
    })

    await writable.write(new Uint8Array([1, 2, 3]))
    const finalized = await writable.close()

    const expectedSha256 = createHash('sha256')
      .update(new Uint8Array([1, 2, 3]))
      .digest('hex')
    expect(finalized).toEqual({ byteLength: 3, sha256: expectedSha256 })
    const finalizedRecord = files.get(
      '/.lumaforge-exports/active/export-opfs-finalized/output.jpg.finalized.json',
    )
    expect(finalizedRecord).toBeTruthy()
    expect(
      JSON.parse(
        new TextDecoder().decode(await finalizedRecord!.arrayBuffer()),
      ),
    ).toMatchObject({ version: 1, byteLength: 3, sha256: expectedSha256 })
    expect(
      files.has('/.lumaforge-exports/active/export-opfs-finalized/output.jpg'),
    ).toBe(true)
    expect(
      files.has(
        '/.lumaforge-exports/active/export-opfs-finalized/output.jpg.finalized.json',
      ),
    ).toBe(true)
    expect(
      files.has(
        '/.lumaforge-exports/active/export-opfs-finalized/output.jpg.tmp',
      ),
    ).toBe(false)
  })

  it('removes OPFS temp output after abort without publishing final output', async () => {
    const { storage, files } = createMemoryOpfsStorage()
    const writable = await createOpfsOutputWritable({
      exportId: 'export-opfs-aborted',
      storage,
    })

    await writable.write(new Uint8Array([1, 2, 3]))
    await writable.abort()

    expect(files.size).toBe(0)
  })

  it('refuses to open OPFS output without a finalized marker', async () => {
    const { storage, files } = createMemoryOpfsStorage()
    files.set(
      '/.lumaforge-exports/active/export-opfs-unfinalized/output.jpg',
      new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }),
    )

    const result = createOpfsFileBackedOutputResult({
      exportId: 'export-opfs-unfinalized',
      filename: 'frame.jpg',
      byteLength: 3,
      mimeType: 'image/jpeg',
      storage,
    })

    await expect(materializeOutputBlob(result)).rejects.toThrow(/missing-file/)
  })

  it('snapshots OPFS file bytes when materializing for browser handoff', async () => {
    const { storage, files } = createMemoryOpfsStorage()
    const writable = await createOpfsOutputWritable({
      exportId: 'export-opfs-snapshot',
      storage,
    })
    await writable.write(new Uint8Array([4, 5, 6]))
    await writable.close()

    const filePath =
      '/.lumaforge-exports/active/export-opfs-snapshot/output.jpg'
    const file = files.get(filePath)
    if (!file) throw new Error('expected in-memory OPFS fixture file')
    const originalArrayBuffer = file.arrayBuffer.bind(file)
    const arrayBuffer = vi.fn(() => originalArrayBuffer())
    Object.defineProperty(file, 'arrayBuffer', {
      configurable: true,
      value: arrayBuffer,
    })

    const result = createOpfsFileBackedOutputResult({
      exportId: 'export-opfs-snapshot',
      filename: 'frame.jpg',
      byteLength: 3,
      mimeType: 'image/jpeg',
      storage,
    })

    const blob = await materializeOutputBlob(result)

    expect(arrayBuffer).toHaveBeenCalledTimes(1)
    await result.cleanup?.()
    expect(files.size).toBe(0)
    await expect(blob.arrayBuffer()).resolves.toEqual(
      new Uint8Array([4, 5, 6]).buffer,
    )
  })
  it('forwards a write-time sha256 on blob and OPFS results without reopening files', async () => {
    const digest = 'f'.repeat(64)
    const blobResult = createBlobOutputResult({
      filename: 'frame.jpg',
      blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
      sha256: digest,
    })
    expect(blobResult.sha256).toBe(digest)
    expect(
      createBlobOutputResult({
        filename: 'frame.jpg',
        blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
      }).sha256,
    ).toBeUndefined()

    const { storage } = createMemoryOpfsStorage()
    const getDirectory = vi.spyOn(storage, 'getDirectory')
    const opfsResult = createOpfsFileBackedOutputResult({
      exportId: 'export-opfs-hash',
      filename: 'frame.jpg',
      byteLength: 3,
      mimeType: 'image/jpeg',
      storage,
      sha256: digest,
    })
    expect(opfsResult.sha256).toBe(digest)
    expect(getDirectory).not.toHaveBeenCalled()
  })
})
