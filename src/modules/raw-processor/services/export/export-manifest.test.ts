import { createHash } from 'node:crypto'

import type {
  ColorGraphIntent,
  LUTData,
  SupportedExportColorGraphDescriptor,
} from '@lumaforge/luma-color-runtime'
import {
  NEUTRAL_SELECTIVE_COLOR,
  parseCubeLUT,
  resolveExportColorGraph,
  toLUTData,
} from '@lumaforge/luma-color-runtime'
import type {
  GeometryParams,
  RenderManifest,
} from '@lumaforge/render-engine/manifest'
import {
  canonicalizeJson,
  invertManifestRenderParams,
  parseRenderManifest,
  projectManifestRenderParams,
} from '@lumaforge/render-engine/manifest'
import { describe, expect, it } from 'vitest'

import type { StyleAsset } from '../../model/session'
import {
  buildFullResExportManifest,
  lutIdentityForStyle,
  resolveExportEnvironment,
  toManifestRenderParams,
} from './export-manifest'

const exposure = {
  ev: -0.2,
  multiplier: 2 ** -0.2,
  source: 'dng-baseline' as const,
}

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

describe('toManifestRenderParams', () => {
  it('records the intent through the engine projection, geometry included', () => {
    const geometry: GeometryParams = {
      matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      constrain_crop: true,
      output: { width: 4000, height: 3000 },
    }
    const input = params({ styleKind: 'custom', intensity: 0.37 })

    expect(toManifestRenderParams(input, exposure)).toEqual(
      projectManifestRenderParams({
        userColor: input,
        intensity: 0.37,
        rawRenderExposure: exposure,
      }),
    )
    expect(toManifestRenderParams(input, exposure, geometry)).toEqual(
      projectManifestRenderParams({
        userColor: input,
        intensity: 0.37,
        rawRenderExposure: exposure,
        geometry,
      }),
    )
  })
})

const confirmedStyle: StyleAsset = {
  kind: 'custom',
  name: 'Look',
  defaultIntensity: 0.7,
  currentIntensity: 0.7,
  lutAsset: {
    format: 'cube',
    dimension: 33,
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

describe('lutIdentityForStyle', () => {
  it('builds a local-file identity from a confirmed contract', () => {
    expect(lutIdentityForStyle(confirmedStyle).identity).toEqual({
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

  it('returns null with a reason when the hash or contract is missing', () => {
    expect(lutIdentityForStyle(null)).toEqual({ identity: null })
    expect(
      lutIdentityForStyle({
        ...confirmedStyle,
        lutAsset: { ...confirmedStyle.lutAsset!, sha256: undefined },
      }).reason,
    ).toBe('lut-unhashed')
    expect(
      lutIdentityForStyle({
        ...confirmedStyle,
        lutAsset: {
          ...confirmedStyle.lutAsset!,
          profileResolution: { kind: 'unknown' },
        },
      }).reason,
    ).toBe('lut-unconfirmed')
  })
})

describe('buildFullResExportManifest current record', () => {
  // Every expectation here is derived from the inputs, node:crypto and the
  // canonical JSON rules, never from the engine's own descriptor or
  // projection helpers, so the browser record is checked against what a
  // strict reader requires rather than against itself.
  const PRODUCED_AT = new Date('2026-09-05T00:00:00Z')
  const LOOK_LUT: LUTData = {
    ...toLUTData(
      parseCubeLUT(
        `TITLE "Look"\nLUT_3D_SIZE 2\n${'0 0 0\n0.5 0.25 1\n'.repeat(4)}`,
      ),
    ),
    profileResolution: confirmedStyle.lutAsset!.profileResolution!,
  }
  const SHIFTED_HSL = {
    ...NEUTRAL_SELECTIVE_COLOR,
    red: { hue: 10, saturation: 0, lightness: 0 },
    blue: { hue: 0, saturation: -30, lightness: 5 },
  }
  const GEOMETRY: GeometryParams = {
    matrix: [0.99, -0.04, 0.02, 0.04, 0.99, -0.01, 0, 0, 1],
    constrain_crop: true,
    output: { width: 4, height: 2 },
  }

  function sha256Text(text: string): string {
    return createHash('sha256').update(text).digest('hex')
  }

  function sha256Floats(data: Float32Array): string {
    return createHash('sha256')
      .update(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
      .digest('hex')
  }

  function build(
    intent: ColorGraphIntent,
    options: { lut?: LUTData; geometry?: GeometryParams } = {},
  ): { graph: SupportedExportColorGraphDescriptor; manifest: RenderManifest } {
    const graph = resolveExportColorGraph({
      ...intent,
      lut: options.lut ?? null,
      rawRenderExposure: exposure,
    })
    if (!graph.supported) throw new Error(graph.message)
    const manifest = buildFullResExportManifest({
      graph,
      params: intent,
      rawRenderExposure: exposure,
      ...(options.geometry ? { geometry: options.geometry } : {}),
      source: {
        sha256: 'b'.repeat(64),
        byte_size: 10,
        filename: 'x.arw',
        decoded_dimensions: { width: 4, height: 2 },
      },
      lut: options.lut
        ? lutIdentityForStyle({
            ...confirmedStyle,
            currentIntensity: intent.intensity,
          }).identity
        : null,
      output: {
        sha256: 'c'.repeat(64),
        width: 4,
        height: 2,
        quality: 0.92,
        filename: 'x_fullres.jpg',
      },
      policy: { kind: 'export-full', row_slice: 512, concurrency: 2 },
      environment: resolveExportEnvironment('desktop'),
      producedAt: PRODUCED_AT,
    })
    return { graph, manifest }
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
        data_sha256: sha256Floats(step.data),
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
    expect(seal).toBe(sha256Text(canonicalizeJson(unsealed)))

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
      sha256Text(canonicalizeJson(colorGraph.descriptor)),
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
      raw_render_exposure_ev: exposure.ev,
      raw_render_exposure_source: exposure.source,
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

    // Reading it back needs no reader default for strength or exposure.
    const read = invertManifestRenderParams(renderParams)
    expect(read.intensity).toBe(intent.intensity)
    expect(read.rawRenderExposure).toEqual({
      ev: exposure.ev,
      source: exposure.source,
    })
    expect(manifest.calibration).toBeNull()
  }

  it('writes a neutral record with HSL omitted', () => {
    const intent = params({
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
    })
    const { graph, manifest } = build(intent)

    expectCurrentRecord(manifest, graph, intent, {
      selectiveColor: false,
      geometry: false,
    })
    expect(manifest.color_graph.descriptor).toMatchObject({
      lut_profile: null,
    })
  })

  it('writes an edited record with every section complete', () => {
    const intent = params({ selectiveColor: SHIFTED_HSL })
    const { graph, manifest } = build(intent)

    expectCurrentRecord(manifest, graph, intent, {
      selectiveColor: true,
      geometry: false,
    })
  })

  it('writes a LUT record with its contract and table digest', () => {
    const intent = params({ styleKind: 'custom', intensity: 0.37 })
    const { graph, manifest } = build(intent, { lut: LOOK_LUT })

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
    })
    expect(manifest.color_graph.descriptor).toMatchObject({
      steps: expect.arrayContaining([
        expect.objectContaining({
          kind: 'lut3d',
          data_sha256: sha256Floats(LOOK_LUT.data),
        }),
      ]),
    })
    expect(manifest.lut).toMatchObject({ kind: 'local-file' })
  })

  it('writes an applied geometry next to the complete sections', () => {
    const intent = params({ selectiveColor: SHIFTED_HSL })
    const { graph, manifest } = build(intent, { geometry: GEOMETRY })

    expectCurrentRecord(manifest, graph, intent, {
      selectiveColor: true,
      geometry: true,
    })
    expect(manifest.render_params.geometry).toEqual(GEOMETRY)
  })
})
