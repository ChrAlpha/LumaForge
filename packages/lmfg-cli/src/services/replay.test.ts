// @vitest-environment node
import { Buffer } from 'node:buffer'
import { existsSync } from 'node:fs'
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

import type { LumaRawProcessedWindowRequest } from '@lumaforge/luma-raw-runtime'
import type {
  RenderEnvironment,
  RenderManifest,
  RenderManifestKind,
} from '@lumaforge/render-engine'
import {
  computeManifestSha256,
  createRenderManifest,
  sealRenderManifest,
  verifyManifestSha256,
} from '@lumaforge/render-engine'
import {
  INVALID_EXPORT_GEOMETRY,
  planExportGeometry,
} from '@lumaforge/render-engine/export'
import type { ColorGraphDescriptor } from '@lumaforge/render-engine/manifest'
import { COLOR_GRAPH_DESCRIPTOR_VERSION } from '@lumaforge/render-engine/manifest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { toLmfgError } from '../protocol/errors'
import type { LmfgRuntime } from '../runtime/node-runtime'
import { createLmfgRuntime } from '../runtime/node-runtime'
import { loadSourceFile } from '../runtime/source-loader'
import { resolveRenderEnvironment } from '../runtime/versions'
import { parseRenderParams } from '../schemas/params'
import {
  describeWithFixture,
  FIXTURE_PATH,
} from '../test-support/describe-with-fixture'
import {
  asymmetricProcessedWindow,
  jpegFrameDimensions,
  renderEngineExportReference,
  sha256Hex,
  syntheticExportCapability,
} from '../test-support/engine-export-reference'
import { fileExists } from '../workspace/atomic-fs'
import {
  buildColorGraph,
  manifestToRenderParams,
  requireSupportedGraph,
  toManifestRenderParams,
} from './color-graph'
import { runFullResolutionExport } from './export'
import {
  buildRenderManifest,
  percentToQuality,
  requireVerifiedManifest,
  verifyManifestFile,
} from './manifest'
import { renderPreview } from './preview'
import type { ReplayPlan } from './replay'
import { prepareReplay, replayKey, runReplay } from './replay'

vi.mock('./export', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./export')>()
  return {
    ...actual,
    runFullResolutionExport: vi.fn(actual.runFullResolutionExport),
  }
})

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

function manifestFor(
  params = parseRenderParams({ contrast: 5 }),
  options: {
    kind?: RenderManifestKind
    environment?: RenderEnvironment
    outputSha256?: string
  } = {},
) {
  return buildRenderManifest({
    kind: options.kind ?? 'preview',
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
    environment: options.environment ?? environment,
    output: {
      width: 4,
      height: 2,
      quality: 85,
      filename: 'p.jpg',
      sha256: options.outputSha256 ?? 'b'.repeat(64),
    },
    parentManifestSha256: null,
  })
}

/** The decoded frame of the 4032x3024 sensor the browser-shaped manifests record. */
const SENSOR = { width: 4032, height: 3024 }

/** A small rotation with a constrained crop, as the app's Transform commits it. */
const ROTATED_MATRIX = [0.99, -0.04, 0.02, 0.04, 0.99, -0.01, 0, 0, 1]
/** The projective horizon crosses the frame, so the mapping folds. */
const FOLDING_MATRIX = [1, 0, 0, 0, 1, 0, -2, 0, 1]

function plannedOutput(
  geometry: { matrix: readonly number[]; constrain_crop: boolean },
  source: { width: number; height: number },
) {
  const planned = planExportGeometry(
    { matrix: geometry.matrix, constrainCrop: geometry.constrain_crop },
    source,
  )
  return { width: planned.outputWidth, height: planned.outputHeight }
}

type GeometryManifestOptions = {
  params?: ReturnType<typeof parseRenderParams>
  kind?: RenderManifestKind
  source?: { width: number; height: number }
  matrix?: readonly number[]
  constrainCrop?: boolean
  /** Recorded `render_params.geometry.output`; defaults to the planned frame. */
  geometryOutput?: { width: number; height: number }
  /** Recorded `output.dimensions`; defaults to the geometry output. */
  output?: { width: number; height: number }
  outputSha256?: string
  environment?: RenderEnvironment
  rowSlice?: number
}

/**
 * A sealed export manifest shaped like the one the browser writes for a
 * committed geometry: the matrix and cropped output frame sit beside the color
 * params, outside the color graph, and the source records its decoded frame.
 */
function geometryManifestFor(options: GeometryManifestOptions = {}) {
  const params = options.params ?? parseRenderParams({ contrast: 5 })
  const source = options.source ?? SENSOR
  const matrix = options.matrix ?? ROTATED_MATRIX
  const constrainCrop = options.constrainCrop ?? true
  const geometryOutput =
    options.geometryOutput ??
    plannedOutput({ matrix, constrain_crop: constrainCrop }, source)
  const output = options.output ?? geometryOutput
  return createRenderManifest({
    kind: options.kind ?? 'export',
    source_raw: {
      sha256: 'a'.repeat(64),
      byte_size: 1,
      filename: 'a.dng',
      decoded_dimensions: source,
    },
    lut: null,
    graph: requireSupportedGraph(buildColorGraph(params, null, exposure)),
    render_params: {
      ...toManifestRenderParams(params, exposure),
      geometry: {
        matrix,
        constrain_crop: constrainCrop,
        output: geometryOutput,
      },
    },
    policy: {
      kind: 'export-full',
      row_slice: options.rowSlice ?? 256,
      concurrency: 1,
    },
    environment: options.environment ?? environment,
    output: {
      ...output,
      quality: 92,
      filename: 'a_fullres.jpg',
      sha256: options.outputSha256 ?? 'b'.repeat(64),
    },
    parent_manifest_sha256: null,
  })
}

/** Entries a replay directory holds; a refused replay leaves no temp file behind. */
async function entriesOf(path: string): Promise<string[]> {
  try {
    return (await readdir(path)).sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

/** Writes an earlier replay at the destination, as `--yes` lets a replay overwrite. */
async function seedEarlierReplay(outputPath: string, manifestPath: string) {
  const jpeg = Buffer.from('earlier replay jpeg bytes')
  const manifest = '{"earlier":"replay manifest"}\n'
  await mkdir(join(outputPath, '..'), { recursive: true })
  await writeFile(outputPath, jpeg)
  await writeFile(manifestPath, manifest)
  return { jpeg, manifest }
}

function prepare(manifest: RenderManifest) {
  return prepareReplay({
    manifest,
    source: fakeSource('a'.repeat(64)),
    workspaceRoot: dir,
    cwd: dir,
  })
}

describe('replay fixtures', () => {
  it.each<[string, () => RenderManifest]>([
    ['preview', () => manifestFor()],
    ['candidate', () => manifestFor(undefined, { kind: 'candidate' })],
    ['export', () => manifestFor(undefined, { kind: 'export' })],
    ['geometry export', () => geometryManifestFor()],
  ])(
    'reads the %s fixture back as a complete current record',
    async (_label, make) => {
      const manifest = make()
      const path = join(dir, 'fixture.json')
      await writeFile(path, JSON.stringify(manifest))
      const { manifest: read } = await requireVerifiedManifest(
        path,
        environment,
      )
      expect(read).toEqual(manifest)
      const descriptor = read.color_graph.descriptor as ColorGraphDescriptor
      expect(descriptor.descriptor_version).toBe(COLOR_GRAPH_DESCRIPTOR_VERSION)
      expect(read.render_params).toMatchObject({
        exposure_ev: 0,
        tone_curve: { contrast: 5, highlights: 0, shadows: 0 },
        color_balance: { temperature: 0, tint: 0 },
        saturation: { saturation: 0, vibrance: 0 },
        intensity: 1,
        raw_render_exposure_ev: -0.2,
        raw_render_exposure_source: 'dng-baseline',
      })
      expect(read.render_params.selective_color).toBeUndefined()
      expect(read.calibration).toBeNull()
    },
  )
})

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

  it('refuses a current descriptor whose fingerprint the rebuilt graph does not produce', async () => {
    const manifest = manifestFor()
    const descriptor = manifest.color_graph.descriptor as ColorGraphDescriptor
    expect(descriptor.descriptor_version).toBe(COLOR_GRAPH_DESCRIPTOR_VERSION)
    const mismatched = {
      ...manifest,
      color_graph: { ...manifest.color_graph, fingerprint: 'f'.repeat(64) },
    }
    await expect(prepare(mismatched)).rejects.toMatchObject({
      code: 'replay.mismatch',
      exitCode: 8,
      details: {
        stage: 'color-graph',
        expected_fingerprint: 'f'.repeat(64),
        actual_fingerprint: manifest.color_graph.fingerprint,
      },
    })
  })

  // Sealed with the descriptor an earlier writer recorded. The reader refuses
  // these records; a plan built from one directly still verifies the graph it
  // rebuilds against the recorded fingerprint instead of skipping the check.
  it.each<[string, unknown]>([
    ['an older descriptor version', { descriptor_version: 1 }],
    ['an unversioned descriptor', {}],
  ])(
    'refuses a sealed manifest with %s before any decode',
    async (_label, descriptor) => {
      const manifest = sealRenderManifest({
        ...manifestFor(),
        color_graph: { fingerprint: 'f'.repeat(64), descriptor },
      })
      expect(verifyManifestSha256(manifest)).toBe(true)
      const path = join(dir, 'old.json')
      await writeFile(path, JSON.stringify(manifest))
      await expect(
        requireVerifiedManifest(path, environment),
      ).rejects.toMatchObject({ code: 'manifest.invalid', exitCode: 1 })
      await expect(prepare(manifest)).rejects.toMatchObject({
        code: 'replay.mismatch',
        exitCode: 8,
        details: {
          stage: 'color-graph',
          expected_fingerprint: 'f'.repeat(64),
          actual_fingerprint: manifestFor().color_graph.fingerprint,
        },
      })
    },
  )

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

describe('prepareReplay with a recorded geometry', () => {
  it('accepts a browser-shaped crop and rotation', async () => {
    // The rotation's constrained crop of the 4032x3024 frame, as a literal.
    const delivered = { width: 3803, height: 2852 }
    const manifest = geometryManifestFor({ geometryOutput: delivered })
    expect(verifyManifestSha256(manifest)).toBe(true)
    expect(manifest.output.dimensions).toEqual(delivered)
    const plan = await prepare(manifest)
    expect(plan.fingerprintMatch).toBe(true)
    expect(plan.params.contrast).toBe(5)
  })

  it('accepts an unconstrained geometry that keeps the sensor frame', async () => {
    const manifest = geometryManifestFor({ constrainCrop: false })
    expect(manifest.output.dimensions).toEqual(SENSOR)
    await expect(prepare(manifest)).resolves.toMatchObject({
      fingerprintMatch: true,
    })
  })

  it('refuses a folding geometry', async () => {
    const manifest = geometryManifestFor({
      matrix: FOLDING_MATRIX,
      constrainCrop: false,
      geometryOutput: SENSOR,
    })
    expect(verifyManifestSha256(manifest)).toBe(true)
    const refused = await prepare(manifest).catch((error: unknown) => error)
    expect(refused).toMatchObject({
      code: 'args.invalid',
      exitCode: 2,
      details: { stage: 'geometry', source: SENSOR },
    })
    expect((refused as Error).cause).toEqual(new Error(INVALID_EXPORT_GEOMETRY))
  })

  it('refuses a geometry output the planner does not produce from the recorded source', async () => {
    const planned = plannedOutput(
      { matrix: ROTATED_MATRIX, constrain_crop: true },
      SENSOR,
    )
    const recorded = { width: planned.width - 1, height: planned.height }
    await expect(
      prepare(geometryManifestFor({ geometryOutput: recorded })),
    ).rejects.toMatchObject({
      code: 'replay.mismatch',
      exitCode: 8,
      details: { stage: 'geometry', expected: recorded, actual: planned },
    })
  })

  it('refuses a recorded source frame the geometry output was not planned from', async () => {
    const planned = plannedOutput(
      { matrix: ROTATED_MATRIX, constrain_crop: true },
      SENSOR,
    )
    await expect(
      prepare(
        geometryManifestFor({
          source: { width: 6000, height: 4000 },
          geometryOutput: planned,
        }),
      ),
    ).rejects.toMatchObject({
      code: 'replay.mismatch',
      details: { stage: 'geometry', expected: planned },
    })
  })

  it('refuses output dimensions that differ from the geometry output', async () => {
    const planned = plannedOutput(
      { matrix: ROTATED_MATRIX, constrain_crop: true },
      SENSOR,
    )
    await expect(
      prepare(geometryManifestFor({ output: SENSOR })),
    ).rejects.toMatchObject({
      code: 'replay.mismatch',
      details: { stage: 'dimensions', expected: SENSOR, actual: planned },
    })
  })

  it('refuses an export without a geometry whose output is not the decoded frame', async () => {
    const manifest = manifestFor(undefined, { kind: 'export' })
    const doctored = createRenderManifest({
      kind: 'export',
      source_raw: { ...manifest.source_raw, decoded_dimensions: SENSOR },
      lut: null,
      graph: requireSupportedGraph(
        buildColorGraph(parseRenderParams({ contrast: 5 }), null, exposure),
      ),
      render_params: manifest.render_params,
      policy: manifest.policy,
      environment: manifest.environment,
      output: {
        ...manifest.output.dimensions,
        quality: manifest.output.quality,
        filename: manifest.output.filename,
        sha256: manifest.output.sha256,
      },
      parent_manifest_sha256: null,
    })
    await expect(prepare(doctored)).rejects.toMatchObject({
      code: 'replay.mismatch',
      details: {
        stage: 'dimensions',
        expected: { width: 4, height: 2 },
        actual: SENSOR,
      },
    })
  })

  it('refuses a geometry on a preview manifest, which renders without one', async () => {
    await expect(
      prepare(geometryManifestFor({ kind: 'preview' })),
    ).rejects.toMatchObject({
      code: 'args.invalid',
      details: { stage: 'geometry', unsupported: 'render_params.geometry' },
    })
  })

  it('refuses a folding geometry before comparing a mismatched current fingerprint', async () => {
    const manifest = geometryManifestFor({
      matrix: FOLDING_MATRIX,
      constrainCrop: false,
      geometryOutput: SENSOR,
    })
    const mismatched = {
      ...manifest,
      color_graph: { ...manifest.color_graph, fingerprint: 'f'.repeat(64) },
    }
    await expect(prepare(mismatched)).rejects.toMatchObject({
      code: 'args.invalid',
      details: { stage: 'geometry' },
    })
  })
})

describe('replaying a manifest an earlier writer sealed', () => {
  const neutralBand = { hue: 0, saturation: 0, lightness: 0 }
  const explicitNeutral = Object.fromEntries(
    [
      'red',
      'orange',
      'yellow',
      'green',
      'aqua',
      'blue',
      'purple',
      'magenta',
    ].map((id) => [id, neutralBand]),
  )

  /** Sealed the way earlier CLI writers did: all eight neutral bands recorded. */
  function explicitNeutralManifestFor(
    options: { environment?: RenderEnvironment } = {},
  ) {
    const manifest = manifestFor(parseRenderParams({ contrast: 5 }), options)
    const { manifest_sha256: _sha, ...unsealed } = manifest
    return createRenderManifest({
      kind: unsealed.kind,
      source_raw: unsealed.source_raw,
      lut: null,
      graph: requireSupportedGraph(
        buildColorGraph(parseRenderParams({ contrast: 5 }), null, exposure),
      ),
      render_params: {
        ...unsealed.render_params,
        selective_color: explicitNeutral,
      },
      policy: unsealed.policy,
      environment: unsealed.environment,
      output: {
        ...unsealed.output.dimensions,
        quality: unsealed.output.quality,
        filename: unsealed.output.filename,
        sha256: unsealed.output.sha256,
      },
      parent_manifest_sha256: null,
      produced_at: unsealed.produced_at,
    })
  }

  it('checks its seal as written, then rebuilds the same color graph', async () => {
    const legacy = explicitNeutralManifestFor()
    expect(legacy.render_params.selective_color).toEqual(explicitNeutral)
    const path = join(dir, 'legacy.json')
    await writeFile(path, JSON.stringify(legacy))
    const verification = await verifyManifestFile(path, { environment })
    expect(verification.raw).toEqual(legacy)
    expect(verification.issues.join(' ')).not.toMatch(/manifest_sha256/)

    const plan = await prepareReplay({
      manifest: legacy,
      source: fakeSource('a'.repeat(64)),
      workspaceRoot: dir,
      cwd: dir,
    })
    expect(plan.fingerprintMatch).toBe(true)
    expect(plan.params.selective_color).toBeNull()
    expect(plan.params.contrast).toBe(5)
    expect(plan.params.raw_render_exposure).toBe(-0.2)
    expect(plan.exposure).toEqual(exposure)
  })

  it('reseals it without the neutral record, so only the manifest hash moves', () => {
    const legacy = explicitNeutralManifestFor()
    const current = manifestFor(parseRenderParams({ contrast: 5 }))
    expect(current.render_params.selective_color).toBeUndefined()
    expect(current.color_graph).toEqual(legacy.color_graph)
    expect(current.manifest_sha256).not.toBe(legacy.manifest_sha256)
    const { selective_color: _hsl, ...legacyRest } = legacy.render_params
    expect(current.render_params).toEqual(legacyRest)
  })

  it('still refuses a different native build before decoding', async () => {
    const recorded = resolveRenderEnvironment('desktop')
    const legacy = explicitNeutralManifestFor({
      environment: {
        ...recorded,
        native_artifacts: {
          ...recorded.native_artifacts,
          build_id: 'raw:111111111111+jpeg:222222222222',
        },
      },
    })
    const source = fakeSource('a'.repeat(64))
    const plan = await prepareReplay({
      manifest: legacy,
      source,
      workspaceRoot: dir,
      cwd: dir,
    })
    const raw = vi.fn(async () => {
      throw new Error('the RAW runtime must not be used')
    })
    await expect(
      runReplay({
        runtime: {
          memoryProfile: 'desktop',
          raw,
          jpeg: raw,
          dispose: vi.fn(),
        } as unknown as LmfgRuntime,
        plan,
        source,
        environment: recorded,
        manifestPath: join(dir, 'm.json'),
        sessionId: null,
        outputPath: join(dir, 'replay', 'output.jpg'),
        manifestOutputPath: join(dir, 'replay', 'manifest.json'),
      }),
    ).rejects.toMatchObject({
      code: 'replay.mismatch',
      details: {
        stage: 'environment',
        mismatched_fields: ['native_artifacts.build_id'],
      },
    })
    expect(raw).not.toHaveBeenCalled()
  })

  it('replays a recorded geometry beside the neutral record', async () => {
    const legacy = geometryManifestFor()
    const resealed = createRenderManifest({
      kind: 'export',
      source_raw: legacy.source_raw,
      lut: null,
      graph: requireSupportedGraph(
        buildColorGraph(parseRenderParams({ contrast: 5 }), null, exposure),
      ),
      render_params: {
        ...legacy.render_params,
        selective_color: explicitNeutral,
      },
      policy: legacy.policy,
      environment: legacy.environment,
      output: {
        ...legacy.output.dimensions,
        quality: legacy.output.quality,
        filename: legacy.output.filename,
        sha256: legacy.output.sha256,
      },
      parent_manifest_sha256: null,
    })
    expect(verifyManifestSha256(resealed)).toBe(true)
    const plan = await prepare(resealed)
    expect(plan.fingerprintMatch).toBe(true)
    expect(plan.params.selective_color).toBeNull()
  })
})

describe('replaying a sealed manifest that records out-of-schema params', () => {
  /**
   * Sealed with a valid sha256 and the fingerprint of the graph the recorded
   * values would build once clamped or neutralised, so neither the signature
   * nor the fingerprint gate stands between the values and the params schema.
   */
  function sealedWith(
    renderParams: Record<string, unknown>,
    graphParams: Parameters<typeof parseRenderParams>[0],
  ) {
    const manifest = manifestFor()
    const { manifest_sha256: _sha, ...unsealed } = manifest
    return createRenderManifest({
      kind: unsealed.kind,
      source_raw: unsealed.source_raw,
      lut: null,
      graph: requireSupportedGraph(
        buildColorGraph(parseRenderParams(graphParams), null, exposure),
      ),
      render_params: {
        ...unsealed.render_params,
        ...renderParams,
      } as RenderManifest['render_params'],
      policy: unsealed.policy,
      environment: unsealed.environment,
      output: {
        ...unsealed.output.dimensions,
        quality: unsealed.output.quality,
        filename: unsealed.output.filename,
        sha256: unsealed.output.sha256,
      },
      parent_manifest_sha256: null,
      produced_at: unsealed.produced_at,
    })
  }

  function schemaErrorOf(run: () => unknown): string | null {
    try {
      run()
    } catch (error) {
      return toLmfgError(error).code
    }
    return null
  }

  const cases: [string, Record<string, unknown>, Record<string, unknown>][] = [
    ['a string exposure_ev', { exposure_ev: '2' }, { contrast: 5 }],
    [
      'an out-of-range exposure_ev',
      { exposure_ev: 6 },
      { contrast: 5, exposure_ev: 5 },
    ],
    ['a string intensity', { intensity: '0.37' }, { contrast: 5 }],
    [
      'an out-of-range HSL axis',
      {
        selective_color: {
          ...toManifestRenderParams(
            parseRenderParams({ selective_color: { red: { hue: 100 } } }),
            exposure,
          ).selective_color,
          red: { hue: 101, saturation: 0, lightness: 0 },
        },
      },
      { contrast: 5, selective_color: { red: { hue: 100 } } },
    ],
    [
      'a string tone field',
      {
        tone_curve: {
          contrast: '10',
          highlights: 0,
          shadows: 0,
          whites: 0,
          blacks: 0,
        },
      },
      {},
    ],
  ]

  for (const [label, recorded, graphParams] of cases) {
    it(`refuses ${label} instead of replaying a normalised value`, async () => {
      const manifest = sealedWith(recorded, graphParams)
      expect(verifyManifestSha256(manifest)).toBe(true)
      expect(
        schemaErrorOf(() => manifestToRenderParams(manifest.render_params)),
      ).toBe('schema.invalid')
      const caught = await prepareReplay({
        manifest,
        source: fakeSource('a'.repeat(64)),
        workspaceRoot: dir,
        cwd: dir,
      }).then(
        () => null,
        (error: unknown) => error,
      )
      expect(caught).not.toBeNull()
      expect(toLmfgError(caught).code).toBe('schema.invalid')
    })
  }
})

describe('replaying a manifest read from disk', () => {
  type Json = Record<string, any>

  /** A JSON copy of a sealed manifest, edited and sealed again. */
  function resealed(manifest: RenderManifest, edit: (copy: Json) => void) {
    const copy = JSON.parse(JSON.stringify(manifest)) as Json
    edit(copy)
    copy.manifest_sha256 = computeManifestSha256(copy)
    return copy
  }

  async function readBack(manifest: unknown) {
    const path = join(dir, 'm.json')
    await writeFile(path, JSON.stringify(manifest))
    return requireVerifiedManifest(path, environment)
  }

  it('replays a current record that omits the optional decode budget', async () => {
    const recorded = manifestFor(parseRenderParams({}))
    const withoutBudget = resealed(recorded, (copy) => {
      delete copy.policy.max_pixels
    })
    const { manifest } = await readBack(withoutBudget)
    expect(manifest.manifest_sha256).toBe(withoutBudget.manifest_sha256)
    expect(manifest.policy.max_pixels).toBeUndefined()
    const plan = await prepareReplay({
      manifest,
      source: fakeSource('a'.repeat(64)),
      workspaceRoot: dir,
      cwd: dir,
    })
    expect(plan.fingerprintMatch).toBe(true)
    expect(plan.params).toEqual({
      ...parseRenderParams({}),
      raw_render_exposure: -0.2,
    })
    expect(plan.exposure).toEqual(exposure)
  })

  it.each<[string, (copy: Json) => void]>([
    ['a string decode budget', (copy) => (copy.policy.max_pixels = '8')],
    ['a string output quality', (copy) => (copy.output.quality = '85')],
    ['a string row slice', (copy) => (copy.policy.row_slice = '32')],
    [
      'string output dimensions',
      (copy) => (copy.output.dimensions = { width: '4', height: '2' }),
    ],
  ])(
    'refuses a resealed manifest with %s before a replay plan exists',
    async (_label, edit) => {
      const manifest = resealed(manifestFor(), edit)
      expect(verifyManifestSha256(manifest)).toBe(true)
      await expect(readBack(manifest)).rejects.toMatchObject({
        code: 'manifest.invalid',
      })
    },
  )
})

describe('replaying an explicit zero raw-render exposure', () => {
  it('keeps the recorded zero instead of re-resolving auto', async () => {
    const params = parseRenderParams({ raw_render_exposure: 0 })
    const zero = { ev: 0, multiplier: 1, source: 'user' as const }
    const manifest = createRenderManifest({
      kind: 'preview',
      source_raw: manifestFor().source_raw,
      lut: null,
      graph: requireSupportedGraph(buildColorGraph(params, null, zero)),
      render_params: toManifestRenderParams(params, zero),
      policy: manifestFor().policy,
      environment,
      output: {
        width: 4,
        height: 2,
        quality: 85,
        filename: 'p.jpg',
        sha256: 'b'.repeat(64),
      },
      parent_manifest_sha256: null,
    })
    expect(manifest.render_params).toMatchObject({
      raw_render_exposure_ev: 0,
      raw_render_exposure_source: 'user',
    })
    const plan = await prepareReplay({
      manifest,
      source: fakeSource('a'.repeat(64)),
      workspaceRoot: dir,
      cwd: dir,
    })
    expect(plan.params.raw_render_exposure).toBe(0)
    expect(plan.exposure).toEqual(zero)
    expect(plan.fingerprintMatch).toBe(true)
  })
})

describe('runReplay with a geometry', () => {
  const decoded = { width: 64, height: 48 }
  /** The rotation's constrained crop of the 64x48 frame. */
  const delivered = { width: 60, height: 45 }
  const readWindow = async (request: LumaRawProcessedWindowRequest) =>
    asymmetricProcessedWindow(request, decoded)

  /** A RAW runtime whose one session decodes `frame`; it never quick-decodes. */
  function fakeRuntime(frame = decoded) {
    const session = {
      probe: null,
      probeExportCapability: vi.fn(async () =>
        syntheticExportCapability(frame),
      ),
      beginProcessedWindowExport: vi.fn(async () => ({ active: true })),
      readProcessedWindow: vi.fn(readWindow),
      endProcessedWindowExport: vi.fn(async () => ({ ended: true as const })),
      dispose: vi.fn(),
    }
    const runtime = {
      memoryProfile: 'desktop',
      raw: async () => ({ openSession: async () => session }),
      jpeg: async () => {
        throw new Error('the export streams through its own JPEG runtime')
      },
      dispose: () => undefined,
    } as unknown as LmfgRuntime
    return { runtime, session }
  }

  /**
   * What the engine executor alone delivers for the decoded frame under a
   * literal geometry (or none), with no lmfg export adapter or replay mapping
   * in between.
   */
  function engineReference(geometry?: {
    matrix: number[]
    constrainCrop: boolean
  }) {
    return renderEngineExportReference({
      capability: syntheticExportCapability(decoded),
      graph: requireSupportedGraph(
        buildColorGraph(parseRenderParams({ contrast: 5 }), null, exposure),
      ),
      readProcessedWindow: readWindow,
      quality: 0.92,
      preferredRows: 256,
      ...(geometry ? { geometry } : {}),
    })
  }

  /** The SHA-256 the engine delivers under the committed rotation. */
  async function rotatedReferenceSha256() {
    const reference = await engineReference({
      matrix: ROTATED_MATRIX,
      constrainCrop: true,
    })
    expect(reference.frame).toEqual(delivered)
    return reference.sha256
  }

  async function replay(manifest: RenderManifest, runtime: LmfgRuntime) {
    const plan = await prepare(manifest)
    const outputPath = join(dir, 'replay', 'output.jpg')
    const manifestOutputPath = join(dir, 'replay', 'manifest.json')
    const outcome = runReplay({
      runtime,
      plan,
      source: fakeSource('a'.repeat(64)),
      environment,
      manifestPath: join(dir, 'm.json'),
      sessionId: null,
      outputPath,
      manifestOutputPath,
    })
    return { outcome, outputPath, manifestOutputPath }
  }

  it('reproduces the recorded frame and hash and records the same geometry', async () => {
    const referenceSha256 = await rotatedReferenceSha256()
    const manifest = geometryManifestFor({
      source: decoded,
      geometryOutput: delivered,
      outputSha256: referenceSha256,
    })
    const expected = manifest.output.dimensions
    expect(expected).toEqual(delivered)
    const { runtime } = fakeRuntime()
    const { outcome, outputPath, manifestOutputPath } = await replay(
      manifest,
      runtime,
    )
    const result = await outcome
    expect(result.reproduced).toBe(true)
    expect(result.actual_sha256).toBe(referenceSha256)
    expect(result.output).toMatchObject(delivered)
    const jpeg = await readFile(outputPath)
    expect(jpegFrameDimensions(jpeg)).toEqual(delivered)
    expect(sha256Hex(jpeg)).toBe(referenceSha256)
    const { manifest: written } = await requireVerifiedManifest(
      manifestOutputPath,
      environment,
    )
    expect(written.render_params.geometry).toEqual(
      manifest.render_params.geometry,
    )
    expect(written.output.dimensions).toEqual(expected)
    expect(written.source_raw).toEqual(manifest.source_raw)
    expect(written.color_graph).toEqual(manifest.color_graph)
    expect(written.parent_manifest_sha256).toBe(manifest.manifest_sha256)
  })

  // A replay that does not reproduce the recorded bytes is refused before
  // anything is published: its output is not the manifest's output, so
  // writing it (or a manifest describing it) under the replay name would
  // hand out an artifact the recorded manifest never proved.
  it('refuses an output hash it did not reproduce and publishes nothing', async () => {
    const manifest = geometryManifestFor({ source: decoded })
    const actualSha256 = await rotatedReferenceSha256()
    expect(actualSha256).not.toBe(manifest.output.sha256)
    const { runtime } = fakeRuntime()
    const { outcome, outputPath, manifestOutputPath } = await replay(
      manifest,
      runtime,
    )
    const error = await outcome.catch((caught: unknown) => caught)
    expect(error).toMatchObject({
      code: 'replay.mismatch',
      exitCode: 8,
      details: {
        stage: 'output',
        kind: 'export',
        reproduced: false,
        published: false,
        expected_sha256: 'b'.repeat(64),
        actual_sha256: actualSha256,
        expected: manifest.output.dimensions,
        actual: manifest.output.dimensions,
        parent_manifest_sha256: manifest.manifest_sha256,
      },
    })
    const details = (error as { details: Record<string, unknown> }).details
    expect(details).not.toHaveProperty('output')
    expect(details).not.toHaveProperty('manifest_uri')
    expect(details).not.toHaveProperty('cleanup_failures')
    expect(await fileExists(outputPath)).toBe(false)
    expect(await fileExists(manifestOutputPath)).toBe(false)
    expect(await entriesOf(join(dir, 'replay'))).toEqual([])
  })

  it('refuses an export without a geometry whose hash differs and publishes nothing', async () => {
    const first = await engineReference()
    expect(first.frame).toEqual(decoded)
    const manifest = geometryManifestFor({ source: decoded })
    const { geometry: _geometry, ...renderParams } = manifest.render_params
    const plain = createRenderManifest({
      kind: 'export',
      source_raw: manifest.source_raw,
      lut: null,
      graph: requireSupportedGraph(
        buildColorGraph(parseRenderParams({ contrast: 5 }), null, exposure),
      ),
      render_params: renderParams,
      policy: manifest.policy,
      environment,
      output: {
        ...decoded,
        quality: 92,
        filename: 'a_fullres.jpg',
        sha256: 'c'.repeat(64),
      },
      parent_manifest_sha256: null,
    })
    const { runtime } = fakeRuntime()
    const { outcome, outputPath, manifestOutputPath } = await replay(
      plain,
      runtime,
    )
    await expect(outcome).rejects.toMatchObject({
      code: 'replay.mismatch',
      exitCode: 8,
      details: {
        stage: 'output',
        published: false,
        expected_sha256: 'c'.repeat(64),
        actual_sha256: first.sha256,
        actual: decoded,
      },
    })
    expect(await fileExists(outputPath)).toBe(false)
    expect(await fileExists(manifestOutputPath)).toBe(false)
    expect(await entriesOf(join(dir, 'replay'))).toEqual([])
  })

  it('leaves an earlier replay byte for byte when an overwrite does not reproduce', async () => {
    const manifest = geometryManifestFor({ source: decoded })
    const outputPath = join(dir, 'replay', 'output.jpg')
    const manifestOutputPath = join(dir, 'replay', 'manifest.json')
    const earlier = await seedEarlierReplay(outputPath, manifestOutputPath)
    const { runtime } = fakeRuntime()
    const { outcome } = await replay(manifest, runtime)
    await expect(outcome).rejects.toMatchObject({
      code: 'replay.mismatch',
      details: { stage: 'output', published: false },
    })
    expect(await readFile(outputPath)).toEqual(earlier.jpeg)
    expect(await readFile(manifestOutputPath, 'utf8')).toBe(earlier.manifest)
    expect(await entriesOf(join(dir, 'replay'))).toEqual([
      'manifest.json',
      'output.jpg',
    ])
  })

  it('replaces an earlier replay when the overwrite reproduces the output', async () => {
    const manifest = geometryManifestFor({
      source: decoded,
      geometryOutput: delivered,
      outputSha256: await rotatedReferenceSha256(),
    })
    const outputPath = join(dir, 'replay', 'output.jpg')
    const manifestOutputPath = join(dir, 'replay', 'manifest.json')
    const earlier = await seedEarlierReplay(outputPath, manifestOutputPath)
    const { runtime } = fakeRuntime()
    const { outcome } = await replay(manifest, runtime)
    const result = await outcome
    expect(result.reproduced).toBe(true)
    expect(await readFile(outputPath)).not.toEqual(earlier.jpeg)
    const { manifest: written } = await requireVerifiedManifest(
      manifestOutputPath,
      environment,
    )
    expect(written.output.sha256).toBe(manifest.output.sha256)
    expect(written.parent_manifest_sha256).toBe(manifest.manifest_sha256)
  })

  it('keeps the output mismatch when the provisional export cannot be discarded', async () => {
    const actual = await vi.importActual<typeof import('./export')>('./export')
    vi.mocked(runFullResolutionExport).mockImplementationOnce(async (input) => {
      const exported = await actual.runFullResolutionExport(input)
      return {
        ...exported,
        discard: async () => {
          await exported.discard()
          throw new Error('disk detached')
        },
      }
    })
    const manifest = geometryManifestFor({ source: decoded })
    const { runtime } = fakeRuntime()
    const { outcome, outputPath, manifestOutputPath } = await replay(
      manifest,
      runtime,
    )
    await expect(outcome).rejects.toMatchObject({
      code: 'replay.mismatch',
      exitCode: 8,
      details: {
        stage: 'output',
        published: false,
        expected_sha256: 'b'.repeat(64),
        cleanup_failures: [{ step: 'remove_temp_file', code: 'internal' }],
      },
    })
    expect(await fileExists(outputPath)).toBe(false)
    expect(await fileExists(manifestOutputPath)).toBe(false)
  })

  it('refuses a decoded frame that differs from the recorded source before reading a window', async () => {
    const manifest = geometryManifestFor({ source: { width: 80, height: 60 } })
    const { runtime, session } = fakeRuntime(decoded)
    const { outcome } = await replay(manifest, runtime)
    await expect(outcome).rejects.toMatchObject({
      code: 'replay.mismatch',
      details: {
        stage: 'source-dimensions',
        expected: { width: 80, height: 60 },
        actual: decoded,
      },
    })
    expect(session.beginProcessedWindowExport).not.toHaveBeenCalled()
    expect(session.readProcessedWindow).not.toHaveBeenCalled()
    expect(session.dispose).toHaveBeenCalledTimes(1)
    expect(existsSync(join(dir, 'replay'))).toBe(false)
  })

  it('refuses a different native build before decoding', async () => {
    const recorded = resolveRenderEnvironment('desktop')
    const manifest = geometryManifestFor({
      source: decoded,
      environment: {
        ...recorded,
        native_artifacts: {
          ...recorded.native_artifacts,
          build_id: 'raw:111111111111+jpeg:222222222222',
        },
      },
    })
    const { runtime, session } = fakeRuntime()
    const { outcome } = await replay(manifest, runtime)
    await expect(outcome).rejects.toMatchObject({
      code: 'replay.mismatch',
      details: {
        stage: 'environment',
        mismatched_fields: ['native_artifacts.build_id'],
      },
    })
    expect(session.probeExportCapability).not.toHaveBeenCalled()
    expect(existsSync(join(dir, 'replay'))).toBe(false)
  })

  it('refuses a folding geometry in a hand-built plan before the RAW runtime runs', async () => {
    const manifest = geometryManifestFor({
      matrix: FOLDING_MATRIX,
      constrainCrop: false,
      geometryOutput: SENSOR,
    })
    const params = manifestToRenderParams(manifest.render_params)
    const plan: ReplayPlan = {
      manifest,
      params,
      exposure,
      lut: null,
      graph: requireSupportedGraph(buildColorGraph(params, null, exposure)),
      fingerprintMatch: true,
    }
    const runtime: LmfgRuntime = {
      memoryProfile: 'desktop',
      raw: vi.fn(async () => {
        throw new Error('the RAW runtime must not be used')
      }),
      jpeg: vi.fn(async () => {
        throw new Error('the JPEG runtime must not be used')
      }),
      dispose: vi.fn(),
    }
    const outputPath = join(dir, 'replay', 'output.jpg')
    const manifestOutputPath = join(dir, 'replay', 'manifest.json')
    await expect(
      runReplay({
        runtime,
        plan,
        source: fakeSource('a'.repeat(64)),
        environment,
        manifestPath: join(dir, 'm.json'),
        sessionId: null,
        outputPath,
        manifestOutputPath,
      }),
    ).rejects.toMatchObject({
      code: 'args.invalid',
      details: { stage: 'geometry' },
    })
    expect(runtime.raw).not.toHaveBeenCalled()
    expect(runtime.jpeg).not.toHaveBeenCalled()
    expect(await fileExists(outputPath)).toBe(false)
    expect(await fileExists(manifestOutputPath)).toBe(false)
  })
})

describe('runReplay of a preview or candidate', () => {
  let jpegRuntime: LmfgRuntime
  beforeEach(() => {
    jpegRuntime = createLmfgRuntime({ memoryProfile: 'desktop' })
  })
  afterEach(() => {
    jpegRuntime.dispose()
  })

  /** A RAW runtime that quick-decodes a 4x2 ramp; the JPEG encoder is real. */
  function previewRuntime(): LmfgRuntime {
    const frame = { width: 4, height: 2 }
    const data = new Uint16Array(frame.width * frame.height * 3)
    for (let index = 0; index < data.length; index += 1) {
      data[index] = (index * 2531) % 60000
    }
    const session = {
      probe: { width: frame.width, height: frame.height },
      probeExportCapability: async () => frame,
      decodeQuick: async () => ({ data, ...frame }),
      dispose: () => undefined,
    }
    return {
      memoryProfile: 'desktop',
      raw: async () =>
        ({ openSession: async () => session }) as unknown as Awaited<
          ReturnType<LmfgRuntime['raw']>
        >,
      jpeg: () => jpegRuntime.jpeg(),
      dispose: () => undefined,
    }
  }

  /** The SHA-256 a first render of the recorded params delivers. */
  async function renderedSha256() {
    const rendered = await renderPreview({
      runtime: previewRuntime(),
      source: fakeSource('a'.repeat(64)),
      params: parseRenderParams({ contrast: 5 }),
      lut: null,
      maxPixels: 8,
      quality: percentToQuality(85),
      exposure,
    })
    return rendered.rendered.sha256
  }

  async function replay(manifest: RenderManifest) {
    const source = fakeSource('a'.repeat(64))
    const plan = await prepareReplay({
      manifest,
      source,
      workspaceRoot: dir,
      cwd: dir,
    })
    const outputPath = join(dir, 'replay', 'output.jpg')
    const manifestOutputPath = join(dir, 'replay', 'manifest.json')
    const outcome = runReplay({
      runtime: previewRuntime(),
      plan,
      source,
      environment,
      manifestPath: join(dir, 'm.json'),
      sessionId: null,
      outputPath,
      manifestOutputPath,
    })
    return { outcome, outputPath, manifestOutputPath }
  }

  it.each(['preview', 'candidate'] as const)(
    'refuses a %s whose hash differs and leaves an earlier replay as it was',
    async (kind) => {
      const actualSha256 = await renderedSha256()
      const manifest = manifestFor(undefined, { kind })
      expect(actualSha256).not.toBe(manifest.output.sha256)
      const outputPath = join(dir, 'replay', 'output.jpg')
      const manifestOutputPath = join(dir, 'replay', 'manifest.json')
      const earlier = await seedEarlierReplay(outputPath, manifestOutputPath)
      const { outcome } = await replay(manifest)
      await expect(outcome).rejects.toMatchObject({
        code: 'replay.mismatch',
        exitCode: 8,
        details: {
          stage: 'output',
          kind,
          reproduced: false,
          published: false,
          expected_sha256: 'b'.repeat(64),
          actual_sha256: actualSha256,
          expected: { width: 4, height: 2 },
          actual: { width: 4, height: 2 },
        },
      })
      expect(await readFile(outputPath)).toEqual(earlier.jpeg)
      expect(await readFile(manifestOutputPath, 'utf8')).toBe(earlier.manifest)
      expect(await entriesOf(join(dir, 'replay'))).toEqual([
        'manifest.json',
        'output.jpg',
      ])
    },
  )

  it.each(['preview', 'candidate'] as const)(
    'refuses a %s whose hash differs without creating a replay',
    async (kind) => {
      const { outcome, outputPath, manifestOutputPath } = await replay(
        manifestFor(undefined, { kind }),
      )
      await expect(outcome).rejects.toMatchObject({
        code: 'replay.mismatch',
        details: { stage: 'output', published: false },
      })
      expect(await fileExists(outputPath)).toBe(false)
      expect(await fileExists(manifestOutputPath)).toBe(false)
      expect(await entriesOf(join(dir, 'replay'))).toEqual([])
    },
  )

  it.each(['preview', 'candidate'] as const)(
    'publishes a %s it reproduced',
    async (kind) => {
      const manifest = manifestFor(undefined, {
        kind,
        outputSha256: await renderedSha256(),
      })
      const { outcome, outputPath, manifestOutputPath } = await replay(manifest)
      const result = await outcome
      expect(result.reproduced).toBe(true)
      expect(result.actual_sha256).toBe(manifest.output.sha256)
      expect(await fileExists(outputPath)).toBe(true)
      const { manifest: written } = await requireVerifiedManifest(
        manifestOutputPath,
        environment,
      )
      expect(written.kind).toBe(kind)
      expect(written.output.sha256).toBe(manifest.output.sha256)
    },
  )
})

describe('runReplay environment gate', () => {
  const recorded: RenderEnvironment = {
    render_engine: '0.1.0',
    luma_color_runtime: '0.1.0',
    luma_raw_runtime: '0.1.2',
    luma_jpeg_runtime: '0.1.0',
    native_artifacts: {
      build_id: 'raw:111111111111+jpeg:222222222222',
      variant: 'desktop',
    },
  }

  function withNative(
    base: RenderEnvironment,
    native: Partial<RenderEnvironment['native_artifacts']>,
  ): RenderEnvironment {
    return {
      ...base,
      native_artifacts: { ...base.native_artifacts, ...native },
    }
  }

  /** A runtime that records any attempt to decode or encode. */
  function recordingRuntime() {
    const calls: string[] = []
    const runtime: LmfgRuntime = {
      memoryProfile: 'desktop',
      raw: () => {
        calls.push('raw')
        return Promise.reject(new Error('decode started'))
      },
      jpeg: () => {
        calls.push('jpeg')
        return Promise.reject(new Error('encode started'))
      },
      dispose: () => undefined,
    }
    return { runtime, calls }
  }

  async function replayAgainst(
    manifest: RenderManifest,
    current: RenderEnvironment,
  ) {
    const source = fakeSource('a'.repeat(64))
    const plan = await prepareReplay({
      manifest,
      source,
      workspaceRoot: dir,
      cwd: dir,
    })
    const { runtime, calls } = recordingRuntime()
    const replayDir = join(dir, 'replay')
    const outcome = runReplay({
      runtime,
      plan,
      source,
      environment: current,
      manifestPath: join(dir, 'm.json'),
      sessionId: null,
      outputPath: join(replayDir, 'output.jpg'),
      manifestOutputPath: join(replayDir, 'manifest.json'),
    })
    return { outcome, calls, replayDir }
  }

  it.each(['preview', 'export'] as const)(
    'refuses a %s manifest from a different native build before decoding',
    async (kind) => {
      const current = withNative(recorded, {
        build_id: 'raw:333333333333+jpeg:222222222222',
      })
      const { outcome, calls, replayDir } = await replayAgainst(
        manifestFor(undefined, { kind, environment: recorded }),
        current,
      )
      await expect(outcome).rejects.toMatchObject({
        code: 'replay.mismatch',
        exitCode: 8,
        details: {
          stage: 'environment',
          mismatched_fields: ['native_artifacts.build_id'],
          expected: {
            luma_raw_runtime: '0.1.2',
            native_artifacts: {
              build_id: 'raw:111111111111+jpeg:222222222222',
              variant: 'desktop',
            },
          },
          actual: {
            luma_raw_runtime: '0.1.2',
            native_artifacts: {
              build_id: 'raw:333333333333+jpeg:222222222222',
              variant: 'desktop',
            },
          },
        },
      })
      expect(calls).toEqual([])
      expect(existsSync(replayDir)).toBe(false)
    },
  )

  it('refuses a manifest whose native build is unknown', async () => {
    const { outcome, calls, replayDir } = await replayAgainst(
      manifestFor(undefined, {
        environment: withNative(recorded, { build_id: 'unknown' }),
      }),
      recorded,
    )
    await expect(outcome).rejects.toMatchObject({
      code: 'replay.mismatch',
      message: expect.stringMatching(
        /native_artifacts\.build_id: manifest unknown, current raw:111111111111\+jpeg:222222222222/,
      ),
      details: {
        stage: 'environment',
        mismatched_fields: ['native_artifacts.build_id'],
        expected: { native_artifacts: { build_id: 'unknown' } },
      },
    })
    expect(calls).toEqual([])
    expect(existsSync(replayDir)).toBe(false)
  })

  it('refuses when the current native artifacts are unknown', async () => {
    const { outcome, calls } = await replayAgainst(
      manifestFor(undefined, { environment: recorded }),
      withNative(recorded, { build_id: 'unknown' }),
    )
    await expect(outcome).rejects.toMatchObject({
      code: 'replay.mismatch',
      details: {
        stage: 'environment',
        mismatched_fields: ['native_artifacts.build_id'],
        actual: { native_artifacts: { build_id: 'unknown' } },
      },
    })
    expect(calls).toEqual([])
  })

  it('refuses a different luma-raw-runtime version', async () => {
    const { outcome, calls } = await replayAgainst(
      manifestFor(undefined, { environment: recorded }),
      { ...recorded, luma_raw_runtime: '0.1.3' },
    )
    await expect(outcome).rejects.toMatchObject({
      code: 'replay.mismatch',
      details: {
        stage: 'environment',
        mismatched_fields: ['luma_raw_runtime'],
        expected: { luma_raw_runtime: '0.1.2' },
        actual: { luma_raw_runtime: '0.1.3' },
      },
    })
    expect(calls).toEqual([])
  })

  it('refuses a different native variant and points at the recorded memory profile', async () => {
    const { outcome, calls } = await replayAgainst(
      manifestFor(undefined, {
        environment: withNative(recorded, { variant: 'low-memory' }),
      }),
      recorded,
    )
    await expect(outcome).rejects.toMatchObject({
      code: 'replay.mismatch',
      suggestedNextActions: expect.arrayContaining([
        expect.stringContaining('--memory-profile low-memory'),
      ]),
      details: {
        stage: 'environment',
        mismatched_fields: ['native_artifacts.variant'],
      },
    })
    expect(calls).toEqual([])
  })

  it('refuses a manifest that does not record the RAW environment', async () => {
    const manifest = manifestFor(undefined, { environment: recorded })
    const legacy = {
      ...manifest,
      environment: { render_engine: '0.1.0' },
    } as unknown as RenderManifest
    const { outcome, calls } = await replayAgainst(legacy, recorded)
    await expect(outcome).rejects.toMatchObject({
      code: 'replay.mismatch',
      details: {
        stage: 'environment',
        mismatched_fields: [
          'luma_raw_runtime',
          'native_artifacts.build_id',
          'native_artifacts.variant',
        ],
        expected: {
          luma_raw_runtime: null,
          native_artifacts: { build_id: null, variant: null },
        },
      },
    })
    expect(calls).toEqual([])
  })

  it('lets a matching environment through to the decode', async () => {
    const { outcome, calls } = await replayAgainst(
      manifestFor(undefined, { environment: recorded }),
      { ...recorded, render_engine: '9.9.9', luma_jpeg_runtime: '9.9.9' },
    )
    await expect(outcome).rejects.toThrow('decode started')
    expect(calls).toEqual(['raw'])
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
