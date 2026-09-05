import { createHash } from 'node:crypto'

import type { ProcessingParams } from '@lumaforge/luma-color-runtime'
import { resolveExportColorGraph } from '@lumaforge/luma-color-runtime'
import { verifyManifestSha256 } from '@lumaforge/render-engine/manifest'
import { describe, expect, it, vi } from 'vitest'

import type { FileBackedOutputResult } from '~/lib/export/output-sink'
import { createBlobOutputResult } from '~/lib/export/output-sink'

import { createExportResult } from '../../model/export-result'
import type { StyleAsset } from '../../model/session'
import { buildManifestForExportResult } from './attach-export-manifest'
import { resolveExportEnvironment } from './export-manifest'

const exposure = { ev: 0, multiplier: 1, source: 'identity' as const }

const params: ProcessingParams = {
  intensity: 1,
  viewMode: 'processed',
  compareSplit: 0.5,
  styleKind: 'none',
  builtinPreset: null,
  userExposureEv: 0,
  userContrast: 0,
  userHighlights: 0,
  userShadows: 0,
  userWhites: 0,
  userBlacks: 0,
  userTemperature: 0,
  userTint: 0,
  userSaturation: 0,
  userVibrance: 0,
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function resolveGraph() {
  const graph = resolveExportColorGraph({
    styleKind: 'none',
    intensity: 1,
    builtinPreset: null,
    lut: null,
    rawRenderExposure: exposure,
    userExposureEv: 0,
  })
  if (!graph.supported) throw new Error(graph.message)
  return graph
}

function buildInput(style: StyleAsset | null) {
  const jpegBytes = new TextEncoder().encode('jpeg-bytes')
  const sourceBytes = new TextEncoder().encode('raw-bytes')
  const result = createExportResult({
    output: createBlobOutputResult({
      blob: new Blob([jpegBytes], { type: 'image/jpeg' }),
      filename: 'frame_neutral_fullres.jpg',
    }),
    filename: 'frame_neutral_fullres.jpg',
    width: 4,
    height: 2,
    now: () => 123,
    copyCapability: { mode: 'unavailable', reason: 'n/a' },
  })
  return {
    jpegBytes,
    sourceBytes,
    input: {
      result,
      sourceFile: new File([sourceBytes], 'frame.arw', {
        type: 'application/octet-stream',
      }),
      graph: resolveGraph(),
      params,
      rawRenderExposure: exposure,
      style,
      quality: 0.92,
      policy: { kind: 'export-full' as const, row_slice: 256, concurrency: 2 },
      environment: resolveExportEnvironment('desktop'),
      now: () => new Date('2026-09-05T00:00:00Z'),
    },
  }
}

describe('buildManifestForExportResult', () => {
  it('hashes the source and the delivered jpeg and seals a verifiable manifest', async () => {
    const { input, jpegBytes, sourceBytes } = buildInput(null)

    const manifest = await buildManifestForExportResult(input)

    expect(verifyManifestSha256(manifest)).toBe(true)
    expect(manifest.kind).toBe('export')
    expect(manifest.output.sha256).toBe(sha256(jpegBytes))
    expect(manifest.output.filename).toBe('frame_neutral_fullres.jpg')
    expect(manifest.output.quality).toBe(92)
    expect(manifest.source_raw).toEqual({
      sha256: sha256(sourceBytes),
      byte_size: sourceBytes.byteLength,
      filename: 'frame.arw',
      decoded_dimensions: { width: 4, height: 2 },
    })
    expect(manifest.lut).toBeNull()
    expect(manifest.policy).toEqual({
      kind: 'export-full',
      row_slice: 256,
      concurrency: 2,
    })
    expect(manifest.produced_at).toBe('2026-09-05T00:00:00.000Z')
  })

  it('refuses to seal a manifest for a custom LUT without a confirmed identity', async () => {
    const style = {
      kind: 'custom',
      name: 'Unconfirmed',
      defaultIntensityLevel: 'medium',
      currentIntensityLevel: 'medium',
      lutAsset: {
        format: 'cube',
        dimension: 17,
        sha256: 'e'.repeat(64),
        profileResolution: { kind: 'unresolved' },
      },
    } as unknown as StyleAsset
    const { input } = buildInput(style)

    await expect(buildManifestForExportResult(input)).rejects.toThrow(/LUT/)
  })
  it('uses the hash recorded at write time for file-backed output without reopening it', async () => {
    const { input, jpegBytes } = buildInput(null)
    const openBlob = vi.fn(async () => new Blob([jpegBytes]))
    const output: FileBackedOutputResult = {
      kind: 'file-backed',
      exportId: 'export-1',
      filename: 'frame_neutral_fullres.jpg',
      byteLength: jpegBytes.byteLength,
      mimeType: 'image/jpeg',
      sha256: sha256(jpegBytes),
      openBlob,
    }

    const manifest = await buildManifestForExportResult({
      ...input,
      result: { ...input.result, output },
    })

    expect(manifest.output.sha256).toBe(sha256(jpegBytes))
    expect(openBlob).not.toHaveBeenCalled()
  })

  it('refuses to seal file-backed output whose hash was never recorded', async () => {
    const { input, jpegBytes } = buildInput(null)
    const openBlob = vi.fn(async () => new Blob([jpegBytes]))
    const output: FileBackedOutputResult = {
      kind: 'file-backed',
      exportId: 'export-1',
      filename: 'frame_neutral_fullres.jpg',
      byteLength: jpegBytes.byteLength,
      mimeType: 'image/jpeg',
      openBlob,
    }

    await expect(
      buildManifestForExportResult({
        ...input,
        result: { ...input.result, output },
      }),
    ).rejects.toThrow(/hash was not recorded/)
    expect(openBlob).not.toHaveBeenCalled()
  })
})
