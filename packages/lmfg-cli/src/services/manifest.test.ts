// @vitest-environment node
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ColorGraphDescriptor } from '@lumaforge/render-engine/manifest'
import {
  COLOR_GRAPH_DESCRIPTOR_VERSION,
  computeManifestSha256,
  fingerprintColorGraph,
} from '@lumaforge/render-engine/manifest'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { resolveRenderEnvironment } from '../runtime/versions'
import { parseRenderParams } from '../schemas/params'
import { buildColorGraph, requireSupportedGraph } from './color-graph'
import {
  buildRenderManifest,
  percentToQuality,
  requireVerifiedManifest,
  verifyManifestFile,
} from './manifest'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lmfg-manifest-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const environment = resolveRenderEnvironment('desktop')
const exposure = { ev: 0, multiplier: 1, source: 'identity' as const }
const source = {
  sha256: 'a'.repeat(64),
  byte_size: 10,
  filename: 'x.dng',
  decoded_dimensions: { width: 4, height: 2 },
}

function build(kind: 'preview' | 'candidate' | 'export' = 'preview') {
  const params = parseRenderParams({ contrast: 5 })
  return buildRenderManifest({
    kind,
    source,
    lut: null,
    graph: requireSupportedGraph(buildColorGraph(params, null, exposure)),
    params,
    exposure,
    policy: { kind: 'preview-quick', row_slice: 32, concurrency: 1 },
    environment,
    output: {
      width: 4,
      height: 2,
      quality: 85,
      filename: 'p.jpg',
      sha256: 'b'.repeat(64),
    },
    parentManifestSha256: null,
    producedAt: new Date('2026-09-05T00:00:00Z'),
  })
}

describe('manifest service', () => {
  it('builds a sealed manifest with a color-graph fingerprint', () => {
    const manifest = build()
    expect(manifest.manifest_version).toBe(1)
    expect(manifest.manifest_sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(manifest.color_graph.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(manifest.render_params.tone_curve?.contrast).toBe(5)
    expect(manifest.produced_at).toBe('2026-09-05T00:00:00.000Z')
  })

  it('verifies files, detects tampering, and warns on environment drift', async () => {
    const manifest = build('export')
    const file = join(dir, 'm.json')
    await writeFile(file, JSON.stringify(manifest))
    const ok = await verifyManifestFile(file, { environment })
    expect(ok.valid).toBe(true)
    expect(ok.structural_valid).toBe(true)
    expect(ok.geometry_executable).toBe(true)
    expect(ok.environment_match).toBe(true)
    const tampered = {
      ...manifest,
      render_params: { ...manifest.render_params, exposure_ev: 9 },
    }
    await writeFile(file, JSON.stringify(tampered))
    const bad = await verifyManifestFile(file, { environment })
    expect(bad.valid).toBe(false)
    expect(bad.structural_valid).toBe(false)
    expect(bad.geometry_executable).toBeNull()
    expect(bad.geometry_refusal).toBeNull()
    expect(bad.issues[0]).toMatch(/manifest_sha256/)
    await writeFile(file, JSON.stringify(manifest))
    const drift = await verifyManifestFile(file, {
      environment: { ...environment, render_engine: '9.9.9' },
    })
    expect(drift.valid).toBe(true)
    expect(drift.environment_match).toBe(false)
    expect(drift.warnings.join(' ')).toMatch(/render_engine/)
  })

  type Json = Record<string, any>

  /** A JSON copy of a built manifest, edited and sealed again. */
  function resealed(edit: (manifest: Json) => void): Json {
    const copy = JSON.parse(JSON.stringify(build('export'))) as Json
    edit(copy)
    copy.manifest_sha256 = computeManifestSha256(copy)
    return copy
  }

  async function verify(manifest: unknown) {
    const file = join(dir, 'm.json')
    await writeFile(file, JSON.stringify(manifest))
    return verifyManifestFile(file, { environment })
  }

  /** Every `render_params` field a current writer records for a render without HSL or geometry. */
  const CURRENT_RENDER_PARAMS_KEYS = [
    'color_balance',
    'exposure_ev',
    'intensity',
    'raw_render_exposure_ev',
    'raw_render_exposure_source',
    'saturation',
    'tone_curve',
  ]

  it.each(['preview', 'candidate', 'export'] as const)(
    'accepts the complete %s record the current writer seals',
    async (kind) => {
      const manifest = build(kind)
      const result = await verify(manifest)
      expect(result.issues).toEqual([])
      expect(result.valid).toBe(true)
      expect(result.structural_valid).toBe(true)
      // Only an export has a frame to check; a preview or candidate that
      // records no geometry has nothing to check.
      expect(result.geometry_executable).toBe(kind === 'export' ? true : null)
      expect(result.geometry_refusal).toBeNull()
      expect(result.manifest?.manifest_sha256).toBe(manifest.manifest_sha256)
      const descriptor = manifest.color_graph.descriptor as ColorGraphDescriptor
      expect(descriptor.descriptor_version).toBe(COLOR_GRAPH_DESCRIPTOR_VERSION)
      expect(manifest.color_graph.fingerprint).toBe(
        fingerprintColorGraph(descriptor),
      )
      expect(Object.keys(manifest.render_params).sort()).toEqual(
        CURRENT_RENDER_PARAMS_KEYS,
      )
      expect(manifest.render_params).toMatchObject({
        intensity: 1,
        raw_render_exposure_ev: 0,
        raw_render_exposure_source: 'identity',
      })
      expect(manifest.calibration).toBeNull()
    },
  )

  it('refuses a correctly resealed manifest with a malformed field, by path', async () => {
    const manifest = resealed((m) => (m.render_params.exposure_ev = '0.5'))
    const result = await verify(manifest)
    expect(result.valid).toBe(false)
    expect(result.structural_valid).toBe(false)
    expect(result.geometry_executable).toBeNull()
    expect(result.geometry_refusal).toBeNull()
    expect(result.manifest).toBeNull()
    expect(result.issues).toContainEqual(
      expect.stringMatching(/^render_params\.exposure_ev: /),
    )
    await expect(
      requireVerifiedManifest(join(dir, 'm.json'), environment),
    ).rejects.toMatchObject({
      code: 'manifest.invalid',
      exitCode: 1,
      details: { issues: result.issues },
    })
  })

  /** A keystone whose horizon crosses the frame at x = 0.5: w = 1 - 2x. */
  const FOLDING = [1, 0, 0, 0, 1, 0, -2, 0, 1]

  it.each<[string, (manifest: Json) => void, Json, string]>([
    [
      'a geometry that folds the frame',
      (m) =>
        (m.render_params.geometry = {
          matrix: FOLDING,
          constrain_crop: false,
          output: { width: 4, height: 2 },
        }),
      {
        reason: 'unplannable-geometry',
        source: { width: 4, height: 2 },
        cause: expect.any(String),
      },
      'render_params.geometry',
    ],
    [
      'an output that is not the source frame',
      (m) => (m.output.dimensions = { width: 2, height: 2 }),
      {
        reason: 'output-mismatch',
        delivered_by: 'source',
        recorded: { width: 2, height: 2 },
        delivered: { width: 4, height: 2 },
      },
      'output.dimensions',
    ],
  ])(
    'refuses a correctly sealed, structurally valid export with %s for its geometry',
    async (_label, edit, refusal, path) => {
      const manifest = resealed(edit)
      const result = await verify(manifest)
      expect(result.structural_valid).toBe(true)
      expect(result.manifest).toEqual(manifest)
      expect(result.geometry_executable).toBe(false)
      expect(result.geometry_refusal).toEqual(refusal)
      expect(result.valid).toBe(false)
      expect(result.issues).toEqual([
        expect.stringMatching(new RegExp(`^${path.replaceAll('.', '\\.')}: `)),
      ])
      // The structural reader still returns it: replay refuses the geometry
      // itself before any decode, with its own envelope.
      const read = await requireVerifiedManifest(
        join(dir, 'm.json'),
        environment,
      )
      expect(read.manifest).toEqual(manifest)
    },
  )

  it('converts quality between percent and unit scale', () => {
    expect(percentToQuality(85)).toBe(0.85)
  })
})
