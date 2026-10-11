import { createHash } from 'node:crypto'

import type {
  ColorGraphIntent,
  LUTData,
  SupportedExportColorGraphDescriptor,
} from '@lumaforge/luma-color-runtime'
import {
  NEUTRAL_SELECTIVE_COLOR,
  normalizeUserColorIntent,
  parseCubeLUT,
  resolveExportColorGraph,
  toLUTData,
  USER_COLOR_SCALAR_KEYS,
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
  sealRenderManifest,
  verifyManifestSha256,
} from '@lumaforge/render-engine/manifest'
import { describe, expect, expectTypeOf, it } from 'vitest'

import type { StyleAsset } from '../../model/session'
import type { BuildFullResExportManifestInput } from './export-manifest'
import {
  buildFullResExportManifest,
  lutIdentityForStyle,
  resolveExportEnvironment,
  sha256OfBlob,
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
  it('projects the complete color intent', () => {
    expectTypeOf(toManifestRenderParams)
      .parameter(0)
      .toEqualTypeOf<ColorGraphIntent>()
    expectTypeOf<
      BuildFullResExportManifestInput['params']
    >().toEqualTypeOf<ColorGraphIntent>()
  })

  it('projects processing params onto the manifest shape', () => {
    expect(toManifestRenderParams(params(), exposure)).toEqual({
      exposure_ev: 0.3,
      tone_curve: {
        contrast: 12,
        highlights: -5,
        shadows: 4,
        whites: 0,
        blacks: 1,
      },
      color_balance: { temperature: 8, tint: -2 },
      saturation: { saturation: 3, vibrance: 6 },
      intensity: 1,
      raw_render_exposure_ev: -0.2,
      raw_render_exposure_source: 'dng-baseline',
    })
  })

  it.each([0, 0.37, 0.62, 0.7, 1])(
    'records a continuous look strength of %s exactly',
    (intensity) => {
      // Strength is set in whole percents; the manifest keeps the amount the
      // preview and export used rather than a snapped preset.
      expect(
        toManifestRenderParams(params({ intensity }), exposure).intensity,
      ).toBe(intensity)
    },
  )

  it('records selective color only when a band is shifted', () => {
    const shifted = toManifestRenderParams(
      params({
        selectiveColor: {
          red: { hue: 10, saturation: 0, lightness: 0 },
        } as ColorGraphIntent['selectiveColor'],
      }),
      exposure,
    )
    expect(shifted.selective_color?.red).toEqual({
      hue: 10,
      saturation: 0,
      lightness: 0,
    })
    expect(Object.keys(shifted.selective_color ?? {})).toHaveLength(8)
  })
})

describe('toManifestRenderParams shared projection', () => {
  const shiftedSelectiveColor = {
    red: { hue: 10, saturation: 0, lightness: 0 },
    blue: { saturation: -30, lightness: 5 },
  } as ColorGraphIntent['selectiveColor']
  const geometry: GeometryParams = {
    matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    constrain_crop: true,
    output: { width: 4000, height: 3000 },
  }

  it.each([
    ['edited scalars', params()],
    ['a non-detent strength', params({ styleKind: 'custom', intensity: 0.37 })],
    ['a zero strength', params({ styleKind: 'custom', intensity: 0 })],
    [
      'shifted selective color',
      params({ selectiveColor: shiftedSelectiveColor }),
    ],
    [
      'a built-in look',
      params({ styleKind: 'builtin', builtinPreset: 'warm' }),
    ],
  ])('writes the shared projection for %s', (_label, input) => {
    const expected = projectManifestRenderParams({
      userColor: input,
      intensity: input.intensity,
      rawRenderExposure: exposure,
    })

    expect(canonicalizeJson(toManifestRenderParams(input, exposure))).toBe(
      canonicalizeJson(expected),
    )
  })

  it('keeps the applied geometry next to the projected intent', () => {
    expect(toManifestRenderParams(params(), exposure, geometry)).toEqual(
      projectManifestRenderParams({
        userColor: params(),
        intensity: 1,
        rawRenderExposure: exposure,
        geometry,
      }),
    )
  })

  it.each(USER_COLOR_SCALAR_KEYS)('records a change of %s alone', (key) => {
    const base = toManifestRenderParams(params(), exposure)
    const changed = toManifestRenderParams(
      params({ [key]: params()[key] + 1 }),
      exposure,
    )

    expect(canonicalizeJson(changed)).not.toBe(canonicalizeJson(base))
  })

  it('reads back as the user color, exact strength and recorded exposure', () => {
    const input = params({
      styleKind: 'custom',
      intensity: 0.37,
      selectiveColor: shiftedSelectiveColor,
    })

    expect(
      invertManifestRenderParams(toManifestRenderParams(input, exposure)),
    ).toEqual({
      userColor: normalizeUserColorIntent(input),
      intensity: 0.37,
      rawRenderExposure: { ev: exposure.ev, source: exposure.source },
      geometry: null,
    })
  })

  it('records out-of-range user fields the way the color graph reads them', () => {
    const input = params({ userContrast: 500, userTint: Number.NaN })
    const graph = resolveExportColorGraph({ ...input, lut: null })
    if (!graph.supported) throw new Error('Expected a supported graph.')
    const contrast = graph.steps.find((step) => step.kind === 'user-contrast')
    const balance = graph.steps.find(
      (step) => step.kind === 'user-color-balance',
    )

    const renderParams = toManifestRenderParams(input, exposure)

    expect(renderParams.tone_curve?.contrast).toBe(
      contrast?.kind === 'user-contrast' ? contrast.amount : undefined,
    )
    expect(renderParams.color_balance?.tint).toBe(
      balance?.kind === 'user-color-balance' ? balance.tint : undefined,
    )
  })
})

describe('toManifestRenderParams canonical bytes', () => {
  // Reviewed literal canonical JSON. The CLI writer keeps its own goldens for
  // the same inputs; the two must only differ where noted below.
  const NON_NEUTRAL_SCALARS_GOLDEN =
    '{"color_balance":{"temperature":10,"tint":-4},"exposure_ev":0.5,' +
    '"intensity":0.75,"raw_render_exposure_ev":-0.25,' +
    '"raw_render_exposure_source":"dng-baseline",' +
    '"saturation":{"saturation":7,"vibrance":18},' +
    '"tone_curve":{"blacks":6,"contrast":12,"highlights":-20,"shadows":15,"whites":-8}}'
  const NEUTRAL_GOLDEN =
    '{"color_balance":{"temperature":0,"tint":0},"exposure_ev":0,' +
    '"intensity":1,"raw_render_exposure_ev":0,' +
    '"raw_render_exposure_source":"identity",' +
    '"saturation":{"saturation":0,"vibrance":0},' +
    '"tone_curve":{"blacks":0,"contrast":0,"highlights":0,"shadows":0,"whites":0}}'
  const SHIFTED_HSL_GOLDEN =
    '{"color_balance":{"temperature":0,"tint":0},"exposure_ev":0,' +
    '"intensity":1,"raw_render_exposure_ev":0,' +
    '"raw_render_exposure_source":"identity",' +
    '"saturation":{"saturation":0,"vibrance":0},' +
    '"selective_color":{' +
    '"aqua":{"hue":0,"lightness":0,"saturation":0},' +
    '"blue":{"hue":0,"lightness":5,"saturation":-30},' +
    '"green":{"hue":0,"lightness":0,"saturation":0},' +
    '"magenta":{"hue":0,"lightness":0,"saturation":0},' +
    '"orange":{"hue":0,"lightness":0,"saturation":0},' +
    '"purple":{"hue":0,"lightness":0,"saturation":0},' +
    '"red":{"hue":10,"lightness":0,"saturation":0},' +
    '"yellow":{"hue":0,"lightness":0,"saturation":0}},' +
    '"tone_curve":{"blacks":0,"contrast":0,"highlights":0,"shadows":0,"whites":0}}'
  const NON_DETENT_STRENGTH_GOLDEN =
    '{"color_balance":{"temperature":0,"tint":0},"exposure_ev":0,' +
    '"intensity":0.37,"raw_render_exposure_ev":0,' +
    '"raw_render_exposure_source":"identity",' +
    '"saturation":{"saturation":0,"vibrance":0},' +
    '"tone_curve":{"blacks":0,"contrast":0,"highlights":0,"shadows":0,"whites":0}}'

  const dngExposure = {
    ev: -0.25,
    multiplier: 2 ** -0.25,
    source: 'dng-baseline' as const,
  }
  const identityExposure = { ev: 0, multiplier: 1, source: 'identity' as const }
  const neutralBand = { hue: 0, saturation: 0, lightness: 0 }
  const neutralSelectiveColor = {
    red: neutralBand,
    orange: neutralBand,
    yellow: neutralBand,
    green: neutralBand,
    aqua: neutralBand,
    blue: neutralBand,
    purple: neutralBand,
    magenta: neutralBand,
  }

  function neutralParams(
    overrides: Partial<ColorGraphIntent> = {},
  ): ColorGraphIntent {
    return {
      intensity: 1,
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
      selectiveColor: NEUTRAL_SELECTIVE_COLOR,
      ...overrides,
    }
  }

  it('freezes non-neutral scalars', () => {
    const renderParams = toManifestRenderParams(
      neutralParams({
        intensity: 0.75,
        userExposureEv: 0.5,
        userContrast: 12,
        userHighlights: -20,
        userShadows: 15,
        userWhites: -8,
        userBlacks: 6,
        userTemperature: 10,
        userTint: -4,
        userSaturation: 7,
        userVibrance: 18,
      }),
      dngExposure,
    )

    expect(canonicalizeJson(renderParams)).toBe(NON_NEUTRAL_SCALARS_GOLDEN)
  })

  it('freezes shifted selective color as all eight bands', () => {
    const renderParams = toManifestRenderParams(
      neutralParams({
        selectiveColor: {
          ...neutralSelectiveColor,
          red: { hue: 10, saturation: 0, lightness: 0 },
          blue: { hue: 0, saturation: -30, lightness: 5 },
        },
      }),
      identityExposure,
    )

    expect(canonicalizeJson(renderParams)).toBe(SHIFTED_HSL_GOLDEN)
  })

  it('freezes the neutral selective color as an omitted key', () => {
    const renderParams = toManifestRenderParams(
      neutralParams(),
      identityExposure,
    )

    expect(canonicalizeJson(renderParams)).toBe(NEUTRAL_GOLDEN)
  })

  it('omits an explicit all-neutral selective color record', () => {
    // The CLI writer records this input as eight neutral bands; the browser
    // writer drops it, so the two manifests hash differently today.
    const renderParams = toManifestRenderParams(
      neutralParams({ selectiveColor: neutralSelectiveColor }),
      identityExposure,
    )

    expect(canonicalizeJson(renderParams)).toBe(NEUTRAL_GOLDEN)
  })

  it.each([
    ['a partial record of neutral bands', { blue: neutralBand }],
    ['bands missing their scalars', { red: { hue: 0 }, aqua: {} }],
    [
      'negative zero shifts',
      { red: { hue: -0, saturation: -0, lightness: 0 } },
    ],
    [
      'non-finite shifts',
      { green: { hue: Number.NaN, saturation: Infinity, lightness: 0 } },
    ],
  ])('omits selective color written as %s', (_label, selectiveColor) => {
    const renderParams = toManifestRenderParams(
      neutralParams({
        selectiveColor: selectiveColor as ColorGraphIntent['selectiveColor'],
      }),
      identityExposure,
    )

    expect(canonicalizeJson(renderParams)).toBe(NEUTRAL_GOLDEN)
  })

  it('freezes a partial shifted record as all eight normalized bands', () => {
    const renderParams = toManifestRenderParams(
      neutralParams({
        selectiveColor: {
          red: { hue: 10 },
          blue: { saturation: -30, lightness: 5 },
        } as ColorGraphIntent['selectiveColor'],
      }),
      identityExposure,
    )

    expect(canonicalizeJson(renderParams)).toBe(SHIFTED_HSL_GOLDEN)
  })

  it('freezes a non-detent look strength unrounded', () => {
    // 0.37 sits between the Light (0.4) and Standard (0.7) detents.
    const renderParams = toManifestRenderParams(
      neutralParams({ styleKind: 'custom', intensity: 0.37 }),
      identityExposure,
    )

    expect(canonicalizeJson(renderParams)).toBe(NON_DETENT_STRENGTH_GOLDEN)
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

describe('sha256OfBlob', () => {
  it('matches node crypto for the same bytes', async () => {
    const bytes = new Uint8Array(70_000).map((_, i) => i % 251)
    const expected = createHash('sha256').update(bytes).digest('hex')
    expect(await sha256OfBlob(new Blob([bytes]))).toBe(expected)
  })
})

describe('buildFullResExportManifest', () => {
  it('seals a verifiable export manifest with build-time environment', () => {
    const graph = resolveExportColorGraph({
      styleKind: 'none',
      intensity: 1,
      builtinPreset: null,
      lut: null,
      rawRenderExposure: exposure,
      userExposureEv: 0.3,
      selectiveColor: NEUTRAL_SELECTIVE_COLOR,
    })
    if (!graph.supported) throw new Error(graph.message)
    const manifest = buildFullResExportManifest({
      graph,
      params: params(),
      rawRenderExposure: exposure,
      source: {
        sha256: 'b'.repeat(64),
        byte_size: 10,
        filename: 'x.arw',
        decoded_dimensions: { width: 4, height: 2 },
      },
      lut: null,
      output: {
        sha256: 'c'.repeat(64),
        width: 4,
        height: 2,
        quality: 0.92,
        filename: 'x_neutral_fullres.jpg',
      },
      policy: { kind: 'export-full', row_slice: 512, concurrency: 2 },
      environment: resolveExportEnvironment('desktop'),
      producedAt: new Date('2026-09-05T00:00:00Z'),
    })
    expect(verifyManifestSha256(manifest)).toBe(true)
    expect(manifest.kind).toBe('export')
    expect(manifest.output.quality).toBe(92)
    expect(manifest.environment.native_artifacts.variant).toBe('desktop')
    expect(manifest.environment.render_engine).toMatch(/^\d+\.\d+\.\d+|unknown/)
    expect(manifest.render_params.exposure_ev).toBe(0.3)
  })

  it('records a null calibration slot and the exact look strength', () => {
    const graph = resolveExportColorGraph({
      styleKind: 'none',
      intensity: 0.37,
      builtinPreset: null,
      lut: null,
      rawRenderExposure: exposure,
      selectiveColor: NEUTRAL_SELECTIVE_COLOR,
    })
    if (!graph.supported) throw new Error(graph.message)
    const manifest = buildFullResExportManifest({
      graph,
      params: params({ intensity: 0.37 }),
      rawRenderExposure: exposure,
      source: {
        sha256: 'b'.repeat(64),
        byte_size: 10,
        filename: 'x.arw',
        decoded_dimensions: { width: 4, height: 2 },
      },
      lut: lutIdentityForStyle({ ...confirmedStyle, currentIntensity: 0.37 })
        .identity,
      output: {
        sha256: 'c'.repeat(64),
        width: 4,
        height: 2,
        quality: 0.92,
        filename: 'x_look_fullres.jpg',
      },
      policy: { kind: 'export-full', row_slice: 512, concurrency: 2 },
      environment: resolveExportEnvironment('low-memory'),
      producedAt: new Date('2026-09-05T00:00:00Z'),
    })

    // The browser writer has no camera-calibration step: the slot stays in
    // the hashed manifest as an explicit null, even next to a LUT identity.
    expect(manifest.lut?.kind).toBe('local-file')
    expect(manifest).toHaveProperty('calibration', null)
    expect(canonicalizeJson(manifest)).toContain('"calibration":null')
    expect(manifest.render_params.intensity).toBe(0.37)
    expect(verifyManifestSha256(manifest)).toBe(true)
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

  describe('malformed records', () => {
    /** A current browser record read back from JSON, open to edits. */
    type JsonRecord = Record<string, any>

    function current(): JsonRecord {
      const { manifest } = build(params({ selectiveColor: SHIFTED_HSL }), {
        geometry: GEOMETRY,
      })
      return JSON.parse(JSON.stringify(manifest)) as JsonRecord
    }

    function resealed(edit: (record: JsonRecord) => void): RenderManifest {
      const record = current()
      edit(record)
      return sealRenderManifest(record as unknown as RenderManifest)
    }

    function issuePaths(value: unknown): string[] {
      const parsed = parseRenderManifest(value)
      return parsed.ok ? [] : parsed.issues.map((issue) => issue.path)
    }

    it('refuses a record edited after it was sealed', () => {
      const record = current()
      record.render_params.intensity = 0.5

      expect(issuePaths(record)).toEqual(['manifest_sha256'])
    })

    it.each([
      [
        'a string strength',
        (record: JsonRecord) => {
          record.render_params.intensity = '0.37'
        },
        'render_params.intensity',
      ],
      [
        'an unknown exposure provenance',
        (record: JsonRecord) => {
          record.render_params.raw_render_exposure_source = 'camera'
        },
        'render_params.raw_render_exposure_source',
      ],
      [
        'a null tone value',
        (record: JsonRecord) => {
          record.render_params.tone_curve.contrast = null
        },
        'render_params.tone_curve.contrast',
      ],
      [
        'an HSL band missing an axis',
        (record: JsonRecord) => {
          delete record.render_params.selective_color.red.lightness
        },
        'render_params.selective_color.red.lightness',
      ],
      [
        'a singular geometry',
        (record: JsonRecord) => {
          record.render_params.geometry.matrix = [0, 0, 0, 0, 0, 0, 0, 0, 0]
        },
        'render_params.geometry.matrix',
      ],
      [
        'a descriptor its fingerprint does not cover',
        (record: JsonRecord) => {
          record.color_graph.descriptor.steps[1].ev = 4
        },
        'color_graph.fingerprint',
      ],
    ])('refuses a sealed record with %s', (_label, edit, path) => {
      const record = resealed(edit)

      expect(verifyManifestSha256(record)).toBe(true)
      expect(issuePaths(record)).toEqual([path])
    })
  })
})
