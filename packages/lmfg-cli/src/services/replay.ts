import type {
  RawRenderExposure,
  SupportedExportColorGraphDescriptor,
} from '@lumaforge/luma-color-runtime'
import type {
  RenderEnvironment,
  RenderManifest,
} from '@lumaforge/render-engine'

import { LmfgError } from '../protocol/errors'
import type { LmfgRuntime } from '../runtime/node-runtime'
import type { LoadedSource } from '../runtime/source-loader'
import type { RenderParams } from '../schemas/params'
import type { ReplayResult } from '../schemas/results'
import {
  fileExists,
  writeFileAtomic,
  writeJsonAtomic,
} from '../workspace/atomic-fs'
import { toFileUri, workspacePaths } from '../workspace/paths'
import {
  buildColorGraph,
  COLOR_GRAPH_DESCRIPTOR_VERSION,
  describeColorGraph,
  fingerprintColorGraph,
  manifestToRenderParams,
  requireSupportedGraph,
} from './color-graph'
import { exposureFromManifest, runFullResolutionExport } from './export'
import type { EffectiveLutRanges, ResolvedLut } from './lut'
import {
  contractInputFromIdentity,
  loadLutFile,
  resolveLutContract,
} from './lut'
import { buildRenderManifest, percentToQuality } from './manifest'
import { renderPreview } from './preview'

export type ReplayPlan = {
  manifest: RenderManifest
  params: RenderParams
  exposure: RawRenderExposure
  lut: ResolvedLut | null
  graph: SupportedExportColorGraphDescriptor
  /** `null` when the manifest was written with a different descriptor version. */
  fingerprintMatch: boolean | null
}

export function replayKey(manifest: RenderManifest): string {
  return manifest.manifest_sha256.slice(0, 12)
}

/**
 * The descriptor records the ranges the graph actually applied; browser
 * manifests may record `'unknown'` in the identity when the user left a
 * range unspecified, and replay must not guess a different one.
 */
function effectiveLutRangesFromManifest(
  manifest: RenderManifest,
): EffectiveLutRanges {
  if (descriptorVersionOf(manifest) !== COLOR_GRAPH_DESCRIPTOR_VERSION) {
    return {}
  }
  const descriptor = manifest.color_graph.descriptor as {
    lut_profile?: {
      input?: { range?: unknown }
      output?: { range?: unknown }
    } | null
  }
  const profile = descriptor.lut_profile
  return {
    input_range:
      typeof profile?.input?.range === 'string'
        ? profile.input.range
        : undefined,
    output_range:
      typeof profile?.output?.range === 'string'
        ? profile.output.range
        : undefined,
  }
}

function descriptorVersionOf(manifest: RenderManifest): number | null {
  const descriptor = manifest.color_graph.descriptor
  if (
    descriptor &&
    typeof descriptor === 'object' &&
    'descriptor_version' in descriptor
  ) {
    const version = (descriptor as { descriptor_version?: unknown })
      .descriptor_version
    return typeof version === 'number' ? version : null
  }
  return null
}

export async function prepareReplay(input: {
  manifest: RenderManifest
  source: LoadedSource
  lutPath?: string
  workspaceRoot: string
  cwd: string
}): Promise<ReplayPlan> {
  const { manifest, source } = input
  if (source.sha256 !== manifest.source_raw.sha256) {
    throw new LmfgError('hash.mismatch', {
      message: `Source ${source.filename} does not match the manifest (expected sha256 ${manifest.source_raw.sha256.slice(0, 12)}…, got ${source.sha256.slice(0, 12)}…).`,
      details: {
        expected_sha256: manifest.source_raw.sha256,
        actual_sha256: source.sha256,
      },
    })
  }

  let lut: ResolvedLut | null = null
  if (manifest.lut) {
    if (manifest.lut.kind !== 'local-file') {
      throw new LmfgError('args.invalid', {
        message: `Replaying ${manifest.lut.kind} LUT identities is not supported; only local-file LUTs can be replayed.`,
      })
    }
    const lutPath =
      input.lutPath ??
      workspacePaths.lutCacheFile(input.workspaceRoot, manifest.lut.sha256)
    if (!(await fileExists(lutPath))) {
      throw new LmfgError('file.not_found', {
        message: `LUT ${manifest.lut.filename} (sha256 ${manifest.lut.sha256.slice(0, 12)}…) was not found at ${lutPath}; pass --lut <file> or fetch it into the workspace cache.`,
        suggestedNextActions: [
          `lmfg lut fetch --url <url> --sha256 ${manifest.lut.sha256} --allow-network`,
        ],
      })
    }
    const loaded = await loadLutFile(lutPath, input.cwd)
    if (loaded.sha256 !== manifest.lut.sha256) {
      throw new LmfgError('hash.mismatch', {
        message: `LUT ${loaded.filename} does not match the manifest (expected sha256 ${manifest.lut.sha256.slice(0, 12)}…, got ${loaded.sha256.slice(0, 12)}…).`,
        details: {
          expected_sha256: manifest.lut.sha256,
          actual_sha256: loaded.sha256,
        },
      })
    }
    lut = resolveLutContract(
      loaded,
      contractInputFromIdentity(
        manifest.lut,
        effectiveLutRangesFromManifest(manifest),
      ),
    )
  }

  const params = manifestToRenderParams(manifest.render_params)
  const exposure = exposureFromManifest(manifest)
  if (!exposure) {
    throw new LmfgError('args.invalid', {
      message:
        'The manifest does not record raw_render_exposure_ev; it cannot be replayed.',
    })
  }
  const graph = requireSupportedGraph(
    buildColorGraph(params, lut?.lutData ?? null, exposure),
  )
  const descriptor = describeColorGraph(graph)
  const fingerprint = fingerprintColorGraph(descriptor)
  let fingerprintMatch: boolean | null = null
  if (descriptorVersionOf(manifest) === COLOR_GRAPH_DESCRIPTOR_VERSION) {
    fingerprintMatch = fingerprint === manifest.color_graph.fingerprint
    if (!fingerprintMatch) {
      throw new LmfgError('replay.mismatch', {
        message:
          'The rebuilt color graph does not match the manifest fingerprint; the runtime or LUT contract has drifted.',
        details: {
          stage: 'color-graph',
          expected_fingerprint: manifest.color_graph.fingerprint,
          actual_fingerprint: fingerprint,
        },
      })
    }
  }
  return { manifest, params, exposure, lut, graph, fingerprintMatch }
}

export type ReplayRunInput = {
  runtime: LmfgRuntime
  plan: ReplayPlan
  source: LoadedSource
  environment: RenderEnvironment
  manifestPath: string
  sessionId: string | null
  outputPath: string
  manifestOutputPath: string
  signal?: AbortSignal
  onProgress?: (progress: {
    completedStrips: number
    totalStrips: number
    progress: number
  }) => void
}

export async function runReplay(input: ReplayRunInput): Promise<ReplayResult> {
  const { plan, manifest } = { plan: input.plan, manifest: input.plan.manifest }
  const timings: Record<string, number> = {}
  const total = performance.now()
  let jpeg: Uint8Array | null = null
  let publish: (() => Promise<void>) | null = null
  let discard: (() => Promise<void>) | null = null
  let byteLength: number
  let sha256: string
  let width: number
  let height: number
  let graph: SupportedExportColorGraphDescriptor
  const quality = manifest.output.quality

  if (manifest.kind === 'export') {
    const result = await runFullResolutionExport({
      runtime: input.runtime,
      source: input.source,
      params: plan.params,
      lut: plan.lut,
      exposure: plan.exposure,
      quality,
      outputPath: input.outputPath,
      preferredRows: manifest.policy.row_slice,
      signal: input.signal,
      onProgress: input.onProgress,
    })
    ;({ byteLength, sha256, width, height, graph } = result)
    publish = result.commit
    discard = result.discard
    Object.assign(timings, result.timings)
  } else {
    const maxPixels =
      manifest.policy.max_pixels ??
      manifest.output.dimensions.width * manifest.output.dimensions.height
    const result = await renderPreview({
      runtime: input.runtime,
      source: input.source,
      params: plan.params,
      lut: plan.lut,
      maxPixels,
      quality: percentToQuality(quality),
      exposure: plan.exposure,
      signal: input.signal,
    })
    jpeg = result.rendered.jpeg
    byteLength = jpeg.byteLength
    sha256 = result.rendered.sha256
    width = result.frame.width
    height = result.frame.height
    graph = result.graph
    Object.assign(timings, result.timings)
  }

  const expectedDims = manifest.output.dimensions
  if (width !== expectedDims.width || height !== expectedDims.height) {
    await discard?.()
    throw new LmfgError('replay.mismatch', {
      message: `Replay produced ${width}x${height} but the manifest recorded ${expectedDims.width}x${expectedDims.height}.`,
      details: {
        stage: 'dimensions',
        expected: expectedDims,
        actual: { width, height },
      },
    })
  }

  const replayManifest = buildRenderManifest({
    kind: manifest.kind,
    source: manifest.source_raw,
    lut: plan.lut?.identity ?? null,
    graph,
    params: plan.params,
    exposure: plan.exposure,
    policy: manifest.policy,
    environment: input.environment,
    output: { width, height, quality, filename: 'output.jpg', sha256 },
    parentManifestSha256: manifest.manifest_sha256,
  })
  if (publish) await publish()
  else if (jpeg) await writeFileAtomic(input.outputPath, jpeg)
  await writeJsonAtomic(input.manifestOutputPath, replayManifest)
  timings.total_ms = performance.now() - total

  const result: ReplayResult = {
    session_id: input.sessionId,
    manifest_path: input.manifestPath,
    kind: manifest.kind,
    reproduced: sha256 === manifest.output.sha256,
    expected_sha256: manifest.output.sha256,
    actual_sha256: sha256,
    fingerprint_match: plan.fingerprintMatch,
    output: {
      uri: toFileUri(input.outputPath),
      path: input.outputPath,
      width,
      height,
      byte_size: byteLength,
      sha256,
      quality,
    },
    manifest_uri: toFileUri(input.manifestOutputPath),
    manifest_sha256: replayManifest.manifest_sha256,
    parent_manifest_sha256: manifest.manifest_sha256,
    timings_ms: timings,
  }
  if (!result.reproduced) {
    throw new LmfgError('replay.mismatch', {
      message: `Replay output sha256 ${sha256.slice(0, 12)}… differs from the manifest (${manifest.output.sha256.slice(0, 12)}…); the artifacts were kept for inspection.`,
      details: { stage: 'output', ...result },
    })
  }
  return result
}
