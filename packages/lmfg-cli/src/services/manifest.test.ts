// @vitest-environment node
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { computeManifestSha256 } from '@lumaforge/render-engine'
import type { ColorGraphDescriptor } from '@lumaforge/render-engine/manifest'
import {
  COLOR_GRAPH_DESCRIPTOR_VERSION,
  fingerprintColorGraph,
} from '@lumaforge/render-engine/manifest'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { resolveRenderEnvironment } from '../runtime/versions'
import { parseRenderParams } from '../schemas/params'
import { buildColorGraph, requireSupportedGraph } from './color-graph'
import {
  buildRenderManifest,
  percentToQuality,
  qualityToPercent,
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
    expect(ok.environment_match).toBe(true)
    const tampered = {
      ...manifest,
      render_params: { ...manifest.render_params, exposure_ev: 9 },
    }
    await writeFile(file, JSON.stringify(tampered))
    const bad = await verifyManifestFile(file, { environment })
    expect(bad.valid).toBe(false)
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

  // Records older writers sealed. Whether the v1 reader accepts each one is
  // the engine reader's rule; what holds either way is that the seal is
  // checked over the record exactly as written, never over a normalized copy,
  // and that a change after sealing is reported as tampering first.
  const neutralBand = { hue: 0, saturation: 0, lightness: 0 }
  const historical: Array<[string, (manifest: Json) => void]> = [
    [
      'color sections, strength and RAW exposure omitted',
      (m) => (m.render_params = { exposure_ev: 0 }),
    ],
    [
      'no RAW exposure source',
      (m) => delete m.render_params.raw_render_exposure_source,
    ],
    [
      'all eight neutral HSL bands recorded',
      (m) =>
        (m.render_params.selective_color = Object.fromEntries(
          [
            'red',
            'orange',
            'yellow',
            'green',
            'aqua',
            'blue',
            'purple',
            'magenta',
          ].map((band) => [band, neutralBand]),
        )),
    ],
    [
      'an older descriptor version',
      (m) =>
        (m.color_graph = {
          fingerprint: 'f'.repeat(64),
          descriptor: { descriptor_version: 1 },
        }),
    ],
    [
      'an unversioned descriptor',
      (m) => (m.color_graph = { fingerprint: 'd'.repeat(64), descriptor: {} }),
    ],
  ]

  it.each(historical)(
    'checks the seal of a historical record with %s as written',
    async (_label, edit) => {
      const record = resealed(edit)
      const result = await verify(record)
      expect(result.raw).toEqual(record)
      expect(result.issues.join(' ')).not.toMatch(/manifest_sha256/)
      expect(
        result.manifest === null ||
          result.manifest.manifest_sha256 === record.manifest_sha256,
      ).toBe(true)
    },
  )

  it.each(historical)(
    'refuses a historical record with %s changed after sealing for its hash first',
    async (_label, edit) => {
      const record = resealed(edit)
      record.render_params.exposure_ev = 9
      const result = await verify(record)
      expect(result.valid).toBe(false)
      expect(result.manifest).toBeNull()
      expect(result.issues[0]).toMatch(/^manifest_sha256: .*tampered/)
    },
  )

  it('keeps opaque extension fields the hash covers', async () => {
    const result = await verify(
      resealed((manifest) => {
        manifest.x_writer = { name: 'future' }
        manifest.render_params.x_note = 'kept'
      }),
    )
    expect(result.valid).toBe(true)
    expect((result.manifest as unknown as Json).x_writer).toEqual({
      name: 'future',
    })
  })

  it('refuses an extension field added after sealing', async () => {
    const manifest = JSON.parse(JSON.stringify(build('export'))) as Json
    manifest.render_params.x_note = 'added later'
    const result = await verify(manifest)
    expect(result.valid).toBe(false)
    expect(result.manifest).toBeNull()
    expect(result.issues).toEqual([
      expect.stringMatching(/^manifest_sha256: .*tampered/),
    ])
  })

  it.each<[string, (manifest: Json) => void, string]>([
    [
      'a string exposure',
      (m) => (m.render_params.exposure_ev = '0.5'),
      'render_params.exposure_ev',
    ],
    [
      'a string tone section',
      (m) => (m.render_params.tone_curve = 'flat'),
      'render_params.tone_curve',
    ],
    [
      'an incomplete HSL band',
      (m) =>
        (m.render_params.selective_color = {
          red: { hue: 10, saturation: 0 },
        }),
      'render_params.selective_color.red.lightness',
    ],
    [
      'a singular geometry',
      (m) =>
        (m.render_params.geometry = {
          matrix: [0, 0, 0, 0, 0, 0, 0, 0, 1],
          constrain_crop: false,
          output: { width: 4, height: 2 },
        }),
      'render_params.geometry.matrix',
    ],
    [
      'a string geometry output',
      (m) =>
        (m.render_params.geometry = {
          matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
          constrain_crop: false,
          output: { width: '4', height: 2 },
        }),
      'render_params.geometry.output.width',
    ],
    [
      'a string row slice',
      (m) => (m.policy.row_slice = '32'),
      'policy.row_slice',
    ],
    [
      'a string output width',
      (m) => (m.output.dimensions.width = '4'),
      'output.dimensions.width',
    ],
    [
      'an unknown native variant',
      (m) => (m.environment.native_artifacts.variant = 'tiny'),
      'environment.native_artifacts.variant',
    ],
    [
      'a malformed LUT identity',
      (m) => (m.lut = { kind: 'local-file', sha256: 'd'.repeat(64) }),
      'lut.filename',
    ],
  ])(
    'refuses a correctly resealed manifest with %s',
    async (_label, edit, path) => {
      const manifest = resealed(edit)
      const result = await verify(manifest)
      expect(result.valid).toBe(false)
      expect(result.manifest).toBeNull()
      expect(result.issues).toContainEqual(
        expect.stringMatching(new RegExp(`^${path.replaceAll('.', '\\.')}: `)),
      )
      expect(result.issues.join(' ')).not.toMatch(/manifest_sha256/)
      const path_ = join(dir, 'm.json')
      await expect(
        requireVerifiedManifest(path_, environment),
      ).rejects.toMatchObject({ code: 'manifest.invalid' })
    },
  )

  it('converts quality between percent and unit scale', () => {
    expect(qualityToPercent(0.92)).toBe(92)
    expect(percentToQuality(85)).toBe(0.85)
  })
})
