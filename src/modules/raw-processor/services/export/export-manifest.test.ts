import { createHash } from 'node:crypto'

import type {
  ColorGraphIntent,
  LUTData,
  SupportedExportColorGraphDescriptor,
} from '@lumaforge/luma-color-runtime'
import {
  NEUTRAL_SELECTIVE_COLOR,
  NEUTRAL_USER_COLOR_INTENT,
  parseCubeLUT,
  resolveExportColorGraph,
  toLUTData,
} from '@lumaforge/luma-color-runtime'
import type { FileBackedOutputResult } from '@lumaforge/render-engine/export'
import { createBlobOutputResult } from '@lumaforge/render-engine/export'
import type { RenderManifest } from '@lumaforge/render-engine/manifest'
import {
  canonicalizeJson,
  parseRenderManifest,
} from '@lumaforge/render-engine/manifest'
import { describe, expect, it, vi } from 'vitest'

import type { ExportResult } from '../../model/export-result'
import { createExportResult } from '../../model/export-result'
import type { StyleAsset } from '../../model/session'
import type { BuildExportManifestInput } from './export-manifest'
import {
  buildManifestForExportResult,
  ExportManifestUnavailableError,
  resolveExportEnvironment,
  sealExportResultManifest,
} from './export-manifest'
import type { ExportResultIdentityInput } from './export-result-identity'
import { captureExportResultIdentity } from './export-result-identity'

const EXPOSURE = {
  ev: -0.2,
  multiplier: 2 ** -0.2,
  source: 'dng-baseline' as const,
}
const PRODUCED_AT = new Date('2026-09-05T00:00:00Z')

function params(overrides: Partial<ColorGraphIntent> = {}): ColorGraphIntent {
  return {
    intensity: 1,
    styleKind: 'none',
    builtinPreset: null,
    userExposureEv: 0.3,
    userContrast: 12,
    userHighlights: -5,
    userShadows: 4,
    userWhites: 0,
    userBlacks: 1,
    userTemperature: 8,
    userTint: -2,
    userSaturation: 3,
    userVibrance: 6,
    selectiveColor: NEUTRAL_SELECTIVE_COLOR,
    ...overrides,
  }
}

const CONFIRMED_STYLE: StyleAsset = {
  kind: 'custom',
  name: 'Look',
  defaultIntensity: 0.7,
  currentIntensity: 0.37,
  lutAsset: {
    format: 'cube',
    dimension: 17,
    sourceName: 'look.cube',
    sha256: 'a'.repeat(64),
    profileResolution: {
      kind: 'confirmed',
      confidence: 'metadata',
      profile: {
        id: 'display-srgb',
        label: 'Display sRGB',
        role: 'display-look',
        inputGamut: 'srgb-rec709',
        inputTransfer: 'srgb',
        inputRange: 'full',
        aliases: [],
      },
    },
  },
}

const LOOK_LUT: LUTData = {
  ...toLUTData(
    parseCubeLUT(
      `TITLE "Look"\nLUT_3D_SIZE 2\n${'0 0 0\n0.5 0.25 1\n'.repeat(4)}`,
    ),
  ),
  profileResolution: CONFIRMED_STYLE.lutAsset!.profileResolution!,
}

function sha256(data: string | ArrayBufferView): string {
  return createHash('sha256')
    .update(
      typeof data === 'string'
        ? data
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    )
    .digest('hex')
}

/** A delivered 4x2 result for `intent`, its source, and what seals it. */
function setup({
  intent = params(),
  lut = null,
  style = null,
  identity = {},
}: {
  intent?: ColorGraphIntent
  lut?: LUTData | null
  style?: StyleAsset | null
  identity?: Partial<ExportResultIdentityInput>
} = {}) {
  const jpegBytes = new TextEncoder().encode('jpeg-bytes')
  const sourceBytes = new TextEncoder().encode('raw-bytes')
  const sourceFile = new File([sourceBytes], 'frame.arw', {
    lastModified: 1_000,
  })
  const graph = resolveExportColorGraph({
    ...intent,
    lut,
    rawRenderExposure: EXPOSURE,
  })
  if (!graph.supported) throw new Error(graph.message)
  const result = createExportResult({
    output: createBlobOutputResult({
      blob: new Blob([jpegBytes], { type: 'image/jpeg' }),
      filename: 'frame_fullres.jpg',
    }),
    kind: 'full-resolution',
    filename: 'frame_fullres.jpg',
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
      intent,
      lut,
      rawRenderExposure: EXPOSURE,
      geometry: null,
      ...identity,
    }),
  })
  const input: BuildExportManifestInput = {
    result,
    sourceFile,
    graph,
    sourceDimensions: { width: 4, height: 2 },
    style,
    policy: { kind: 'export-full', row_slice: 256, concurrency: 2 },
    environment: resolveExportEnvironment('desktop'),
    now: () => PRODUCED_AT,
  }
  return { jpegBytes, sourceBytes, graph, input }
}

describe('buildManifestForExportResult', () => {
  it('hashes the source and the delivered JPEG and seals the record', async () => {
    const { input, jpegBytes, sourceBytes } = setup()

    const manifest = await buildManifestForExportResult(input)

    expect(manifest).toMatchObject({
      kind: 'export',
      source_raw: {
        sha256: sha256(sourceBytes),
        byte_size: sourceBytes.byteLength,
        filename: 'frame.arw',
        decoded_dimensions: { width: 4, height: 2 },
      },
      lut: null,
      policy: { kind: 'export-full', row_slice: 256, concurrency: 2 },
      output: {
        sha256: sha256(jpegBytes),
        filename: 'frame_fullres.jpg',
        quality: 92,
      },
      produced_at: '2026-09-05T00:00:00.000Z',
    })
  })

  it.each([
    ['lut-unhashed', { sha256: undefined }],
    ['lut-unconfirmed', { profileResolution: { kind: 'unknown' } }],
  ] as const)(
    'refuses to seal a custom LUT it cannot identify (%s)',
    async (reason, asset) => {
      const style = {
        ...CONFIRMED_STYLE,
        lutAsset: { ...CONFIRMED_STYLE.lutAsset!, ...asset },
      } as StyleAsset
      const { input } = setup({ style })

      await expect(buildManifestForExportResult(input)).rejects.toMatchObject({
        reason,
      })
    },
  )

  it.each([
    [
      'carries no request identity',
      (input: BuildExportManifestInput) => {
        const { identity: _identity, ...anonymous } = input.result
        return { ...input, result: anonymous as unknown as ExportResult }
      },
    ],
    [
      'is sealed against a source file other than its own',
      (input: BuildExportManifestInput) => ({
        ...input,
        sourceFile: new File(['raw-bytes'], 'frame.arw', {
          lastModified: 2_000,
        }),
      }),
    ],
  ])('refuses to seal a result that %s', async (_name, change) => {
    const { input } = setup()

    const sealing = buildManifestForExportResult(change(input))

    await expect(sealing).rejects.toBeInstanceOf(ExportManifestUnavailableError)
    await expect(sealing).rejects.toMatchObject({ reason: 'internal' })
  })

  it('refuses to seal a full-resolution request without a pinned exposure', async () => {
    const { input } = setup({ identity: { rawRenderExposure: null } })

    await expect(buildManifestForExportResult(input)).rejects.toMatchObject({
      reason: 'internal',
    })
  })

  it('uses the hash recorded at write time for file-backed output and never reopens it', async () => {
    const { input, jpegBytes } = setup()
    const openBlob = vi.fn(async () => new Blob([jpegBytes]))
    const output: FileBackedOutputResult = {
      kind: 'file-backed',
      exportId: 'export-1',
      filename: 'frame_fullres.jpg',
      byteLength: jpegBytes.byteLength,
      mimeType: 'image/jpeg',
      sha256: sha256(jpegBytes),
      openBlob,
    }
    const seal = (result: ExportResult) =>
      buildManifestForExportResult({ ...input, result })

    const manifest = await seal({ ...input.result, output })
    expect(manifest.output.sha256).toBe(sha256(jpegBytes))
    const { sha256: _unrecorded, ...unhashed } = output
    await expect(
      seal({ ...input.result, output: unhashed }),
    ).rejects.toMatchObject({ reason: 'output-unhashed' })
    expect(openBlob).not.toHaveBeenCalled()
  })

  it('records the request the result answers, not values changed while it seals', async () => {
    const intent = params({ intensity: 0.37, userExposureEv: 0.4 })
    const { input } = setup({
      intent,
      identity: {
        rawRenderExposure: {
          ev: 0.5,
          multiplier: 2 ** 0.5,
          source: 'image-statistics',
        },
        geometry: { matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1], constrainCrop: false },
      },
    })
    // The record the request was captured from moves on while sealing waits.
    Object.assign(intent, { intensity: 1, userExposureEv: -2 })

    const manifest = await buildManifestForExportResult(input)

    expect(manifest.render_params).toMatchObject({
      exposure_ev: 0.4,
      intensity: 0.37,
      raw_render_exposure_ev: 0.5,
      raw_render_exposure_source: 'image-statistics',
      geometry: {
        matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
        constrain_crop: false,
        output: { width: 4, height: 2 },
      },
    })
  })
})

describe('buildManifestForExportResult current record', () => {
  // Every expectation here is derived from the inputs, node:crypto and the
  // canonical JSON rules, never from the engine's own descriptor or
  // projection helpers, so the browser record is checked against what a
  // strict reader requires rather than against itself.
  const SHIFTED_HSL = {
    ...NEUTRAL_SELECTIVE_COLOR,
    red: { hue: 10, saturation: 0, lightness: 0 },
    blue: { hue: 0, saturation: -30, lightness: 5 },
  }

  /** The step as plain JSON, typed arrays written as number arrays. */
  function expectedStep(
    step: SupportedExportColorGraphDescriptor['steps'][number],
  ): unknown {
    if (step.kind === 'lut3d') {
      return {
        kind: 'lut3d',
        size: step.size,
        domain_min: [...step.domainMin],
        domain_max: [...step.domainMax],
        data_length: step.data.length,
        data_sha256: sha256(step.data),
        data_encoding: 'float32-le',
      }
    }
    return JSON.parse(
      JSON.stringify(step, (_key, value: unknown) =>
        ArrayBuffer.isView(value)
          ? Array.from(value as unknown as ArrayLike<number>)
          : value,
      ),
    )
  }

  function expectCurrentRecord(
    manifest: RenderManifest,
    graph: SupportedExportColorGraphDescriptor,
    intent: ColorGraphIntent,
    shape: { selectiveColor: boolean; geometry: boolean },
  ): void {
    // The seal the writer produced covers the record exactly as written.
    const { manifest_sha256: seal, ...unsealed } = manifest
    expect(seal).toBe(sha256(canonicalizeJson(unsealed)))

    // A strict reader takes the record as written, in memory and as JSON.
    const parsed = parseRenderManifest(manifest)
    expect(parsed).toEqual({ ok: true, manifest })
    expect(parsed.ok && parsed.manifest).toBe(manifest)
    const fromJson = JSON.parse(JSON.stringify(manifest)) as unknown
    expect(fromJson).toEqual(manifest)
    expect(parseRenderManifest(fromJson)).toEqual({
      ok: true,
      manifest: fromJson,
    })

    // The current descriptor, every step, and a fingerprint over them.
    const colorGraph = manifest.color_graph as {
      fingerprint: string
      descriptor: Record<string, unknown> & { steps: unknown[] }
    }
    expect(Object.keys(colorGraph).sort()).toEqual([
      'descriptor',
      'fingerprint',
    ])
    expect(Object.keys(colorGraph.descriptor).sort()).toEqual([
      'descriptor_version',
      'lut_profile',
      'output_gamut',
      'output_transfer',
      'steps',
    ])
    expect(colorGraph.descriptor.descriptor_version).toBe(2)
    expect(colorGraph.descriptor.output_gamut).toBe(graph.outputGamut)
    expect(colorGraph.descriptor.output_transfer).toBe(graph.outputTransfer)
    expect(colorGraph.descriptor.steps).toEqual(graph.steps.map(expectedStep))
    expect(colorGraph.fingerprint).toBe(
      sha256(canonicalizeJson(colorGraph.descriptor)),
    )

    // Complete executable sections; neutral HSL and unapplied geometry are
    // the only omissions, and nothing the color graph never reads is written.
    const renderParams = manifest.render_params
    expect(Object.keys(renderParams).sort()).toEqual(
      [
        'color_balance',
        'exposure_ev',
        ...(shape.geometry ? ['geometry'] : []),
        'intensity',
        'raw_render_exposure_ev',
        'raw_render_exposure_source',
        'saturation',
        ...(shape.selectiveColor ? ['selective_color'] : []),
        'tone_curve',
      ].sort(),
    )
    expect(renderParams).toMatchObject({
      exposure_ev: intent.userExposureEv,
      tone_curve: {
        contrast: intent.userContrast,
        highlights: intent.userHighlights,
        shadows: intent.userShadows,
        whites: intent.userWhites,
        blacks: intent.userBlacks,
      },
      color_balance: {
        temperature: intent.userTemperature,
        tint: intent.userTint,
      },
      saturation: {
        saturation: intent.userSaturation,
        vibrance: intent.userVibrance,
      },
      intensity: intent.intensity,
      raw_render_exposure_ev: EXPOSURE.ev,
      raw_render_exposure_source: EXPOSURE.source,
    })
    expect(Object.keys(renderParams.tone_curve ?? {}).sort()).toEqual([
      'blacks',
      'contrast',
      'highlights',
      'shadows',
      'whites',
    ])
    expect(Object.keys(renderParams.color_balance ?? {}).sort()).toEqual([
      'temperature',
      'tint',
    ])
    expect(Object.keys(renderParams.saturation ?? {}).sort()).toEqual([
      'saturation',
      'vibrance',
    ])
    if (shape.selectiveColor) {
      expect(renderParams.selective_color).toEqual(intent.selectiveColor)
    }

    expect(manifest.calibration).toBeNull()
  }

  it('writes a neutral record with HSL omitted', async () => {
    const intent = params(NEUTRAL_USER_COLOR_INTENT)
    const { graph, input } = setup({ intent })

    const manifest = await buildManifestForExportResult(input)

    expectCurrentRecord(manifest, graph, intent, {
      selectiveColor: false,
      geometry: false,
    })
    expect(manifest.color_graph.descriptor).toMatchObject({
      lut_profile: null,
    })
  })

  it('writes an edited record with every section complete', async () => {
    const intent = params({ selectiveColor: SHIFTED_HSL })
    const { graph, input } = setup({ intent })

    const manifest = await buildManifestForExportResult(input)

    expectCurrentRecord(manifest, graph, intent, {
      selectiveColor: true,
      geometry: false,
    })
  })

  it('writes a LUT record with its contract, its identity and its table digest', async () => {
    const intent = params({ styleKind: 'custom', intensity: 0.37 })
    const { graph, input } = setup({
      intent,
      lut: LOOK_LUT,
      style: CONFIRMED_STYLE,
    })

    const manifest = await buildManifestForExportResult(input)

    expectCurrentRecord(manifest, graph, intent, {
      selectiveColor: false,
      geometry: false,
    })
    expect(manifest.color_graph.descriptor).toMatchObject({
      lut_profile: {
        role: 'display-look',
        input: { gamut: 'srgb-rec709', transfer: 'srgb', range: 'full' },
        output: { gamut: 'srgb-rec709', transfer: 'srgb', range: 'full' },
      },
      steps: expect.arrayContaining([
        expect.objectContaining({
          kind: 'lut3d',
          data_sha256: sha256(LOOK_LUT.data),
        }),
      ]),
    })
    expect(manifest.lut).toEqual({
      kind: 'local-file',
      filename: 'look.cube',
      sha256: 'a'.repeat(64),
      input_contract: { gamut: 'srgb-rec709', transfer: 'srgb', range: 'full' },
      output_contract: {
        gamut: 'srgb-rec709',
        transfer: 'srgb',
        range: 'full',
        role: 'display-look',
      },
    })
  })

  it('writes an applied geometry and keeps the source frame apart from the output', async () => {
    const intent = params({ selectiveColor: SHIFTED_HSL })
    const matrix = [0.99, -0.04, 0.02, 0.04, 0.99, -0.01, 0, 0, 1]
    const { graph, input } = setup({
      intent,
      identity: { geometry: { matrix, constrainCrop: true } },
    })

    const manifest = await buildManifestForExportResult({
      ...input,
      sourceDimensions: { width: 4032, height: 3024 },
    })

    expectCurrentRecord(manifest, graph, intent, {
      selectiveColor: true,
      geometry: true,
    })
    expect(manifest.render_params.geometry).toEqual({
      matrix,
      constrain_crop: true,
      output: { width: 4, height: 2 },
    })
    // A geometried export delivers a smaller frame than the RAW it came from;
    // recording the output as the source's decoded size would describe a file
    // that never existed.
    expect(manifest.source_raw.decoded_dimensions).toEqual({
      width: 4032,
      height: 3024,
    })
    expect(manifest.output.dimensions).toEqual({ width: 4, height: 2 })
  })
})

describe('sealExportResultManifest', () => {
  function sealingResult(): ExportResult {
    return { ...setup().input.result, manifestState: { status: 'sealing' } }
  }

  it('attaches a sealed manifest and keeps the result and its identity', async () => {
    const { input } = setup()
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
