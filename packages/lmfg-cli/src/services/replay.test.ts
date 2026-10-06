// @vitest-environment node
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type {
  RenderEnvironment,
  RenderManifest,
  RenderManifestKind,
} from '@lumaforge/render-engine'
import {
  createRenderManifest,
  verifyManifestSha256,
} from '@lumaforge/render-engine'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { LmfgRuntime } from '../runtime/node-runtime'
import { createLmfgRuntime } from '../runtime/node-runtime'
import { loadSourceFile } from '../runtime/source-loader'
import { resolveRenderEnvironment } from '../runtime/versions'
import { parseRenderParams } from '../schemas/params'
import {
  describeWithFixture,
  FIXTURE_PATH,
} from '../test-support/describe-with-fixture'
import { fileExists } from '../workspace/atomic-fs'
import {
  buildColorGraph,
  manifestToRenderParams,
  requireSupportedGraph,
  toManifestRenderParams,
} from './color-graph'
import { buildRenderManifest, requireVerifiedManifest } from './manifest'
import { renderPreview } from './preview'
import type { ReplayPlan } from './replay'
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

function manifestFor(
  params = parseRenderParams({ contrast: 5 }),
  options: { kind?: RenderManifestKind; environment?: RenderEnvironment } = {},
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
      sha256: 'b'.repeat(64),
    },
    parentManifestSha256: null,
  })
}

/**
 * A sealed export manifest shaped like the one the browser writes for a
 * committed geometry: the matrix and cropped output frame sit beside the color
 * params, outside the color graph.
 */
function geometryManifestFor(params = parseRenderParams({ contrast: 5 })) {
  const output = { width: 3900, height: 2900 }
  return createRenderManifest({
    kind: 'export',
    source_raw: {
      sha256: 'a'.repeat(64),
      byte_size: 1,
      filename: 'a.dng',
      decoded_dimensions: { width: 4032, height: 3024 },
    },
    lut: null,
    graph: requireSupportedGraph(buildColorGraph(params, null, exposure)),
    render_params: {
      ...toManifestRenderParams(params, exposure),
      geometry: {
        matrix: [0.99, -0.04, 0.02, 0.04, 0.99, -0.01, 0, 0, 1],
        constrain_crop: true,
        output,
      },
    },
    policy: { kind: 'export-full', row_slice: 256, concurrency: 1 },
    environment,
    output: {
      ...output,
      quality: 92,
      filename: 'a_fullres.jpg',
      sha256: 'b'.repeat(64),
    },
    parent_manifest_sha256: null,
  })
}

const geometryRefusal = {
  code: 'args.invalid',
  exitCode: 2,
  message: expect.stringContaining('geometry'),
  details: { unsupported: 'render_params.geometry' },
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

  it('refuses a sealed manifest that records a geometry', async () => {
    const manifest = geometryManifestFor()
    // The manifest is otherwise replayable: sealed, and its color graph
    // rebuilds to the recorded fingerprint.
    expect(verifyManifestSha256(manifest)).toBe(true)
    await expect(
      prepareReplay({
        manifest,
        source: fakeSource('a'.repeat(64)),
        workspaceRoot: dir,
        cwd: dir,
      }),
    ).rejects.toMatchObject(geometryRefusal)
  })

  it('refuses a geometry even when the descriptor version skips the fingerprint gate', async () => {
    const manifest = geometryManifestFor()
    const legacy = {
      ...manifest,
      color_graph: {
        fingerprint: 'f'.repeat(64),
        descriptor: { descriptor_version: 1 },
      },
    }
    await expect(
      prepareReplay({
        manifest: legacy,
        source: fakeSource('a'.repeat(64)),
        workspaceRoot: dir,
        cwd: dir,
      }),
    ).rejects.toMatchObject(geometryRefusal)
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

  it('verifies it as written, then rebuilds the same color graph', async () => {
    const legacy = explicitNeutralManifestFor()
    const path = join(dir, 'legacy.json')
    await writeFile(path, JSON.stringify(legacy))
    const { manifest } = await requireVerifiedManifest(path, environment)
    expect(manifest.render_params.selective_color).toEqual(explicitNeutral)

    const plan = await prepareReplay({
      manifest,
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

  it('still refuses a recorded geometry', async () => {
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
    await expect(
      prepareReplay({
        manifest: resealed,
        source: fakeSource('a'.repeat(64)),
        workspaceRoot: dir,
        cwd: dir,
      }),
    ).rejects.toMatchObject(geometryRefusal)
  })
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
  it('refuses before the RAW runtime runs or any output is written', async () => {
    const manifest = geometryManifestFor()
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
    ).rejects.toMatchObject(geometryRefusal)
    expect(runtime.raw).not.toHaveBeenCalled()
    expect(runtime.jpeg).not.toHaveBeenCalled()
    expect(await fileExists(outputPath)).toBe(false)
    expect(await fileExists(manifestOutputPath)).toBe(false)
  })
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
