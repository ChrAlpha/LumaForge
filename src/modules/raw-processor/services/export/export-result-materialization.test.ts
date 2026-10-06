import {
  createBlobOutputResult,
  materializeOutputBlob,
} from '@lumaforge/render-engine/export'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createMemoryFileBackedOutputResult } from '~/lib/export/output-sink'

import type { ExportCopyCapability } from '../../model/export-result'
import { createCompletedExportResult } from './export-result-materialization'

const jpegMetadataMock = vi.hoisted(() => ({
  preserveJpegMetadata: vi.fn(
    async ({ jpeg }: { jpeg: Blob }) =>
      new Blob(['metadata'], { type: jpeg.type || 'image/jpeg' }),
  ),
}))

vi.mock('@lumaforge/render-engine/export', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@lumaforge/render-engine/export')>()),
  preserveJpegMetadata: jpegMetadataMock.preserveJpegMetadata,
}))

const fullResolutionCopy: ExportCopyCapability = {
  mode: 'full-resolution',
  label: 'Copy full-resolution image',
}

describe('export result materialization', () => {
  beforeEach(() => {
    jpegMetadataMock.preserveJpegMetadata.mockClear()
  })

  it('wraps legacy blob worker output as the completed export result', async () => {
    const blob = new Blob(['jpeg'], { type: 'image/jpeg' })

    const result = createCompletedExportResult({
      jobResult: {
        filename: 'frame_neutral_fullres.jpg',
        blob,
      },
      metadata: { make: 'Sony' },
      width: 6048,
      height: 4024,
      copyCapability: fullResolutionCopy,
      now: () => 123,
    })

    expect(result).toMatchObject({
      filename: 'frame_neutral_fullres.jpg',
      width: 6048,
      height: 4024,
      size: blob.size,
      createdAt: 123,
      copyCapability: fullResolutionCopy,
    })
    expect(result.output.kind).toBe('blob')
    await expect(materializeOutputBlob(result.output)).resolves.toBe(blob)
    expect(jpegMetadataMock.preserveJpegMetadata).not.toHaveBeenCalled()
  })

  it('prefers explicit worker output while keeping the job filename', async () => {
    const outputBlob = new Blob(['output'], { type: 'image/jpeg' })
    const legacyBlob = new Blob(['legacy'], { type: 'image/jpeg' })
    const output = createBlobOutputResult({
      filename: 'worker-output.jpg',
      blob: outputBlob,
    })

    const result = createCompletedExportResult({
      jobResult: {
        filename: 'requested-name.jpg',
        output,
        blob: legacyBlob,
      },
      metadata: null,
      width: 4000,
      height: 3000,
      copyCapability: fullResolutionCopy,
      now: () => 456,
    })

    expect(result.filename).toBe('requested-name.jpg')
    expect(result.output).toBe(output)
    expect(result.size).toBe(outputBlob.size)
    await expect(materializeOutputBlob(result.output)).resolves.toBe(outputBlob)
  })

  it('defers JPEG metadata preservation until file-backed output is opened', async () => {
    const metadata = { make: 'Sony', model: 'A7R' }
    const output = createMemoryFileBackedOutputResult({
      exportId: 'export-123',
      filename: 'file-backed.jpg',
      mimeType: 'image/jpeg',
      bytes: new TextEncoder().encode('jpeg'),
    })
    const originalOpenBlob = vi.spyOn(output, 'openBlob')

    const result = createCompletedExportResult({
      jobResult: {
        filename: 'frame_with_metadata.jpg',
        output,
      },
      metadata,
      width: 6048,
      height: 4024,
      copyCapability: fullResolutionCopy,
      now: () => 789,
    })

    expect(result.output.kind).toBe('file-backed')
    expect(originalOpenBlob).not.toHaveBeenCalled()
    expect(jpegMetadataMock.preserveJpegMetadata).not.toHaveBeenCalled()

    const materialized = await materializeOutputBlob(result.output)

    expect(originalOpenBlob).toHaveBeenCalledTimes(1)
    expect(jpegMetadataMock.preserveJpegMetadata).toHaveBeenCalledWith({
      jpeg: expect.any(Blob),
      metadata,
      width: 6048,
      height: 4024,
    })
    expect(materialized).toBeInstanceOf(Blob)
    expect(materialized.size).toBe(8)
    expect(materialized.type).toBe('image/jpeg')
  })

  it.each([
    { deliveryMetadata: { make: 'Canon' }, injected: { make: 'Canon' } },
    { deliveryMetadata: null, injected: null },
  ])(
    'injects the metadata the producer hashed with ($deliveryMetadata) and leaves cleanup to the owner',
    async ({ deliveryMetadata, injected }) => {
      const digest = 'd'.repeat(64)
      const openBlob = vi.fn(
        async () => new Blob(['jpeg'], { type: 'image/jpeg' }),
      )
      const cleanup = vi.fn(async () => undefined)

      const result = createCompletedExportResult({
        jobResult: {
          filename: 'frame.jpg',
          output: {
            kind: 'file-backed',
            exportId: 'export-hashed',
            filename: 'frame.jpg',
            byteLength: 4,
            mimeType: 'image/jpeg',
            sha256: digest,
            deliveryMetadata,
            openBlob,
            cleanup,
          },
        },
        metadata: { make: 'Sony' },
        width: 6048,
        height: 4024,
        copyCapability: fullResolutionCopy,
        now: () => 1,
      })

      expect(result.output).toMatchObject({
        kind: 'file-backed',
        sha256: digest,
        deliveryMetadata,
      })
      if (result.output.kind !== 'file-backed') {
        throw new Error('Expected file-backed output.')
      }
      expect(result.output.cleanup).toBe(cleanup)
      expect(openBlob).not.toHaveBeenCalled()

      await materializeOutputBlob(result.output)

      expect(openBlob).toHaveBeenCalledTimes(1)
      expect(jpegMetadataMock.preserveJpegMetadata).toHaveBeenCalledWith({
        jpeg: expect.any(Blob),
        metadata: injected,
        width: 6048,
        height: 4024,
      })
      expect(cleanup).not.toHaveBeenCalled()
    },
  )

  it('surfaces a failed file-backed open without injecting metadata or cleaning up', async () => {
    const cleanup = vi.fn(async () => undefined)
    const result = createCompletedExportResult({
      jobResult: {
        filename: 'frame.jpg',
        output: {
          kind: 'file-backed',
          exportId: 'export-missing',
          filename: 'frame.jpg',
          byteLength: 4,
          mimeType: 'image/jpeg',
          openBlob: vi.fn(async () => {
            throw new Error('missing-file')
          }),
          cleanup,
        },
      },
      metadata: { make: 'Sony' },
      width: 6048,
      height: 4024,
      copyCapability: fullResolutionCopy,
      now: () => 1,
    })

    await expect(materializeOutputBlob(result.output)).rejects.toThrow(
      'missing-file',
    )
    expect(jpegMetadataMock.preserveJpegMetadata).not.toHaveBeenCalled()
    expect(cleanup).not.toHaveBeenCalled()
  })

  it('throws the existing missing-output error when no output can be materialized', () => {
    expect(() =>
      createCompletedExportResult({
        jobResult: { filename: 'missing-output.jpg' },
        metadata: null,
        width: 6048,
        height: 4024,
        copyCapability: fullResolutionCopy,
        now: () => 123,
      }),
    ).toThrow('EXPORT_OUTPUT_MISSING')
  })
})
