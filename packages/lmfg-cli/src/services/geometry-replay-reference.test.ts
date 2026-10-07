// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { RawRenderExposure } from '@lumaforge/luma-color-runtime'
import { exposureMultiplierFromEv } from '@lumaforge/luma-color-runtime'
import type { LumaRawProcessedWindowRequest } from '@lumaforge/luma-raw-runtime'
import type { RenderManifest } from '@lumaforge/render-engine'
import { createRenderManifest } from '@lumaforge/render-engine'
import type { ExportGeometry } from '@lumaforge/render-engine/export'
import { QUICK_PREVIEW_MAX_PIXELS } from '@lumaforge/render-engine/preview'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { LmfgRuntime } from '../runtime/node-runtime'
import { createLmfgRuntime } from '../runtime/node-runtime'
import type { LoadedSource } from '../runtime/source-loader'
import { loadSourceFile } from '../runtime/source-loader'
import { resolveRenderEnvironment } from '../runtime/versions'
import { parseRenderParams } from '../schemas/params'
import {
  describeWithFixture,
  FIXTURE_PATH,
} from '../test-support/describe-with-fixture'
import type { EngineExportReference } from '../test-support/engine-export-reference'
import {
  asymmetricProcessedWindow,
  jpegFrameDimensions,
  renderEngineExportReference,
  sha256Hex,
  syntheticExportCapability,
} from '../test-support/engine-export-reference'
import {
  buildColorGraph,
  requireSupportedGraph,
  toManifestRenderParams,
} from './color-graph'
import { runFullResolutionExport } from './export'
import { requireVerifiedManifest } from './manifest'
import { prepareReplay, runReplay } from './replay'

// Geometry replay is held to bytes the engine executor renders on its own
// (`renderEngineExportReference`), never to a hash produced by the lmfg export
// adapter or by replay, and every frame size below is a literal read back from
// the JPEG's SOF header. The synthetic suite and the native-fixture suite are
// separate evidence; neither says anything about the browser's encoder or
// metadata writer.

const environment = resolveRenderEnvironment('desktop')
const params = parseRenderParams({ contrast: 5 })
const exposure: RawRenderExposure = {
  ev: 0.3,
  multiplier: exposureMultiplierFromEv(0.3),
  source: 'user',
}
const graph = requireSupportedGraph(buildColorGraph(params, null, exposure))
const QUALITY_PERCENT = 92
const ROW_SLICE = 256

/** A small rotation with a constrained crop, as the app's Transform commits it. */
const ROTATED: ExportGeometry = {
  matrix: [0.99, -0.04, 0.02, 0.04, 0.99, -0.01, 0, 0, 1],
  constrainCrop: true,
}

type Dimensions = { width: number; height: number }

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lmfg-geometry-reference-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** Seals an export manifest the way the browser seals a committed Transform. */
function sealGeometryManifest(input: {
  source: Pick<LoadedSource, 'sha256' | 'byteSize' | 'filename'>
  decoded: Dimensions
  geometry: ExportGeometry
  delivered: Dimensions
  sha256: string
}): RenderManifest {
  return createRenderManifest({
    kind: 'export',
    source_raw: {
      sha256: input.source.sha256,
      byte_size: input.source.byteSize,
      filename: input.source.filename,
      decoded_dimensions: input.decoded,
    },
    lut: null,
    graph,
    render_params: {
      ...toManifestRenderParams(params, exposure),
      geometry: {
        matrix: input.geometry.matrix,
        constrain_crop: input.geometry.constrainCrop,
        output: input.delivered,
      },
    },
    policy: { kind: 'export-full', row_slice: ROW_SLICE, concurrency: 1 },
    environment,
    output: {
      ...input.delivered,
      quality: QUALITY_PERCENT,
      filename: 'a_fullres.jpg',
      sha256: input.sha256,
    },
    parent_manifest_sha256: null,
  })
}

/**
 * Replays a sealed manifest the way `lmfg replay` does: written to disk and
 * read back through the manifest reader first, so the fixture is held to the
 * record the reader accepts and not only to its in-memory form.
 */
async function replayManifest(
  sealed: RenderManifest,
  runtime: LmfgRuntime,
  source: LoadedSource,
) {
  const manifestPath = join(dir, 'm.json')
  await writeFile(manifestPath, JSON.stringify(sealed))
  const { manifest } = await requireVerifiedManifest(manifestPath, environment)
  const plan = await prepareReplay({
    manifest,
    source,
    workspaceRoot: dir,
    cwd: dir,
  })
  const outputPath = join(dir, 'replay', 'output.jpg')
  const manifestOutputPath = join(dir, 'replay', 'manifest.json')
  const result = await runReplay({
    runtime,
    plan,
    source,
    environment,
    manifestPath,
    sessionId: null,
    outputPath,
    manifestOutputPath,
  })
  return { result, outputPath, manifestOutputPath }
}

describe('geometry replay against a synthetic engine reference', () => {
  const decoded = { width: 64, height: 48 }
  /** The rotation's constrained crop of the 64x48 frame. */
  const delivered = { width: 60, height: 45 }
  const capability = syntheticExportCapability(decoded)
  const readWindow = async (request: LumaRawProcessedWindowRequest) =>
    asymmetricProcessedWindow(request, decoded)
  const source: LoadedSource = {
    absolutePath: '/x/a.dng',
    filename: 'a.dng',
    bytes: new Uint8Array(),
    byteSize: 1,
    sha256: 'a'.repeat(64),
    input: { data: new Uint8Array(), name: 'a.dng', size: 1 },
  } as unknown as LoadedSource

  function reference(geometry?: ExportGeometry) {
    return renderEngineExportReference({
      capability,
      graph,
      readProcessedWindow: readWindow,
      quality: QUALITY_PERCENT / 100,
      preferredRows: ROW_SLICE,
      ...(geometry ? { geometry } : {}),
    })
  }

  /** A RAW runtime whose one session decodes the synthetic frame. */
  function fakeRuntime() {
    const session = {
      probe: null,
      probeExportCapability: vi.fn(async () => capability),
      beginProcessedWindowExport: vi.fn(async () => ({ active: true })),
      readProcessedWindow: vi.fn(readWindow),
      endProcessedWindowExport: vi.fn(async () => ({ ended: true as const })),
      dispose: vi.fn(),
    }
    return {
      memoryProfile: 'desktop',
      raw: async () => ({
        openSession: async () => session,
        decodeQuick: async () => {
          throw new Error('a pinned exposure never quick-decodes')
        },
      }),
      jpeg: async () => {
        throw new Error('the export streams through its own JPEG runtime')
      },
      dispose: () => undefined,
    } as unknown as LmfgRuntime
  }

  let expected: EngineExportReference
  beforeEach(async () => {
    expected = await reference(ROTATED)
  })

  it('renders the literal cropped frame', () => {
    expect(expected.frame).toEqual(delivered)
  })

  // Each entry is a way replay's geometry mapping could go wrong. A mirror or
  // a half turn keeps the frame size, so only the bytes catch it.
  const MIRROR_X = [-1, 0, 1, 0, 1, 0, 0, 0, 1]
  const MIRROR_Y = [1, 0, 0, 0, -1, 1, 0, 0, 1]
  const HALF_TURN = [-1, 0, 1, 0, -1, 1, 0, 0, 1]
  function compose(a: readonly number[], b: readonly number[]): number[] {
    return Array.from({ length: 9 }, (_, index) => {
      const row = Math.floor(index / 3)
      const column = index % 3
      return [0, 1, 2].reduce(
        (sum, k) => sum + a[row * 3 + k]! * b[k * 3 + column]!,
        0,
      )
    })
  }
  it.each([
    [
      'a horizontal mirror',
      { ...ROTATED, matrix: compose(MIRROR_X, ROTATED.matrix) },
      delivered,
    ],
    [
      'a vertical mirror',
      { ...ROTATED, matrix: compose(MIRROR_Y, ROTATED.matrix) },
      delivered,
    ],
    [
      'a half turn',
      { ...ROTATED, matrix: compose(HALF_TURN, ROTATED.matrix) },
      delivered,
    ],
    ['an omitted transform', undefined, decoded],
    ['a dropped crop flag', { ...ROTATED, constrainCrop: false }, decoded],
    [
      'a transform applied twice',
      { ...ROTATED, matrix: compose(ROTATED.matrix, ROTATED.matrix) },
      { width: 57, height: 43 },
    ],
  ] as Array<[string, ExportGeometry | undefined, Dimensions]>)(
    'tells %s apart from the committed geometry',
    async (_name, wrong, frame) => {
      const rendered = await reference(wrong)
      expect(rendered.frame).toEqual(frame)
      expect(rendered.sha256).not.toBe(expected.sha256)
    },
  )

  it('holds the export adapter to the reference bytes and frame', async () => {
    const outputPath = join(dir, 'exports', 'a_fullres.jpg')
    const exported = await runFullResolutionExport({
      runtime: fakeRuntime(),
      source,
      params,
      lut: null,
      exposure,
      quality: QUALITY_PERCENT,
      outputPath,
      preferredRows: ROW_SLICE,
      geometry: ROTATED,
    })
    await exported.commit()
    const jpeg = await readFile(outputPath)
    expect(jpegFrameDimensions(jpeg)).toEqual(delivered)
    expect(sha256Hex(jpeg)).toBe(expected.sha256)
    expect(exported.sha256).toBe(expected.sha256)
  })

  it('replays a sealed geometry manifest to the reference bytes and frame', async () => {
    const manifest = sealGeometryManifest({
      source,
      decoded,
      geometry: ROTATED,
      delivered,
      sha256: expected.sha256,
    })
    const { result, outputPath, manifestOutputPath } = await replayManifest(
      manifest,
      fakeRuntime(),
      source,
    )
    expect(result.reproduced).toBe(true)
    const jpeg = await readFile(outputPath)
    expect(jpegFrameDimensions(jpeg)).toEqual(delivered)
    expect(sha256Hex(jpeg)).toBe(expected.sha256)
    expect(result.output).toMatchObject({
      ...delivered,
      sha256: expected.sha256,
    })
    // The replay's own record reads back as a current one that replays the
    // same geometry to the same bytes.
    const { manifest: written } = await requireVerifiedManifest(
      manifestOutputPath,
      environment,
    )
    expect(written.render_params).toEqual(manifest.render_params)
    expect(written.color_graph).toEqual(manifest.color_graph)
    expect(written.output.sha256).toBe(expected.sha256)
    expect(written.parent_manifest_sha256).toBe(manifest.manifest_sha256)
  })

  it('refuses a recorded mirror that keeps the frame size but not the pixels', async () => {
    const mirrored = { ...ROTATED, matrix: compose(MIRROR_X, ROTATED.matrix) }
    const manifest = sealGeometryManifest({
      source,
      decoded,
      geometry: mirrored,
      delivered,
      sha256: expected.sha256,
    })
    const outcome = replayManifest(manifest, fakeRuntime(), source)
    await expect(outcome).rejects.toMatchObject({
      code: 'replay.mismatch',
      details: {
        stage: 'output',
        expected_sha256: expected.sha256,
        actual: delivered,
      },
    })
  })
})

describeWithFixture(
  'geometry replay against a native-fixture engine reference',
  () => {
    const LOCKED_FIXTURE_SHA256 =
      '7a2a9747a0cb1537007233ce7e8b7233c5ee641d683b7b3da29e22387994a0d7'
    /** The public DNG's decoded frame. */
    const decoded = { width: 4032, height: 3024 }
    /** The rotation's constrained crop of the 4032x3024 frame. */
    const delivered = { width: 3803, height: 2852 }

    /** The engine executor alone, on a RAW session of its own. */
    async function nativeReference(
      runtime: LmfgRuntime,
      source: LoadedSource,
    ): Promise<EngineExportReference> {
      const raw = await runtime.raw()
      const session = await raw.openSession(source.input, {
        maxOutputPixels: QUICK_PREVIEW_MAX_PIXELS,
      })
      try {
        const capability = await session.probeExportCapability()
        expect({ width: capability.width, height: capability.height }).toEqual(
          decoded,
        )
        return await renderEngineExportReference({
          capability,
          graph,
          readProcessedWindow: (request) =>
            session.readProcessedWindow(request),
          quality: QUALITY_PERCENT / 100,
          preferredRows: ROW_SLICE,
          geometry: ROTATED,
          metadata: session.probe,
          lifecycle: {
            beginProcessedWindowExport: session.beginProcessedWindowExport,
            endProcessedWindowExport: session.endProcessedWindowExport,
          },
        })
      } finally {
        session.dispose()
      }
    }

    it('holds the export adapter and replay to the engine reference', async () => {
      const runtime = createLmfgRuntime({ memoryProfile: 'desktop' })
      try {
        const source = await loadSourceFile(FIXTURE_PATH, '/')
        expect(source.sha256).toBe(LOCKED_FIXTURE_SHA256)
        const expected = await nativeReference(runtime, source)
        expect(expected.frame).toEqual(delivered)

        const exportPath = join(dir, 'exports', 'a_fullres.jpg')
        const exported = await runFullResolutionExport({
          runtime,
          source,
          params,
          lut: null,
          exposure,
          quality: QUALITY_PERCENT,
          outputPath: exportPath,
          preferredRows: ROW_SLICE,
          geometry: ROTATED,
        })
        await exported.commit()
        const exportedJpeg = await readFile(exportPath)
        expect(jpegFrameDimensions(exportedJpeg)).toEqual(delivered)
        expect(sha256Hex(exportedJpeg)).toBe(expected.sha256)

        const manifest = sealGeometryManifest({
          source,
          decoded,
          geometry: ROTATED,
          delivered,
          sha256: expected.sha256,
        })
        const { result, outputPath } = await replayManifest(
          manifest,
          runtime,
          source,
        )
        expect(result.reproduced).toBe(true)
        const replayed = await readFile(outputPath)
        expect(jpegFrameDimensions(replayed)).toEqual(delivered)
        expect(sha256Hex(replayed)).toBe(expected.sha256)
      } finally {
        runtime.dispose()
      }
    }, 240_000)
  },
)
