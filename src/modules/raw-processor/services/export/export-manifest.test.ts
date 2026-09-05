import { createHash } from 'node:crypto'

import type { ProcessingParams } from '@lumaforge/luma-color-runtime'
import { resolveExportColorGraph } from '@lumaforge/luma-color-runtime'
import { verifyManifestSha256 } from '@lumaforge/render-engine/manifest'
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

describe('lutIdentityForStyle', () => {
  const confirmedStyle: StyleAsset = {
    kind: 'custom',
    name: 'Look',
    defaultIntensityLevel: 'standard',
    currentIntensityLevel: 'standard',
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
