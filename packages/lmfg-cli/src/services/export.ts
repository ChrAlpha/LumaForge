import type {
  RawRenderExposure,
  SupportedExportColorGraphDescriptor,
} from '@lumaforge/luma-color-runtime'
import { exposureMultiplierFromEv } from '@lumaforge/luma-color-runtime'
import type { LumaRawExportCapability } from '@lumaforge/luma-raw-runtime'
import type {
  ExportGeometry,
  FullResolutionExportProgress,
} from '@lumaforge/render-engine/export'
import {
  assessProcessedExport,
  INVALID_EXPORT_GEOMETRY,
  planExportGeometry,
  runFullResolutionJpegExport,
  runProcessedWindowExportLifecycle,
} from '@lumaforge/render-engine/export'
import type {
  PolicyChoice,
  RenderEnvironment,
  RenderManifest,
} from '@lumaforge/render-engine/manifest'
import { QUICK_PREVIEW_MAX_PIXELS } from '@lumaforge/render-engine/preview'

import type { CleanupFailure } from '../protocol/errors'
import {
  attemptCleanup,
  cleanupFailure,
  cleanupFailureFields,
  LmfgError,
  withCleanupFailures,
} from '../protocol/errors'
import type { LmfgRuntime } from '../runtime/node-runtime'
import type { LoadedSource } from '../runtime/source-loader'
import type { RenderParams } from '../schemas/params'
import type { ExportResult, SessionRecord } from '../schemas/results'
import { writeJsonAtomic } from '../workspace/atomic-fs'
import { toFileUri, workspacePaths } from '../workspace/paths'
import type { SessionStore } from '../workspace/session-store'
import {
  buildColorGraph,
  requireSupportedGraph,
  resolveExposure,
} from './color-graph'
import { createFileJpegRowSink } from './jpeg-file-sink'
import type { ResolvedLut } from './lut'
import {
  buildRenderManifest,
  percentToQuality,
  toSourceIdentity,
} from './manifest'
import type { ResourceUsage } from './resource'
import { captureResourceUsage } from './resource'

const DEFAULT_EXPORT_STRIP_ROWS = 512

/** The RAW render exposure a verified manifest records, as the graph applies it. */
export function exposureFromManifest(
  manifest: RenderManifest,
): RawRenderExposure {
  const ev = manifest.render_params.raw_render_exposure_ev
  return {
    ev,
    multiplier: exposureMultiplierFromEv(ev),
    source: manifest.render_params.raw_render_exposure_source,
  }
}

/**
 * Refuses a source before the processed-window export begins, using the same
 * assessment the executor applies as its own final gate, so this early check
 * can never admit a capability the executor would refuse.
 */
function requireExportCapability(
  capability: LumaRawExportCapability,
): LumaRawExportCapability {
  const assessment = assessProcessedExport(capability)
  if (assessment.exportable) return capability
  const why = capability.reasons.length
    ? capability.reasons
    : assessment.reasons
  throw new LmfgError('source.export_unsupported', {
    message: `This RAW cannot be exported at full resolution (${why.join(', ')}).`,
    details: {
      reasons: capability.reasons,
      refusals: assessment.reasons,
      strategy: capability.strategy ?? null,
    },
    suggestedNextActions: ['lmfg inspect --session <id>'],
  })
}

type Dimensions = { width: number; height: number }

/** The frames one full-resolution export reads and writes. */
export type ExportFrame = {
  /** The decoded source frame the processed windows are read from. */
  source: Dimensions
  /** The frame the JPEG delivers: the source, or the geometry's planned output. */
  output: Dimensions
}

/**
 * Plans the delivered frame with the engine's own geometry planner, which the
 * executor runs again before its first window, so a geometry refused here is
 * one the executor would refuse and a frame admitted here is the frame it
 * writes.
 */
function planExportFrame(
  capability: LumaRawExportCapability,
  geometry: ExportGeometry | undefined,
): ExportFrame {
  const source = { width: capability.width, height: capability.height }
  if (!geometry) return { source, output: source }
  try {
    const planned = planExportGeometry(geometry, source)
    return {
      source,
      output: { width: planned.outputWidth, height: planned.outputHeight },
    }
  } catch (error) {
    if (!(error instanceof Error) || error.message !== INVALID_EXPORT_GEOMETRY)
      throw error
    throw new LmfgError('export.refused', {
      message: `The geometry cannot be exported from this ${source.width}x${source.height} source: it folds the frame or retains too little of it.`,
      details: { stage: 'geometry', source },
    })
  }
}

export type ExportRunInput = {
  runtime: LmfgRuntime
  source: LoadedSource
  params: RenderParams
  lut: ResolvedLut | null
  /** Pre-resolved exposure (from a candidate manifest) or `null` to resolve from the quick frame. */
  exposure: RawRenderExposure | null
  quality: number
  /** Final JPEG path; chunks stream into `<path>.tmp` and rename on success. */
  outputPath: string
  preferredRows?: number
  /** Geometry applied at full resolution before the color graph; absent exports the decoded frame. */
  geometry?: ExportGeometry
  /** Checks the probed frames before any window is read; throwing refuses the export. */
  verifyFrame?: (frame: ExportFrame) => void
  signal?: AbortSignal
  onProgress?: (progress: FullResolutionExportProgress) => void
}

export type ExportRunResult = {
  path: string
  byteLength: number
  sha256: string
  /** Delivered frame; under a geometry this is its planned output, not the source. */
  width: number
  height: number
  /** Decoded source frame the export read from. */
  source: Dimensions
  graph: SupportedExportColorGraphDescriptor
  exposure: RawRenderExposure
  /** The strip height and concurrency the export ran with. */
  policy: PolicyChoice
  strips: number
  timings: Record<string, number>
  resource: ResourceUsage
  /** Publish the validated JPEG at `path`. */
  commit: () => Promise<void>
  /** Drop the validated JPEG without publishing; rejects if it stays on disk. */
  discard: () => Promise<void>
  /**
   * Cleanup steps that failed for an attempt the engine abandoned and
   * retried; a listed `remove_temp_file` means that attempt's temp file may
   * remain. Callers report these with the result or beside a later failure.
   */
  cleanupFailures: readonly CleanupFailure[]
}

export async function runFullResolutionExport(
  input: ExportRunInput,
): Promise<ExportRunResult> {
  const timings: Record<string, number> = {}
  const total = performance.now()
  const raw = await input.runtime.raw()
  // Resolve the raw-render exposure from a throwaway quick decode first: a
  // quick decode must never share the session used for processed-window
  // export (LibRaw state is not repeatable across the two paths).
  let exposure = input.exposure
  if (!exposure) {
    const exposureStart = performance.now()
    const frame = await raw.decodeQuick(
      input.source.input,
      { maxOutputPixels: QUICK_PREVIEW_MAX_PIXELS },
      input.signal,
    )
    exposure = resolveExposure(input.params, {
      baselineExposure: frame.metadata.baselineExposure,
      frame,
    })
    timings.exposure_ms = performance.now() - exposureStart
  }
  const session = await raw.openSession(
    input.source.input,
    { maxOutputPixels: QUICK_PREVIEW_MAX_PIXELS },
    input.signal,
  )
  try {
    const capability = requireExportCapability(
      await session.probeExportCapability(input.signal),
    )
    const frame = planExportFrame(capability, input.geometry)
    input.verifyFrame?.(frame)
    const graph = requireSupportedGraph(
      buildColorGraph(input.params, input.lut?.lutData ?? null, exposure),
    )

    const policy: PolicyChoice = {
      kind: 'export-full',
      row_slice: input.preferredRows ?? DEFAULT_EXPORT_STRIP_ROWS,
      concurrency: 1,
    }
    let strips = 0
    const exportStart = performance.now()
    const sink = createFileJpegRowSink({
      path: input.outputPath,
      metadata: session.probe,
    })
    // The lifecycle rethrows a failed end only when the export itself
    // succeeded; remember it so it is reported beside an earlier failure.
    const endFailures: unknown[] = []
    const endProcessedWindowExport = session.endProcessedWindowExport
    try {
      await runProcessedWindowExportLifecycle({
        beginProcessedWindowExport: session.beginProcessedWindowExport,
        endProcessedWindowExport: endProcessedWindowExport
          ? async (signal) => {
              try {
                return await endProcessedWindowExport(signal)
              } catch (error) {
                endFailures.push(error)
                throw error
              }
            }
          : undefined,
        signal: input.signal,
        runExport: () =>
          runFullResolutionJpegExport({
            capability,
            graph,
            readProcessedWindow: session.readProcessedWindow,
            quality: percentToQuality(input.quality),
            preferredRows: policy.row_slice,
            concurrency: policy.concurrency,
            ...(input.geometry ? { geometry: input.geometry } : {}),
            jpegSink: sink,
            signal: input.signal,
            onProgress: (progress) => {
              strips = progress.totalStrips
              input.onProgress?.(progress)
            },
          }),
      })
      timings.export_ms = performance.now() - exportStart
      const streamed = sink.result()
      if (!streamed) {
        throw new LmfgError('export.refused', {
          message: 'The export finished without publishing a JPEG file.',
        })
      }
      timings.total_ms = performance.now() - total
      return {
        path: streamed.path,
        byteLength: streamed.byteLength,
        sha256: streamed.sha256,
        commit: streamed.commit,
        discard: streamed.discard,
        cleanupFailures: [...sink.cleanupFailures()],
        width: frame.output.width,
        height: frame.output.height,
        source: frame.source,
        graph,
        exposure,
        policy,
        strips,
        timings,
        resource: captureResourceUsage(),
      }
    } catch (error) {
      // A rejected export drops its encoded temp file; the export's own
      // failure stays primary and every cleanup that failed is listed with it.
      const failures: CleanupFailure[] = [...sink.cleanupFailures()]
      for (const endError of endFailures) {
        if (endError !== error) {
          failures.push(cleanupFailure('end_processed_window_export', endError))
        }
      }
      const streamed = sink.result()
      if (streamed) {
        await attemptCleanup(failures, 'remove_temp_file', streamed.discard)
      }
      throw withCleanupFailures(error, failures)
    }
  } finally {
    session.dispose()
  }
}

export type ExportPublishInput = Omit<
  ExportRunInput,
  'geometry' | 'verifyFrame'
> & {
  store: SessionStore
  record: SessionRecord
  environment: RenderEnvironment
  /** Artifact base name under `exports/`. */
  name: string
  /** The candidate manifest the export chains to, if any. */
  parentManifestSha256: string | null
}

/**
 * Runs a full-resolution export and publishes the JPEG and its manifest under
 * `exports/<name>`. A failed publish keeps the cleanup failures of an attempt
 * the engine abandoned beside it.
 */
export async function publishExport(
  input: ExportPublishInput,
): Promise<ExportResult> {
  const { record, source, lut } = input
  const result = await runFullResolutionExport(input)
  const manifestPath = workspacePaths.exportManifestFile(
    input.store.root,
    record.id,
    input.name,
  )
  const manifest = buildRenderManifest({
    kind: 'export',
    source: toSourceIdentity(source, result.source),
    lut: lut?.identity ?? null,
    graph: result.graph,
    params: input.params,
    exposure: result.exposure,
    policy: result.policy,
    environment: input.environment,
    output: {
      width: result.width,
      height: result.height,
      quality: input.quality,
      filename: `${input.name}.jpg`,
      sha256: result.sha256,
    },
    parentManifestSha256: input.parentManifestSha256,
  })
  try {
    await result.commit()
    await writeJsonAtomic(manifestPath, manifest)
    await input.store.allocate(record.id, 'exports')
  } catch (error) {
    throw withCleanupFailures(error, result.cleanupFailures)
  }
  return {
    session_id: record.id,
    output: {
      uri: toFileUri(input.outputPath),
      path: input.outputPath,
      width: result.width,
      height: result.height,
      byte_size: result.byteLength,
      sha256: result.sha256,
      quality: input.quality,
    },
    manifest_uri: toFileUri(manifestPath),
    manifest_sha256: manifest.manifest_sha256,
    parent_manifest_sha256: input.parentManifestSha256,
    color_graph_fingerprint: manifest.color_graph.fingerprint,
    raw_render_exposure: result.exposure,
    strips: result.strips,
    resource: result.resource,
    timings_ms: result.timings,
    ...cleanupFailureFields(result.cleanupFailures),
  }
}
