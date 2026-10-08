import { createHash } from 'node:crypto'

import type { ProcessingParams } from '@lumaforge/luma-color-runtime'
import { resolveExportColorGraph } from '@lumaforge/luma-color-runtime'
import type { FileBackedOutputResult } from '@lumaforge/render-engine/export'
import { createBlobOutputResult } from '@lumaforge/render-engine/export'
import { verifyManifestSha256 } from '@lumaforge/render-engine/manifest'
import { describe, expect, it, vi } from 'vitest'

import type { ExportResult } from '../../model/export-result'
import { createExportResult } from '../../model/export-result'
import type { StyleAsset } from '../../model/session'
import {
  buildManifestForExportResult,
  ExportManifestUnavailableError,
  sealExportResultManifest,
} from './attach-export-manifest'
import { resolveExportEnvironment } from './export-manifest'
import type { ExportResultIdentityInput } from './export-result-identity'
import { captureExportResultIdentity } from './export-result-identity'

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

function buildInput(
  style: StyleAsset | null,
  identity: Partial<ExportResultIdentityInput> = {},
) {
  const jpegBytes = new TextEncoder().encode('jpeg-bytes')
  const sourceBytes = new TextEncoder().encode('raw-bytes')
  const sourceFile = new File([sourceBytes], 'frame.arw', {
    type: 'application/octet-stream',
    lastModified: 1_000,
  })
  const result = createExportResult({
    output: createBlobOutputResult({
      blob: new Blob([jpegBytes], { type: 'image/jpeg' }),
      filename: 'frame_neutral_fullres.jpg',
    }),
    filename: 'frame_neutral_fullres.jpg',
    width: 4,
    height: 2,
    now: () => 123,
    copyCapability: {
      mode: 'unavailable',
      reasonCode: 'clipboard-unsupported',
    },
    identity: captureExportResultIdentity({
      resultKind: 'full-resolution',
      attemptId: 'attempt-1',
      sessionId: 'session-1',
      sourceFile,
      intent: params,
      lut: null,
      rawRenderExposure: exposure,
      geometry: null,
      ...identity,
    }),
  })
  return {
    jpegBytes,
    sourceBytes,
    input: {
      result,
      sourceFile,
      graph: resolveGraph(),
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
      defaultIntensity: 0.7,
      currentIntensity: 0.7,
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
  it('declares the geometry and keeps the source frame distinct from the output', async () => {
    const { input } = buildInput(null, {
      geometry: {
        matrix: [0.99, -0.04, 0.02, 0.04, 0.99, -0.01, 0, 0, 1],
        constrainCrop: true,
      },
    })

    const manifest = await buildManifestForExportResult({
      ...input,
      sourceDimensions: { width: 4032, height: 3024 },
    })

    expect(manifest.render_params.geometry).toEqual({
      matrix: [0.99, -0.04, 0.02, 0.04, 0.99, -0.01, 0, 0, 1],
      constrain_crop: true,
      output: { width: input.result.width, height: input.result.height },
    })
    // A geometried export delivers a smaller frame than the RAW it came from;
    // recording the output as the source's decoded size would describe a file
    // that never existed.
    expect(manifest.source_raw.decoded_dimensions).toEqual({
      width: 4032,
      height: 3024,
    })
    expect(manifest.output.dimensions).toEqual({
      width: input.result.width,
      height: input.result.height,
    })
  })

  it('falls back to the output frame as the source frame without geometry', async () => {
    const { input } = buildInput(null)

    const manifest = await buildManifestForExportResult(input)

    expect(manifest.render_params.geometry).toBeUndefined()
    expect(manifest.source_raw.decoded_dimensions).toEqual(
      manifest.output.dimensions,
    )
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

  it('records the request the result answers, not values changed while it seals', async () => {
    const intent = {
      ...params,
      intensity: 0.37,
      userExposureEv: 0.4,
      userTemperature: 12,
    }
    const { input } = buildInput(null, {
      intent,
      rawRenderExposure: {
        ev: 0.5,
        multiplier: 2 ** 0.5,
        source: 'image-statistics',
      },
      geometry: { matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1], constrainCrop: false },
    })
    // The record the request was captured from moves on while sealing waits.
    Object.assign(intent, { intensity: 1, userExposureEv: -2 })

    const manifest = await buildManifestForExportResult(input)

    expect(manifest.render_params).toMatchObject({
      exposure_ev: 0.4,
      intensity: 0.37,
      raw_render_exposure_ev: 0.5,
      raw_render_exposure_source: 'image-statistics',
      color_balance: { temperature: 12, tint: 0 },
      geometry: {
        matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
        constrain_crop: false,
        output: { width: 4, height: 2 },
      },
    })
  })

  it('refuses to seal a result that carries no request identity', async () => {
    const { input } = buildInput(null)
    const { identity: _identity, ...anonymous } = input.result

    const sealing = buildManifestForExportResult({
      ...input,
      result: anonymous,
    })

    await expect(sealing).rejects.toBeInstanceOf(ExportManifestUnavailableError)
    await expect(sealing).rejects.toMatchObject({ reason: 'internal' })
  })

  it('refuses to seal a result against a source file other than its own', async () => {
    const { input, sourceBytes } = buildInput(null)

    const sealing = buildManifestForExportResult({
      ...input,
      sourceFile: new File([sourceBytes], 'frame.arw', { lastModified: 2_000 }),
    })

    await expect(sealing).rejects.toMatchObject({ reason: 'internal' })
  })

  it('refuses to seal a full-resolution request without a pinned exposure', async () => {
    const { input } = buildInput(null, { rawRenderExposure: null })

    await expect(buildManifestForExportResult(input)).rejects.toMatchObject({
      reason: 'internal',
    })
  })
})

describe('sealExportResultManifest', () => {
  function sealingResult(): ExportResult {
    return {
      ...buildInput(null).input.result,
      manifestState: { status: 'sealing' },
    }
  }

  it('attaches a sealed manifest and keeps the result and its identity', async () => {
    const { input } = buildInput(null)
    const result = sealingResult()
    const manifest = await buildManifestForExportResult({ ...input, result })

    const sealed = sealExportResultManifest(result, {
      status: 'ready',
      manifest,
    })

    expect(sealed).toEqual({
      ...result,
      manifest,
      manifestState: { status: 'ready' },
    })
    expect(sealed.identity).toBe(result.identity)
    expect(sealed.output).toBe(result.output)
    expect(result.manifestState).toEqual({ status: 'sealing' })
  })

  it('records an unavailable manifest and keeps the identity', () => {
    const result = sealingResult()

    const sealed = sealExportResultManifest(result, {
      status: 'unavailable',
      reason: 'lut-unhashed',
    })

    expect(sealed).toEqual({
      ...result,
      manifestState: { status: 'unavailable', reason: 'lut-unhashed' },
    })
    expect(sealed).not.toHaveProperty('manifest')
    expect(sealed.identity).toBe(result.identity)
  })
})
