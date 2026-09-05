// @vitest-environment node
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { RenderManifest } from '@lumaforge/render-engine'
import { sealRenderManifest } from '@lumaforge/render-engine/manifest'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  createCliHarness,
  describeWithFixture,
  FIXTURE_PATH,
  identityCube,
} from '../e2e/fixture'
import { loadSourceFile } from '../runtime/source-loader'
import { resolveRenderEnvironment } from '../runtime/versions'
import { parseRenderParams } from '../schemas/params'
import {
  buildColorGraph,
  manifestToRenderParams,
  requireSupportedGraph,
  toColorGraphIdentity,
} from '../services/color-graph'
import { exposureFromManifest } from '../services/export'
import { resolveLutForParams } from '../services/lut'
import { buildRenderManifest, toSourceIdentity } from '../services/manifest'
import { fileExists, readJson, writeJsonAtomic } from '../workspace/atomic-fs'
import { createIterationStore } from '../workspace/iteration-store'
import { createSessionStore } from '../workspace/session-store'

let cwd: string
let cli: ReturnType<typeof createCliHarness>
let sessionId: string
let paths: ReturnType<ReturnType<typeof createIterationStore>['candidatePaths']>
let manifest: RenderManifest

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'lmfg-export-inputs-'))
  cli = createCliHarness(cwd)
  await writeFile(join(cwd, 'source.dng'), 'source identity test bytes')
  const source = await loadSourceFile('source.dng', cwd)
  const record = await createSessionStore(join(cwd, '.lmfg')).init({
    sourcePath: source.absolutePath,
    sha256: source.sha256,
    byteSize: source.byteSize,
  })
  sessionId = record.id
  paths = createIterationStore(join(cwd, '.lmfg'), sessionId).candidatePaths(
    'iter_0001',
    'cand_0001',
  )
  await writeFile(
    join(cwd, 'look.cube'),
    identityCube([
      'LUMAFORGE_ROLE=display-look',
      'LUMAFORGE_INPUT_PROFILE=display-srgb',
    ]),
  )
  const params = parseRenderParams({
    exposure_ev: 0.3,
    contrast: 12,
    temperature: -15,
    selective_color: { red: { hue: 7 } },
    lut: { path: 'look.cube' },
  })
  const lut = await resolveLutForParams(params.lut, cwd)
  const exposure = {
    ev: -0.2,
    multiplier: 2 ** -0.2,
    source: 'dng-baseline' as const,
  }
  manifest = buildRenderManifest({
    kind: 'candidate',
    source: toSourceIdentity(source, { width: 4, height: 2 }),
    lut: lut!.identity,
    graph: requireSupportedGraph(
      buildColorGraph(params, lut!.lutData, exposure),
    ),
    params,
    exposure,
    policy: {
      kind: 'preview-quick',
      row_slice: 32,
      concurrency: 1,
      max_pixels: 8,
    },
    environment: resolveRenderEnvironment('desktop'),
    output: {
      width: 4,
      height: 2,
      quality: 85,
      filename: 'preview.jpg',
      sha256: 'b'.repeat(64),
    },
    parentManifestSha256: null,
  })
  await writeJsonAtomic(paths.manifest, manifest)
  await writeJsonAtomic(paths.params, params)
})

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true })
})

async function exportCandidate() {
  return cli.run(
    'render',
    'export',
    '--session',
    sessionId,
    '--iteration',
    'iter_0001',
    '--candidate',
    'cand_0001',
    '--dry-run',
  )
}

async function expectRefused(message: RegExp) {
  const result = await exportCandidate()
  expect(result.code, result.stdout).toBe(8)
  expect(result.envelope.error).toMatchObject({
    code: 'export.refused',
    message: expect.stringMatching(message),
  })
  expect(
    await fileExists(
      join(cwd, '.lmfg', 'sessions', sessionId, 'exports', 'final.jpg'),
    ),
  ).toBe(false)
}

describe('candidate export input integrity', () => {
  it('reconstructs the selected look despite edited sidecar params and LUT contract', async () => {
    await writeJsonAtomic(
      paths.params,
      parseRenderParams({
        exposure_ev: 3,
        contrast: -50,
        temperature: 90,
        raw_render_exposure: 2.5,
        lut: {
          path: 'look.cube',
          contract: {
            role: 'display-look',
            input_gamut: 'srgb-rec709',
            input_transfer: 'gamma24',
            input_range: 'full',
          },
        },
      }),
    )
    const result = await exportCandidate()
    expect(result.code, result.stdout).toBe(0)
    expect(result.envelope.result!.plan).toMatchObject({
      params: {
        exposure_ev: 0.3,
        contrast: 12,
        temperature: -15,
        raw_render_exposure: -0.2,
        selective_color: { red: { hue: 7 } },
      },
      lut: manifest.lut,
      parent_manifest_sha256: manifest.manifest_sha256,
    })
  })

  it('refuses when the sidecar drops a required LUT and no matching cache exists', async () => {
    await writeJsonAtomic(paths.params, parseRenderParams({ lut: null }))
    await expectRefused(/LUT .* was not found/)
  })

  it('ignores an injected sidecar LUT when the selected candidate has no LUT', async () => {
    const graph = requireSupportedGraph(
      buildColorGraph(
        manifestToRenderParams(manifest.render_params),
        null,
        exposureFromManifest(manifest)!,
      ),
    )
    await writeJsonAtomic(
      paths.manifest,
      sealRenderManifest({
        ...manifest,
        lut: null,
        color_graph: toColorGraphIdentity(graph),
      }),
    )
    const result = await exportCandidate()
    expect(result.code, result.stdout).toBe(0)
    expect(result.envelope.result!.plan).toMatchObject({ lut: null })
  })

  it('refuses when a LUT location now contains different bytes', async () => {
    await writeFile(join(cwd, 'look.cube'), `${identityCube([])}\n# changed`)
    await expectRefused(/LUT .* does not match the manifest/)
  })

  it('refuses a verified candidate manifest for a different source', async () => {
    await writeJsonAtomic(
      paths.manifest,
      sealRenderManifest({
        ...manifest,
        source_raw: { ...manifest.source_raw, sha256: 'f'.repeat(64) },
      }),
    )
    await expectRefused(/Source .* does not match the manifest/)
  })

  it('refuses resealed parameters that disagree with the recorded graph', async () => {
    await writeJsonAtomic(
      paths.manifest,
      sealRenderManifest({
        ...manifest,
        render_params: { ...manifest.render_params, exposure_ev: 2 },
      }),
    )
    await expectRefused(/rebuilt color graph does not match/)
  })

  it('refuses a descriptor version whose graph cannot be verified', async () => {
    await writeJsonAtomic(
      paths.manifest,
      sealRenderManifest({
        ...manifest,
        color_graph: {
          ...manifest.color_graph,
          descriptor: { descriptor_version: 1 },
        },
      }),
    )
    await expectRefused(/descriptor this runtime cannot verify/)
  })

  it('refuses a candidate without recorded RAW exposure instead of resolving it again', async () => {
    const { raw_render_exposure_ev: _ev, ...params } = manifest.render_params
    await writeJsonAtomic(
      paths.manifest,
      sealRenderManifest({ ...manifest, render_params: params }),
    )
    await expectRefused(/does not record raw_render_exposure_ev/)
  })
})

describeWithFixture('candidate export rendering integrity', () => {
  it('exports the chosen candidate graph and look after sidecar drift', async () => {
    const initialized = await cli.run(
      'session',
      'init',
      '--source',
      FIXTURE_PATH,
    )
    expect(initialized.code, initialized.stdout).toBe(0)
    sessionId = initialized.envelope.result!.id as string
    const candidates = await cli.run(
      'render',
      'candidate',
      '--session',
      sessionId,
      '--max-pixels',
      '200000',
      '--concurrency',
      '1',
      '--plan-json',
      JSON.stringify({
        candidates: [
          {
            params: {
              exposure_ev: 0.3,
              contrast: 12,
              lut: { path: 'look.cube' },
            },
          },
        ],
      }),
    )
    expect(candidates.code, candidates.stdout).toBe(0)
    paths = createIterationStore(join(cwd, '.lmfg'), sessionId).candidatePaths(
      'iter_0001',
      'cand_0001',
    )
    const selected = await readJson<RenderManifest>(paths.manifest)
    await writeJsonAtomic(
      paths.params,
      parseRenderParams({
        exposure_ev: 3,
        contrast: -50,
        raw_render_exposure: 2.5,
        lut: {
          path: 'look.cube',
          contract: {
            role: 'display-look',
            input_gamut: 'srgb-rec709',
            input_transfer: 'gamma24',
            input_range: 'full',
          },
        },
      }),
    )
    const exported = await cli.run(
      'render',
      'export',
      '--session',
      sessionId,
      '--iteration',
      'iter_0001',
      '--candidate',
      'cand_0001',
    )
    expect(exported.code, exported.stdout).toBe(0)
    const result = exported.envelope.result!
    const exportedManifest = await readJson<RenderManifest>(
      fileURLToPath(result.manifest_uri as string),
    )
    expect(exportedManifest.parent_manifest_sha256).toBe(
      selected.manifest_sha256,
    )
    expect(exportedManifest.render_params).toEqual(selected.render_params)
    expect(exportedManifest.color_graph).toEqual(selected.color_graph)
    expect(exportedManifest.lut).toEqual(selected.lut)
    expect(exportedManifest.source_raw.sha256).toBe(selected.source_raw.sha256)
    expect(result.output).toMatchObject({ width: 4032, height: 3024 })
    expect(await fileExists((result.output as { path: string }).path)).toBe(
      true,
    )
  }, 120_000)
})
