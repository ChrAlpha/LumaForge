// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

import type { JpegExportMetadata } from './jpeg-metadata'
import type {
  ExportOutputResult,
  FileBackedOutputResult,
} from './output-result'
import {
  createBlobOutputResult,
  createBytesOutputResult,
  materializeOutputBlob,
} from './output-result'

const DIGEST = 'a'.repeat(64)

async function blobBytes(blob: Blob) {
  return new Uint8Array(await blob.arrayBuffer())
}

function createFileBackedOutput(
  overrides: Partial<FileBackedOutputResult> = {},
) {
  const openBlob = vi.fn(
    async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }),
  )
  const cleanup = vi.fn(async () => undefined)
  const output: FileBackedOutputResult = {
    kind: 'file-backed',
    exportId: 'export-1',
    filename: 'frame.jpg',
    byteLength: 3,
    mimeType: 'image/jpeg',
    openBlob,
    cleanup,
    ...overrides,
  }
  return { output, openBlob, cleanup }
}

describe('createBlobOutputResult', () => {
  it('describes the blob and defaults the mime type to JPEG', () => {
    const blob = new Blob([new Uint8Array([1, 2, 3, 4])])

    expect(createBlobOutputResult({ filename: 'frame.jpg', blob })).toEqual({
      kind: 'blob',
      filename: 'frame.jpg',
      blob,
      byteLength: 4,
      mimeType: 'image/jpeg',
    })
  })

  it('carries the delivered hash only when the producer recorded one', () => {
    const blob = new Blob(['jpeg'], { type: 'image/jpeg' })

    expect(
      createBlobOutputResult({ filename: 'frame.jpg', blob, sha256: DIGEST })
        .sha256,
    ).toBe(DIGEST)
    expect(
      'sha256' in createBlobOutputResult({ filename: 'frame.jpg', blob }),
    ).toBe(false)
    expect(
      'sha256' in
        createBlobOutputResult({ filename: 'frame.jpg', blob, sha256: '' }),
    ).toBe(false)
  })
})

describe('createBytesOutputResult', () => {
  it('describes the bytes and defaults the mime type to JPEG', () => {
    const bytes = new Uint8Array([1, 2, 3])

    expect(createBytesOutputResult({ filename: 'frame.jpg', bytes })).toEqual({
      kind: 'bytes',
      filename: 'frame.jpg',
      bytes,
      byteLength: 3,
      mimeType: 'image/jpeg',
    })
    expect(
      createBytesOutputResult({
        filename: 'frame.png',
        bytes,
        mimeType: 'image/png',
      }).mimeType,
    ).toBe('image/png')
  })
})

describe('file-backed output contract', () => {
  it('records the delivered hash and the metadata it was hashed with', () => {
    const deliveryMetadata: JpegExportMetadata = { make: 'Sony', iso: 100 }
    const output: ExportOutputResult = createFileBackedOutput({
      sha256: DIGEST,
      deliveryMetadata,
    }).output

    expect(output).toMatchObject({
      kind: 'file-backed',
      sha256: DIGEST,
      deliveryMetadata,
    })
    expect(
      createFileBackedOutput({ deliveryMetadata: null }).output
        .deliveryMetadata,
    ).toBeNull()
  })
})

describe('materializeOutputBlob', () => {
  it('hands back the blob of a blob result unchanged', async () => {
    const blob = new Blob(['jpeg'], { type: 'image/jpeg' })

    await expect(
      materializeOutputBlob(
        createBlobOutputResult({ filename: 'a.jpg', blob }),
      ),
    ).resolves.toBe(blob)
  })

  it('wraps bytes in a blob with the declared mime type', async () => {
    const blob = await materializeOutputBlob(
      createBytesOutputResult({
        filename: 'a.jpg',
        bytes: new Uint8Array([7, 8, 9]),
      }),
    )

    expect(blob.type).toBe('image/jpeg')
    await expect(blobBytes(blob)).resolves.toEqual(new Uint8Array([7, 8, 9]))
  })

  it('opens file-backed output only when asked and never cleans it up', async () => {
    const { output, openBlob, cleanup } = createFileBackedOutput({
      sha256: DIGEST,
    })

    expect(openBlob).not.toHaveBeenCalled()

    const blob = await materializeOutputBlob(output)

    expect(openBlob).toHaveBeenCalledTimes(1)
    expect(cleanup).not.toHaveBeenCalled()
    await expect(blobBytes(blob)).resolves.toEqual(new Uint8Array([1, 2, 3]))

    await materializeOutputBlob(output)
    expect(openBlob).toHaveBeenCalledTimes(2)
    expect(cleanup).not.toHaveBeenCalled()
  })

  it('surfaces a failed open without cleaning up the output', async () => {
    const { output, openBlob, cleanup } = createFileBackedOutput()
    openBlob.mockRejectedValueOnce(new Error('OPFS_OUTPUT_MISSING'))

    await expect(materializeOutputBlob(output)).rejects.toThrow(
      'OPFS_OUTPUT_MISSING',
    )
    expect(cleanup).not.toHaveBeenCalled()
  })
})
