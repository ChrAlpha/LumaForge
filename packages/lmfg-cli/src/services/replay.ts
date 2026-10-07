import type {
  RawRenderExposure,
  SupportedExportColorGraphDescriptor,
} from '@lumaforge/luma-color-runtime'
import type {
  GeometryParams,
  RenderEnvironment,
  RenderManifest,
} from '@lumaforge/render-engine'
import { createRenderManifest } from '@lumaforge/render-engine'
import type { ExportGeometry } from '@lumaforge/render-engine/export'
import {
  INVALID_EXPORT_GEOMETRY,
  planExportGeometry,
} from '@lumaforge/render-engine/export'

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
  toManifestRenderParams,
} from './color-graph'
import type { ExportFrame } from './export'
import { exposureFromManifest, runFullResolutionExport } from './export'
import type { EffectiveLutRanges, ResolvedLut } from './lut'
import {
  contractInputFromIdentity,
  loadLutFile,
  resolveLutContract,
} from './lut'
import { percentToQuality } from './manifest'
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

type Dimensions = { width: number; height: number }

/** What an export manifest says the replay must read, apply, and deliver. */
type ReplayExportFrame = ExportFrame & { geometry: ExportGeometry | null }

function sameDimensions(a: Dimensions, b: Dimensions): boolean {
  return a.width === b.width && a.height === b.height
}

function dimensionsOf(value: Dimensions): Dimensions {
  return { width: value.width, height: value.height }
}

/**
 * Only full-resolution exports apply a geometry; preview and candidate
 * replays render the decoded frame, so a manifest of those kinds that records
 * one is refused rather than replayed without it.
 */
function refuseUnsupportedGeometry(manifest: RenderManifest): void {
  if (manifest.kind === 'export') return
  if (manifest.render_params.geometry === undefined) return
  throw new LmfgError('args.invalid', {
    message: `A ${manifest.kind} manifest that records a geometry (render_params.geometry) cannot be replayed; only full-resolution exports apply a geometry, and this replay would drop the recorded crop, rotation, and perspective.`,
    details: { stage: 'geometry', unsupported: 'render_params.geometry' },
    suggestedNextActions: ['lmfg manifest verify <manifest.json>'],
  })
}

/**
 * The frame an export replay must deliver, checked from the manifest alone
 * before anything is decoded: the engine's geometry planner, run on the
 * recorded source frame, must produce the recorded geometry output, and the
 * recorded output must be that frame (the decoded frame when there is no
 * geometry). A geometry the planner refuses (one that folds the frame or
 * retains too little of it) is refused here.
 */
function requireExportFrame(manifest: RenderManifest): ReplayExportFrame {
  const source = dimensionsOf(manifest.source_raw.decoded_dimensions)
  const recorded = manifest.render_params.geometry
  let geometry: ExportGeometry | null = null
  let delivered = source
  if (recorded) {
    geometry = {
      matrix: [...recorded.matrix],
      constrainCrop: recorded.constrain_crop,
    }
    try {
      const planned = planExportGeometry(geometry, source)
      delivered = { width: planned.outputWidth, height: planned.outputHeight }
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.message !== INVALID_EXPORT_GEOMETRY
      )
        throw error
      throw new LmfgError('args.invalid', {
        message: `The recorded geometry cannot be exported from the recorded ${source.width}x${source.height} source frame: it folds the frame or retains too little of it.`,
        details: { stage: 'geometry', source },
        suggestedNextActions: ['lmfg manifest verify <manifest.json>'],
      })
    }
    if (!sameDimensions(recorded.output, delivered)) {
      throw new LmfgError('replay.mismatch', {
        message: `The recorded geometry output ${recorded.output.width}x${recorded.output.height} is not the ${delivered.width}x${delivered.height} frame the geometry plans from the recorded ${source.width}x${source.height} source.`,
        details: {
          stage: 'geometry',
          source,
          expected: dimensionsOf(recorded.output),
          actual: delivered,
        },
      })
    }
  }
  const output = dimensionsOf(manifest.output.dimensions)
  if (!sameDimensions(output, delivered)) {
    throw new LmfgError('replay.mismatch', {
      message: `The manifest records a ${output.width}x${output.height} output, but its ${recorded ? 'geometry' : 'source'} delivers ${delivered.width}x${delivered.height}.`,
      details: { stage: 'dimensions', expected: output, actual: delivered },
    })
  }
  return { source, output, geometry }
}

/**
 * Holds the probed decode to the recorded frame before any window is read:
 * a different decoded size would frame different pixels under the same
 * geometry.
 */
function requireDecodedFrame(
  expected: ReplayExportFrame,
  actual: ExportFrame,
): void {
  if (!sameDimensions(actual.source, expected.source)) {
    throw new LmfgError('replay.mismatch', {
      message: `This install decodes the source at ${actual.source.width}x${actual.source.height}, but the manifest recorded ${expected.source.width}x${expected.source.height}; replay refused before reading any pixels.`,
      details: {
        stage: 'source-dimensions',
        expected: expected.source,
        actual: actual.source,
      },
    })
  }
  if (!sameDimensions(actual.output, expected.output)) {
    throw new LmfgError('replay.mismatch', {
      message: `This export would deliver ${actual.output.width}x${actual.output.height}, but the manifest recorded ${expected.output.width}x${expected.output.height}; replay refused before reading any pixels.`,
      details: {
        stage: 'dimensions',
        expected: expected.output,
        actual: actual.output,
      },
    })
  }
}

function recordedGeometry(
  frame: ReplayExportFrame | null,
): GeometryParams | null {
  if (!frame?.geometry) return null
  return {
    matrix: frame.geometry.matrix,
    constrain_crop: frame.geometry.constrainCrop,
    output: frame.output,
  }
}

export async function prepareReplay(input: {
  manifest: RenderManifest
  source: LoadedSource
  lutPath?: string
  workspaceRoot: string
  cwd: string
}): Promise<ReplayPlan> {
  const { manifest, source } = input
  refuseUnsupportedGeometry(manifest)
  if (manifest.kind === 'export') requireExportFrame(manifest)
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

type ReplayEnvironmentField =
  | 'luma_raw_runtime'
  | 'native_artifacts.build_id'
  | 'native_artifacts.variant'

type ReplayEnvironment = Record<ReplayEnvironmentField, string | null>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function recordedString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** Reads defensively: a verified manifest is not schema-checked field by field. */
function replayEnvironmentOf(environment: unknown): ReplayEnvironment {
  const recorded = isRecord(environment) ? environment : {}
  const native = isRecord(recorded.native_artifacts)
    ? recorded.native_artifacts
    : {}
  return {
    luma_raw_runtime: recordedString(recorded.luma_raw_runtime),
    'native_artifacts.build_id': recordedString(native.build_id),
    'native_artifacts.variant': recordedString(native.variant),
  }
}

function environmentDetails(environment: ReplayEnvironment) {
  return {
    luma_raw_runtime: environment.luma_raw_runtime,
    native_artifacts: {
      build_id: environment['native_artifacts.build_id'],
      variant: environment['native_artifacts.variant'],
    },
  }
}

function isKnown(value: string | null): value is string {
  return value !== null && value !== 'unknown'
}

/**
 * The RAW decode belongs to the luma-raw-runtime version and the native
 * build and variant; the color-graph fingerprint does not cover it. Replay
 * refuses before decoding unless the manifest and this install record the
 * same known values, so a different build never renders or publishes output
 * it cannot reproduce. Other environment drift still surfaces through the
 * output SHA-256 check.
 */
function requireReplayEnvironment(
  manifest: RenderManifest,
  environment: RenderEnvironment,
): void {
  const expected = replayEnvironmentOf(manifest.environment)
  const actual = replayEnvironmentOf(environment)
  const fields = Object.keys(expected) as ReplayEnvironmentField[]
  const mismatched = fields.filter(
    (field) =>
      !isKnown(expected[field]) ||
      !isKnown(actual[field]) ||
      expected[field] !== actual[field],
  )
  if (mismatched.length === 0) return

  const shown = (value: string | null) => value ?? 'not recorded'
  const differences = mismatched
    .map(
      (field) =>
        `${field}: manifest ${shown(expected[field])}, current ${shown(actual[field])}`,
    )
    .join('; ')
  const recordedVariant = expected['native_artifacts.variant']
  const suggestedNextActions: string[] = []
  if (
    mismatched.includes('native_artifacts.variant') &&
    (recordedVariant === 'desktop' || recordedVariant === 'low-memory')
  ) {
    suggestedNextActions.push(
      `Re-run the replay with --memory-profile ${recordedVariant}.`,
    )
  }
  if (
    isKnown(expected.luma_raw_runtime) &&
    isKnown(expected['native_artifacts.build_id'])
  ) {
    suggestedNextActions.push(
      `Replay with an lmfg install that has luma-raw-runtime ${expected.luma_raw_runtime} and native build ${expected['native_artifacts.build_id']}.`,
    )
  }
  throw new LmfgError('replay.mismatch', {
    message: `Replay refused before decoding: the manifest's RAW runtime environment differs from this install (${differences}). Reproducing a manifest needs the luma-raw-runtime version and native build it was rendered with.`,
    suggestedNextActions,
    details: {
      stage: 'environment',
      mismatched_fields: mismatched,
      expected: environmentDetails(expected),
      actual: environmentDetails(actual),
    },
  })
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
  refuseUnsupportedGeometry(manifest)
  const exportFrame =
    manifest.kind === 'export' ? requireExportFrame(manifest) : null
  requireReplayEnvironment(manifest, input.environment)
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

  if (exportFrame) {
    const result = await runFullResolutionExport({
      runtime: input.runtime,
      source: input.source,
      params: plan.params,
      lut: plan.lut,
      exposure: plan.exposure,
      quality,
      outputPath: input.outputPath,
      preferredRows: manifest.policy.row_slice,
      ...(exportFrame.geometry ? { geometry: exportFrame.geometry } : {}),
      verifyFrame: (frame) => requireDecodedFrame(exportFrame, frame),
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

  // The replay records the geometry it applied, so its manifest replays too.
  const renderParams = toManifestRenderParams(plan.params, plan.exposure)
  const geometry = recordedGeometry(exportFrame)
  const replayManifest = createRenderManifest({
    kind: manifest.kind,
    source_raw: manifest.source_raw,
    lut: plan.lut?.identity ?? null,
    graph,
    render_params: geometry ? { ...renderParams, geometry } : renderParams,
    policy: manifest.policy,
    environment: input.environment,
    output: { width, height, quality, filename: 'output.jpg', sha256 },
    parent_manifest_sha256: manifest.manifest_sha256,
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
