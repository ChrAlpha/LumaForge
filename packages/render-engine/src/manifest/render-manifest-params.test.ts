// @vitest-environment node
import { resolveExportColorGraph } from '@lumaforge/luma-color-runtime'
import { describe, expect, it } from 'vitest'

import {
  canonicalizeJson,
  sealRenderManifest,
  verifyManifestSha256,
} from './canonicalize'
import { colorGraphIdentity } from './color-graph-descriptor'
import { parseRenderManifest } from './parse-render-manifest'
import type { RenderManifest } from './render-manifest'
import { projectManifestRenderParams } from './render-params'

const userColor = {
  userExposureEv: 0.5,
  userContrast: 10,
  userHighlights: -5,
  userShadows: 5,
  userTemperature: 20,
  userTint: -3,
  userSaturation: 15,
  userVibrance: 30,
}

// The candidate graph for the user color the params below record.
const resolved = resolveExportColorGraph({
  styleKind: 'none',
  intensity: 1,
  builtinPreset: null,
  lut: null,
  ...userColor,
  rawRenderExposure: {
    ev: -0.2177,
    multiplier: 2 ** -0.2177,
    source: 'dng-baseline',
  },
})
if (!resolved.supported) throw new Error(resolved.message)
const graph = resolved

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
    color_graph: colorGraphIdentity(graph),
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

describe('current render params in a candidate manifest', () => {
  it('seals and verifies manifests carrying temperature, saturation, and raw exposure', () => {
    const manifest = sealRenderManifest(buildManifest())
    expect(verifyManifestSha256(manifest)).toBe(true)
    expect(manifest.render_params).toEqual(
      projectManifestRenderParams({
        userColor,
        intensity: 1,
        rawRenderExposure: { ev: -0.2177, source: 'dng-baseline' },
      }),
    )
    expect(canonicalizeJson(manifest.render_params)).toBe(
      '{"color_balance":{"temperature":20,"tint":-3},"exposure_ev":0.5,' +
        '"intensity":1,"raw_render_exposure_ev":-0.2177,' +
        '"raw_render_exposure_source":"dng-baseline",' +
        '"saturation":{"saturation":15,"vibrance":30},' +
        '"tone_curve":{"blacks":0,"contrast":10,"highlights":-5,"shadows":5,"whites":0}}',
    )
  })

  it('passes the canonical reader with its decode budget recorded', () => {
    const manifest = JSON.parse(
      JSON.stringify(sealRenderManifest(buildManifest())),
    ) as unknown
    expect(parseRenderManifest(manifest)).toEqual({ ok: true, manifest })
  })

  it('keeps the hash of the current candidate shape', () => {
    expect(sealRenderManifest(buildManifest()).manifest_sha256).toBe(
      '79017a168c2e76f356a70eb5b9207946120fec1d02f03aedc3eeb636e6a023e0',
    )
  })
})
