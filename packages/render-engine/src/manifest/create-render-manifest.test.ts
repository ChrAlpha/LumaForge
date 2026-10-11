// @vitest-environment node
import {
  NEUTRAL_SELECTIVE_COLOR,
  resolveExportColorGraph,
} from '@lumaforge/luma-color-runtime'
import { describe, expect, it } from 'vitest'

import { verifyManifestSha256 } from './canonicalize'
import type { ColorGraphDescriptor } from './color-graph-descriptor'
import {
  COLOR_GRAPH_DESCRIPTOR_VERSION,
  fingerprintColorGraph,
} from './color-graph-descriptor'
import { createRenderManifest } from './create-render-manifest'
import { lutIdentityFromProfile } from './lut-identity'
import { parseRenderManifest } from './parse-render-manifest'
import { projectManifestRenderParams } from './render-params'

const userColor = { userExposureEv: 0.5, userContrast: 10, userVibrance: 12 }
const rawRenderExposure = { ev: 0.2, source: 'dng-baseline' as const }

const resolved = resolveExportColorGraph({
  styleKind: 'none',
  intensity: 1,
  builtinPreset: null,
  lut: null,
  ...userColor,
  selectiveColor: NEUTRAL_SELECTIVE_COLOR,
  rawRenderExposure: {
    ...rawRenderExposure,
    multiplier: 2 ** rawRenderExposure.ev,
  },
})
if (!resolved.supported) throw new Error(resolved.message)
const graph = resolved

function sealedExport() {
  return createRenderManifest({
    kind: 'export',
    source_raw: {
      sha256: 'a'.repeat(64),
      byte_size: 10,
      filename: 'x.dng',
      decoded_dimensions: { width: 4, height: 2 },
    },
    lut: null,
    graph,
    // The render params both writers record, through the shared projection.
    render_params: projectManifestRenderParams({
      userColor,
      intensity: 1,
      rawRenderExposure,
    }),
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
}

describe('createRenderManifest', () => {
  it('seals a verifiable manifest with the color graph identity', () => {
    const manifest = sealedExport()
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

  it('records a current descriptor that its fingerprint covers', () => {
    const { color_graph } = sealedExport()
    const descriptor = color_graph.descriptor as ColorGraphDescriptor
    expect(descriptor.descriptor_version).toBe(COLOR_GRAPH_DESCRIPTOR_VERSION)
    expect(fingerprintColorGraph(descriptor)).toBe(color_graph.fingerprint)
  })

  it('records complete color sections, the strength and the exposure provenance', () => {
    const { render_params, policy } = sealedExport()
    // Neutral HSL is omitted and no geometry was applied; every executable
    // field is written.
    expect(Object.keys(render_params).sort()).toEqual([
      'color_balance',
      'exposure_ev',
      'intensity',
      'raw_render_exposure_ev',
      'raw_render_exposure_source',
      'saturation',
      'tone_curve',
    ])
    expect(render_params.intensity).toBe(1)
    expect(render_params.raw_render_exposure_ev).toBe(0.2)
    expect(render_params.raw_render_exposure_source).toBe('dng-baseline')
    expect('max_pixels' in policy).toBe(false)
  })

  it('writes a manifest the canonical reader accepts as written', () => {
    const written = JSON.parse(JSON.stringify(sealedExport())) as unknown
    expect(parseRenderManifest(written)).toEqual({
      ok: true,
      manifest: written,
    })
  })

  it('keeps the hash of the current export shape', () => {
    expect(sealedExport().manifest_sha256).toBe(
      'ca61bc26780638da46078e4c877657723277f7900cd4a26058b74c16beb96ee3',
    )
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
