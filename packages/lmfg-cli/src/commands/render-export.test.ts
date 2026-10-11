// @vitest-environment node
import { Buffer } from 'node:buffer'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createLumaJpegRuntimeForNode } from '@lumaforge/luma-jpeg-runtime/node'
import { createLumaRawRuntimeForNode } from '@lumaforge/luma-raw-runtime/node'
import type { RenderManifest } from '@lumaforge/render-engine'
import { sealRenderManifest } from '@lumaforge/render-engine/manifest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createCliHarness,
  describeWithFixture,
  FIXTURE_PATH,
  identityCube,
} from '../e2e/fixture'
import { EXIT_CODES } from '../protocol/exit-codes'
import { loadSourceFile } from '../runtime/source-loader'
import { resolveRenderEnvironment } from '../runtime/versions'
import { parseRenderParams } from '../schemas/params'
import { ExportResultSchema } from '../schemas/results'
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
import { workspacePaths } from '../workspace/paths'
import { createSessionStore } from '../workspace/session-store'

vi.mock('@lumaforge/luma-raw-runtime/node', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@lumaforge/luma-raw-runtime/node')>()
  return {
    ...actual,
    createLumaRawRuntimeForNode: vi.fn(actual.createLumaRawRuntimeForNode),
  }
})

vi.mock('@lumaforge/luma-jpeg-runtime/node', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@lumaforge/luma-jpeg-runtime/node')>()
  return {
    ...actual,
    createLumaJpegRuntimeForNode: vi.fn(actual.createLumaJpegRuntimeForNode),
  }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rm: vi.fn(actual.rm) }
})

const actualFs =
  await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
const actualRaw = await vi.importActual<
  typeof import('@lumaforge/luma-raw-runtime/node')
>('@lumaforge/luma-raw-runtime/node')
const actualJpeg = await vi.importActual<
  typeof import('@lumaforge/luma-jpeg-runtime/node')
>('@lumaforge/luma-jpeg-runtime/node')

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
  vi.mocked(rm).mockImplementation(actualFs.rm)
  vi.mocked(createLumaRawRuntimeForNode).mockImplementation(
    actualRaw.createLumaRawRuntimeForNode,
  )
  vi.mocked(createLumaJpegRuntimeForNode).mockImplementation(
    actualJpeg.createLumaJpegRuntimeForNode,
  )
  await actualFs.rm(cwd, { recursive: true, force: true })
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

/**
 * The structured refusals a sealed candidate of a retired manifest shape may
 * end in, with the exit code each one carries: the manifest reader refuses it
 * as invalid, or candidate admission refuses the export. Which of the two
 * stops it is not part of this contract.
 */
const ADMISSION_REFUSAL_EXIT_CODES: Record<string, number> = {
  'manifest.invalid': EXIT_CODES.failure,
  'export.refused': EXIT_CODES.exportRefused,
}

/**
 * Runs a real `--yes --emit ndjson` export over an earlier `final.jpg` and
 * requires the candidate to be refused before anything runs: a structured
 * error completion with a nonzero exit, no `started` or `artifact.ready`
 * event on either stream, no RAW or JPEG runtime created (so nothing is
 * decoded or encoded), no export manifest or temporary file, no allocation in
 * the session record, and the earlier export left byte for byte.
 */
async function expectRefusedBeforeExport() {
  const root = join(cwd, '.lmfg')
  const exportsDir = workspacePaths.exports(root, sessionId)
  const destination = workspacePaths.exportFile(root, sessionId, 'final')
  const earlier = Buffer.from('earlier export jpeg bytes')
  await mkdir(exportsDir, { recursive: true })
  await writeFile(destination, earlier)
  const sessionFile = workspacePaths.sessionFile(root, sessionId)
  const sessionBefore = await readFile(sessionFile, 'utf8')
  vi.mocked(createLumaRawRuntimeForNode).mockClear()
  vi.mocked(createLumaJpegRuntimeForNode).mockClear()

  const result = await cli.run(
    '--yes',
    '--emit',
    'ndjson',
    'render',
    'export',
    '--session',
    sessionId,
    '--iteration',
    'iter_0001',
    '--candidate',
    'cand_0001',
  )

  expect(result.envelope).toMatchObject({
    event: 'completed',
    ok: false,
    error: { code: expect.any(String), message: expect.any(String) },
  })
  const code = String(result.envelope.error!.code)
  expect(Object.keys(ADMISSION_REFUSAL_EXIT_CODES)).toContain(code)
  expect(result.code, result.stdout).toBe(ADMISSION_REFUSAL_EXIT_CODES[code])
  expect(
    result.lines.filter(
      (line) => line.event === 'started' || line.event === 'artifact.ready',
    ),
  ).toEqual([])
  expect(result.stderr).not.toMatch(/^\[(?:started|artifact\.ready)\]/m)
  expect(createLumaRawRuntimeForNode).not.toHaveBeenCalled()
  expect(createLumaJpegRuntimeForNode).not.toHaveBeenCalled()
  expect(await readdir(exportsDir)).toEqual(['final.jpg'])
  expect(await readFile(destination)).toEqual(earlier)
  expect(
    await fileExists(
      workspacePaths.exportManifestFile(root, sessionId, 'final'),
    ),
  ).toBe(false)
  expect(await readFile(sessionFile, 'utf8')).toBe(sessionBefore)
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

  // A correctly sealed candidate of a retired shape is refused before any
  // decode, encode, or publication; the refusal is structured, but the stage
  // that refuses it and its wording are not pinned here.
  it('refuses a sealed candidate with a non-current descriptor version before exporting', async () => {
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
    await expectRefusedBeforeExport()
  })

  it('refuses a sealed candidate without recorded RAW exposure before exporting, instead of resolving it again', async () => {
    const { raw_render_exposure_ev: _ev, ...params } = manifest.render_params
    await writeJsonAtomic(
      paths.manifest,
      // A retired shape: the current params type cannot express it.
      sealRenderManifest({
        ...manifest,
        render_params: params as RenderManifest['render_params'],
      }),
    )
    await expectRefusedBeforeExport()
  })
})

/** A RAW session that exports an 8x512 frame whose third window read runs out of memory. */
function retryingRawSession() {
  const frame = { width: 8, height: 512 }
  let reads = 0
  return {
    probe: null,
    probeExportCapability: async () => ({
      supported: true,
      strategy: 'libraw-processed-window',
      ...frame,
      rawWidth: frame.width,
      rawHeight: frame.height,
      visibleCrop: { x: 0, y: 0, ...frame },
      cfa: { pattern: 'rggb', xPhase: 0, yPhase: 0 },
      blackLevel: 0,
      whiteLevel: 255,
      orientation: { code: 1, supported: true },
      color: {
        workingSpace: 'linear-prophoto-rgb',
        librawOutputColor: 'prophoto',
        gamma: 'linear',
        cameraWhiteBalanceAppliedByRuntime: true,
        cameraMatrixAppliedByRuntime: true,
      },
      sensor: {
        layout: 'bayer',
        colorCount: 3,
        cfa: { pattern: 'rggb', xPhase: 0, yPhase: 0 },
        phaseIsWindowLocal: false,
      },
      windows: { librawProcessed: true, rawMosaic: false },
      diagnostics: {
        hasRawImage: true,
        hasColor3Image: false,
        hasColor4Image: false,
        hasXTransTable: false,
      },
      reasons: [],
    }),
    beginProcessedWindowExport: async () => ({ active: true }),
    endProcessedWindowExport: async () => ({ ended: true }),
    readProcessedWindow: async (request: {
      outputRect: { x: number; y: number; width: number; height: number }
    }) => {
      reads += 1
      if (reads === 3) {
        // Let the strips already read reach the first attempt's temp file.
        await new Promise((resolve) => setTimeout(resolve, 20))
        throw new Error('RESOURCE_ALLOCATION_FAILED')
      }
      const { width, height } = request.outputRect
      return {
        rect: request.outputRect,
        workingSpace: 'linear-prophoto-rgb',
        data: new Uint16Array(width * height * 3).fill(32768),
        width,
        height,
        stride: width * 3,
        normalized: false,
        orientationApplied: true,
        colorApplied: true,
        warnings: [],
      }
    },
    dispose: () => undefined,
  }
}

/** A native JPEG encoder stand-in that streams a chunk on every row write. */
function streamingNativeJpeg() {
  type Chunk = { bytes: Uint8Array; byteOffset: number; final: boolean }
  class LumaJpegEncoder {
    private pending: Chunk[] = []
    private started = false

    writeRows() {
      if (this.started) {
        this.pending.push({
          bytes: new Uint8Array(16),
          byteOffset: 0,
          final: false,
        })
        return
      }
      this.started = true
      // Opens a JPEG and passes the writer's 64 KiB header scan.
      const head = new Uint8Array(70_000)
      head.set([0xFF, 0xD8, 0xFF, 0xDB, 0x00, 0x02])
      this.pending.push({ bytes: head, byteOffset: 0, final: false })
    }

    finish() {
      this.pending.push({
        bytes: new Uint8Array([0xFF, 0xD9]),
        byteOffset: 0,
        final: true,
      })
      return new Uint8Array(0)
    }

    drainChunks() {
      const chunks = this.pending
      this.pending = []
      return chunks
    }

    abort() {}

    delete() {}
  }
  return { LumaJpegEncoder }
}

describe('candidate export after an engine retry', () => {
  it('publishes the export and reports the temp file the abandoned attempt left', async () => {
    vi.mocked(createLumaRawRuntimeForNode).mockImplementation(
      async () =>
        ({
          init: async () => undefined,
          openSession: async () => retryingRawSession(),
          dispose: () => undefined,
        }) as never,
    )
    const nativeJpeg = streamingNativeJpeg()
    vi.mocked(createLumaJpegRuntimeForNode).mockImplementation((options) =>
      actualJpeg.createLumaJpegRuntimeForNode({
        ...options,
        nativeLoader: async () => nativeJpeg,
      }),
    )
    vi.mocked(rm).mockImplementation(async (path, options) => {
      if (String(path).endsWith('.tmp')) {
        throw Object.assign(
          new Error(`EACCES: permission denied, unlink '${String(path)}'`),
          { code: 'EACCES', syscall: 'unlink' },
        )
      }
      return actualFs.rm(path, options)
    })

    const result = await cli.run(
      'render',
      'export',
      '--session',
      sessionId,
      '--iteration',
      'iter_0001',
      '--candidate',
      'cand_0001',
      '--preferred-rows',
      '128',
    )

    expect(result.code, result.stdout).toBe(0)
    expect(result.envelope).toMatchObject({
      schema: 'lmfg.render.export.v1',
      ok: true,
    })
    const exported = ExportResultSchema.parse(result.envelope.result)
    expect(exported.cleanup_failures).toEqual([
      { step: 'remove_temp_file', code: 'permission.denied', errno: 'EACCES' },
    ])
    expect(exported.cleanup_failures_omitted).toBeUndefined()
    expect(result.stdout).not.toContain('.tmp')
    const exportsDir = join(cwd, '.lmfg', 'sessions', sessionId, 'exports')
    const files = (await readdir(exportsDir)).sort()
    expect(files).toHaveLength(3)
    expect(files).toContain('final.jpg')
    expect(
      files.filter((file) => /^final\.jpg\.\d+\.[0-9a-f]{8}\.tmp$/.test(file)),
    ).toHaveLength(1)
    expect(exported.output.path).toBe(join(exportsDir, 'final.jpg'))
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
