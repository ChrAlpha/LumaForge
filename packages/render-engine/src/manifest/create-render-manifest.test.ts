// @vitest-environment node
import { resolveExportColorGraph } from '@lumaforge/luma-color-runtime'
import { describe, expect, it } from 'vitest'

import { verifyManifestSha256 } from './canonicalize'
import { createRenderManifest } from './create-render-manifest'
import { lutIdentityFromProfile } from './lut-identity'

const graph = resolveExportColorGraph({
  styleKind: 'none',
  intensity: 1,
  builtinPreset: null,
  lut: null,
  rawRenderExposure: { ev: 0.2, multiplier: 2 ** 0.2, source: 'dng-baseline' },
})
if (!graph.supported) throw new Error(graph.message)

describe('createRenderManifest', () => {
  it('seals a verifiable manifest with the color graph identity', () => {
    const manifest = createRenderManifest({
      kind: 'export',
      source_raw: {
        sha256: 'a'.repeat(64),
        byte_size: 10,
        filename: 'x.dng',
        decoded_dimensions: { width: 4, height: 2 },
      },
      lut: null,
      graph,
      render_params: { exposure_ev: 0.5, raw_render_exposure_ev: 0.2 },
      policy: { kind: 'export-full', row_slice: 512, concurrency: 1 },
      environment: {
        render_engine: '0.1.0',
        luma_color_runtime: '0.1.1',
        luma_raw_runtime: '0.1.1',
        luma_jpeg_runtime: '0.1.1',
        native_artifacts: { build_id: 'test', variant: 'desktop' },
      },
      output: {
        width: 4,
        height: 2,
        quality: 92,
        filename: 'final.jpg',
        sha256: 'b'.repeat(64),
      },
      parent_manifest_sha256: null,
      produced_at: '2026-09-05T00:00:00.000Z',
    })
    expect(verifyManifestSha256(manifest)).toBe(true)
    expect(manifest.calibration).toBeNull()
    expect(manifest.color_graph.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(manifest.output).toEqual({
      format: 'jpeg',
      dimensions: { width: 4, height: 2 },
      color_space: 'srgb',
      quality: 92,
      filename: 'final.jpg',
      sha256: 'b'.repeat(64),
    })
    expect(manifest.produced_at).toBe('2026-09-05T00:00:00.000Z')
  })
})

describe('lutIdentityFromProfile', () => {
  it('records effective contracts and marks unspecified ranges as unknown', () => {
    const result = lutIdentityFromProfile({
      filename: 'look.cube',
      sha256: 'c'.repeat(64),
      profile: {
        id: 'panasonic-vgamut-vlog',
        label: 'Panasonic V-Gamut / V-Log',
        role: 'combined-look-output',
        inputGamut: 'v-gamut',
        inputTransfer: 'v-log',
        inputRange: 'unknown',
        outputGamut: 'srgb-rec709',
        outputTransfer: 'bt709',
        outputRange: 'full',
        aliases: [],
      },
    })
    expect(result.identity).toEqual({
      kind: 'local-file',
      filename: 'look.cube',
      sha256: 'c'.repeat(64),
      input_contract: { gamut: 'v-gamut', transfer: 'v-log', range: 'unknown' },
      output_contract: {
        gamut: 'srgb-rec709',
        transfer: 'bt709',
        range: 'full',
        role: 'combined-look-output',
      },
    })
  })

  it('refuses profiles without an output transfer', () => {
    const result = lutIdentityFromProfile({
      filename: 'x.cube',
      sha256: 'd'.repeat(64),
      profile: {
        id: 'x',
        label: 'x',
        role: 'scene-creative',
        inputGamut: 'v-gamut',
        inputTransfer: 'v-log',
        inputRange: 'full',
        aliases: [],
      },
    })
    expect(result.identity).toBeNull()
  })
})
