import { createHash } from 'node:crypto'

import type { ProcessingParams } from '@lumaforge/luma-color-runtime'
import { resolveExportColorGraph } from '@lumaforge/luma-color-runtime'
import {
  canonicalizeJson,
  verifyManifestSha256,
} from '@lumaforge/render-engine/manifest'
import { describe, expect, it } from 'vitest'

import type { StyleAsset } from '../../model/session'
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

function params(overrides: Partial<ProcessingParams> = {}): ProcessingParams {
  return {
    intensity: 1,
    viewMode: 'processed',
    compareSplit: 0.5,
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
    ...overrides,
  }
}

describe('toManifestRenderParams', () => {
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

  it('records a continuous look strength exactly', () => {
    // Strength is set in whole percents; the manifest keeps the amount the
    // preview and export used rather than a snapped preset.
    expect(
      toManifestRenderParams(params({ intensity: 0.62 }), exposure).intensity,
    ).toBe(0.62)
  })

  it('records selective color only when a band is shifted', () => {
    const shifted = toManifestRenderParams(
      params({
        selectiveColor: {
          red: { hue: 10, saturation: 0, lightness: 0 },
        } as ProcessingParams['selectiveColor'],
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
    overrides: Partial<ProcessingParams> = {},
  ): ProcessingParams {
    return {
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

  it('freezes absent selective color as an omitted key', () => {
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
})

describe('lutIdentityForStyle', () => {
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
})
