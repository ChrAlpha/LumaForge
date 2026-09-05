// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createLmfgRuntime } from '../runtime/node-runtime'
import { loadSourceFile } from '../runtime/source-loader'
import { resolveRenderEnvironment } from '../runtime/versions'
import { parseRenderParams } from '../schemas/params'
import {
  describeWithFixture,
  FIXTURE_PATH,
} from '../test-support/describe-with-fixture'
import { buildColorGraph, requireSupportedGraph } from './color-graph'
import { buildRenderManifest } from './manifest'
import { renderPreview } from './preview'
import { prepareReplay, replayKey, runReplay } from './replay'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lmfg-replay-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const environment = resolveRenderEnvironment('desktop')
const exposure = {
  ev: -0.2,
  multiplier: Math.pow(2, -0.2),
  source: 'dng-baseline' as const,
}

function fakeSource(sha256: string) {
  return {
    absolutePath: '/x/a.dng',
    filename: 'a.dng',
    bytes: new Uint8Array(),
    byteSize: 1,
    sha256,
    input: { data: new Uint8Array(), name: 'a.dng', size: 1 },
  }
}

function manifestFor(params = parseRenderParams({ contrast: 5 })) {
  return buildRenderManifest({
    kind: 'preview',
    source: {
      sha256: 'a'.repeat(64),
      byte_size: 1,
      filename: 'a.dng',
      decoded_dimensions: { width: 4, height: 2 },
    },
    lut: null,
    graph: requireSupportedGraph(buildColorGraph(params, null, exposure)),
    params,
    exposure,
    policy: {
      kind: 'preview-quick',
      row_slice: 32,
      concurrency: 1,
      max_pixels: 8,
    },
    environment,
    output: {
      width: 4,
      height: 2,
      quality: 85,
      filename: 'p.jpg',
      sha256: 'b'.repeat(64),
    },
    parentManifestSha256: null,
  })
}

describe('prepareReplay', () => {
  it('rebuilds params and exposure and confirms the fingerprint', async () => {
    const manifest = manifestFor()
    const plan = await prepareReplay({
      manifest,
      source: fakeSource('a'.repeat(64)),
      workspaceRoot: dir,
      cwd: dir,
    })
    expect(plan.fingerprintMatch).toBe(true)
    expect(plan.params.contrast).toBe(5)
    expect(plan.params.raw_render_exposure).toBe(-0.2)
    expect(plan.exposure).toEqual(exposure)
    expect(replayKey(manifest)).toBe(manifest.manifest_sha256.slice(0, 12))
  })

  it('refuses a source whose sha256 differs', async () => {
    await expect(
      prepareReplay({
        manifest: manifestFor(),
        source: fakeSource('c'.repeat(64)),
        workspaceRoot: dir,
        cwd: dir,
      }),
    ).rejects.toMatchObject({ code: 'hash.mismatch', exitCode: 6 })
  })

  it('refuses when the recorded params no longer rebuild the fingerprint', async () => {
    const manifest = manifestFor()
    const doctored = {
      ...manifest,
      render_params: { ...manifest.render_params, exposure_ev: 2 },
    }
    await expect(
      prepareReplay({
        manifest: doctored,
        source: fakeSource('a'.repeat(64)),
        workspaceRoot: dir,
        cwd: dir,
      }),
    ).rejects.toMatchObject({
      code: 'replay.mismatch',
      exitCode: 8,
      details: { stage: 'color-graph' },
    })
  })

  it('skips the fingerprint gate for older descriptor versions', async () => {
    const manifest = manifestFor()
    const legacy = {
      ...manifest,
      color_graph: {
        fingerprint: 'f'.repeat(64),
        descriptor: { descriptor_version: 1 },
      },
    }
    const plan = await prepareReplay({
      manifest: legacy,
      source: fakeSource('a'.repeat(64)),
      workspaceRoot: dir,
      cwd: dir,
    })
    expect(plan.fingerprintMatch).toBeNull()
  })

  it('requires the LUT file recorded in the manifest', async () => {
    const manifest = manifestFor()
    const withLut = {
      ...manifest,
      lut: {
        kind: 'local-file' as const,
        filename: 'look.cube',
        sha256: 'd'.repeat(64),
        input_contract: {
          gamut: 'srgb-rec709',
          transfer: 'srgb',
          range: 'full' as const,
        },
        output_contract: {
          gamut: 'srgb-rec709',
          transfer: 'srgb',
          range: 'full' as const,
          role: 'display-look',
        },
      },
    }
    await expect(
      prepareReplay({
        manifest: withLut,
        source: fakeSource('a'.repeat(64)),
        workspaceRoot: dir,
        cwd: dir,
      }),
    ).rejects.toMatchObject({ code: 'file.not_found' })
  })
})

describeWithFixture('runReplay', () => {
  it('reproduces a preview byte for byte', async () => {
    const runtime = createLmfgRuntime({ memoryProfile: 'desktop' })
    try {
      const source = await loadSourceFile(FIXTURE_PATH, '/')
      const params = parseRenderParams({
        contrast: 25,
        selective_color: { red: { hue: 12 } },
      })
      const rendered = await renderPreview({
        runtime,
        source,
        params,
        lut: null,
        maxPixels: 200_000,
        quality: 0.8,
      })
      const manifest = buildRenderManifest({
        kind: 'preview',
        source: {
          sha256: source.sha256,
          byte_size: source.byteSize,
          filename: source.filename,
          decoded_dimensions: { width: 4032, height: 3024 },
        },
        lut: null,
        graph: rendered.graph,
        params,
        exposure: rendered.exposure,
        policy: {
          kind: 'preview-quick',
          row_slice: 32,
          concurrency: 1,
          max_pixels: 200_000,
        },
        environment,
        output: {
          width: rendered.frame.width,
          height: rendered.frame.height,
          quality: 80,
          filename: 'p.jpg',
          sha256: rendered.rendered.sha256,
        },
        parentManifestSha256: null,
      })
      const plan = await prepareReplay({
        manifest,
        source,
        workspaceRoot: dir,
        cwd: dir,
      })
      expect(plan.fingerprintMatch).toBe(true)
      const result = await runReplay({
        runtime,
        plan,
        source,
        environment,
        manifestPath: join(dir, 'm.json'),
        sessionId: null,
        outputPath: join(dir, 'replay', 'output.jpg'),
        manifestOutputPath: join(dir, 'replay', 'manifest.json'),
      })
      expect(result.reproduced).toBe(true)
      expect(result.actual_sha256).toBe(rendered.rendered.sha256)
      expect(result.parent_manifest_sha256).toBe(manifest.manifest_sha256)
    } finally {
      runtime.dispose()
    }
  }, 60_000)
})
