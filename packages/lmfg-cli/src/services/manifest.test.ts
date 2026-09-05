// @vitest-environment node
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { resolveRenderEnvironment } from '../runtime/versions'
import { parseRenderParams } from '../schemas/params'
import { buildColorGraph, requireSupportedGraph } from './color-graph'
import {
  buildRenderManifest,
  percentToQuality,
  qualityToPercent,
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

  it('converts quality between percent and unit scale', () => {
    expect(qualityToPercent(0.92)).toBe(92)
    expect(percentToQuality(85)).toBe(0.85)
  })
})
