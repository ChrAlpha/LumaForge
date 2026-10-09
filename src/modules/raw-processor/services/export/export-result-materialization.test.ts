import type { ColorGraphIntent } from '@lumaforge/luma-color-runtime'
import { NEUTRAL_USER_COLOR_INTENT } from '@lumaforge/luma-color-runtime'
import type { ExportGeometry } from '@lumaforge/render-engine/export'
import {
  createBlobOutputResult,
  materializeOutputBlob,
} from '@lumaforge/render-engine/export'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createMemoryFileBackedOutputResult } from '~/lib/export/output-sink'

import type { ExportCopyCapability } from '../../model/export-result'
import { captureExportResultIdentity } from './export-result-identity'
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

  describe('request identity', () => {
    function captureRequest() {
      const intent: {
        -readonly [K in keyof ColorGraphIntent]: ColorGraphIntent[K]
      } = {
        styleKind: 'none',
        builtinPreset: null,
        intensity: 0.42,
        ...NEUTRAL_USER_COLOR_INTENT,
        userExposureEv: 0.25,
      }
      const geometry: ExportGeometry = {
        matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
        constrainCrop: true,
      }
      const identity = captureExportResultIdentity({
        resultKind: 'full-resolution',
        attemptId: 'attempt-1',
        sessionId: 'session-1',
        sourceFile: new File(['raw'], 'frame.dng', { lastModified: 1 }),
        intent,
        lut: null,
        rawRenderExposure: { ev: 0, multiplier: 1, source: 'identity' },
        geometry,
      })
      return { identity, intent, geometry }
    }

    function materialize(
      identity: ReturnType<typeof captureRequest>['identity'],
      kind?: 'full-resolution' | 'hq-preview',
    ) {
      return createCompletedExportResult({
        jobResult: {
          filename: 'frame.jpg',
          blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
        },
        ...(kind ? { kind } : {}),
        metadata: null,
        width: 6048,
        height: 4024,
        copyCapability: fullResolutionCopy,
        now: () => 1,
        identity,
      })
    }

    it('keeps the identity its producer captured, not completion-time state', () => {
      const { identity, intent, geometry } = captureRequest()
      const captured = identity.inputSignature

      // The request was captured; the workflow then moved on before the
      // job completed.
      intent.userExposureEv = 1.5
      intent.intensity = 1
      ;(geometry.matrix as number[])[2] = 0.3

      const result = materialize(identity)

      expect(result.identity).toBe(identity)
      expect(result.identity?.inputSignature).toBe(captured)
      expect(result.identity?.colorIntent.userExposureEv).toBe(0.25)
      expect(result.identity?.colorIntent.intensity).toBe(0.42)
      expect(result.identity?.geometry?.matrix[2]).toBe(0)
      expect(result.identity?.attemptId).toBe('attempt-1')
    })

    it('refuses an identity captured for another result kind', () => {
      const { identity } = captureRequest()

      expect(() => materialize(identity, 'hq-preview')).toThrow(
        'EXPORT_RESULT_IDENTITY_MISMATCH',
      )
    })

    it('carries no identity when its producer captured none', () => {
      const result = createCompletedExportResult({
        jobResult: {
          filename: 'frame.jpg',
          blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
        },
        metadata: null,
        width: 6048,
        height: 4024,
        copyCapability: fullResolutionCopy,
        now: () => 1,
      })

      expect(result).not.toHaveProperty('identity')
    })
  })
})
