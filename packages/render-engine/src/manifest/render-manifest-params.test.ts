// @vitest-environment node
import { describe, expect, it } from 'vitest'

import {
  canonicalizeJson,
  sealRenderManifest,
  verifyManifestSha256,
} from './canonicalize'
import type { RenderManifest } from './render-manifest'

function buildManifest(): Omit<RenderManifest, 'manifest_sha256'> {
  return {
    manifest_version: 1,
    kind: 'candidate',
    produced_at: '2026-09-05T00:00:00Z',
    parent_manifest_sha256: null,
    source_raw: {
      sha256: '0'.repeat(64),
      byte_size: 1024,
      filename: 'x.raw',
      decoded_dimensions: { width: 1, height: 1 },
    },
    calibration: null,
    lut: null,
    color_graph: { fingerprint: '0'.repeat(64), descriptor: {} },
    render_params: {
      exposure_ev: 0.5,
      tone_curve: {
        contrast: 10,
        highlights: -5,
        shadows: 5,
        whites: 0,
        blacks: 0,
      },
      color_balance: { temperature: 20, tint: -3 },
      saturation: { saturation: 15, vibrance: 30 },
      intensity: 1,
      raw_render_exposure_ev: -0.2177,
      raw_render_exposure_source: 'dng-baseline',
    },
    output: {
      format: 'jpeg',
      dimensions: { width: 1, height: 1 },
      color_space: 'srgb',
      quality: 85,
      filename: 'out.jpg',
      sha256: '0'.repeat(64),
    },
    policy: {
      kind: 'candidate',
      row_slice: 32,
      concurrency: 1,
      max_pixels: 300_000,
    },
    environment: {
      render_engine: '0.1.0',
      luma_color_runtime: '0.1.0',
      luma_raw_runtime: '0.1.0',
      luma_jpeg_runtime: '0.1.0',
      native_artifacts: { build_id: 'test', variant: 'desktop' },
    },
  }
}

describe('renderParams additive fields (lmfg)', () => {
  it('seals and verifies manifests carrying temperature, saturation, and raw exposure', () => {
    const manifest = sealRenderManifest(buildManifest())
    expect(verifyManifestSha256(manifest)).toBe(true)
    expect(canonicalizeJson(manifest.render_params)).toContain(
      '"raw_render_exposure_source":"dng-baseline"',
    )
    expect(canonicalizeJson(manifest.render_params)).toContain(
      '"saturation":{"saturation":15',
    )
  })
})
