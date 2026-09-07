import type { ExportColorGraphDescriptor } from '@lumaforge/luma-color-runtime'
import type { FullResolutionExportProgress } from '@lumaforge/render-engine/export'

import type { ExportExecutionPlan } from '~/lib/export/execution-profile'
import { selectExportExecutionPlan } from '~/lib/export/execution-profile'
import type {
  FullResWorkerCheckpointConfig,
  FullResWorkerExecutionPlan,
  RunFullResolutionJpegExportInWorkerInput,
} from '~/lib/export/full-res-export-client'
import { FullResolutionExportWorkerClient } from '~/lib/export/full-res-export-client'
import type { ExportFidelity } from '~/lib/gl/export'
import { detectCapabilityVector } from '~/lib/runtime/capability-vector'
import type { ExportRuntimeResources } from '~/lib/runtime/export-runtime-resources'
import { snapshotExportRuntimeResources } from '~/lib/runtime/export-runtime-resources'
import { ExportBridge } from '~/lib/workers/export-bridge'

export const HQ_PREVIEW_EXPORT_MAX_PIXELS = 12_000_000
export const HQ_PREVIEW_EXPORT_QUALITY = 0.9

export function buildExportFilename(inputName: string, styleName: string) {
  const basename = inputName.replace(/\.[^.]+$/, '')
  return `${basename}_${styleName}_fullres.jpg`
}

export function buildPreviewExportFilename(
  inputName: string,
  styleName: string,
) {
  const basename = inputName.replace(/\.[^.]+$/, '')
  return `${basename}_${styleName}_hq-preview.jpg`
}

export function resolveHqPreviewExportSize({
  width,
  height,
  maxPixels = HQ_PREVIEW_EXPORT_MAX_PIXELS,
}: {
  width: number
  height: number
  maxPixels?: number
}) {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new Error('HQ_PREVIEW_EXPORT_SIZE_INVALID')
  }

  const normalizedWidth = Math.round(width)
  const normalizedHeight = Math.round(height)
  const pixels = normalizedWidth * normalizedHeight
  if (pixels <= maxPixels) {
    return { width: normalizedWidth, height: normalizedHeight }
  }

  const scale = Math.sqrt(maxPixels / pixels)
  return {
    width: Math.max(1, Math.floor(normalizedWidth * scale)),
    height: Math.max(1, Math.floor(normalizedHeight * scale)),
  }
}

function isJpegStreamingOutputSinkAvailable() {
  // Web Streams alone are not an export sink; only return true once a bounded
  // JPEG streaming handoff is wired into the worker path.
  return false
}

export async function selectCurrentExportExecutionPlan(input: {
  fidelity: ExportFidelity
  sourceWidth?: number
  sourceHeight?: number
  previousInterrupted?: boolean
  previousCrashLikeInterruption?: boolean
  previousUserInterrupted?: boolean
  previousResourceFailure?: boolean
}) {
  const streamingSinkAvailable = isJpegStreamingOutputSinkAvailable()
  const capability = await detectCapabilityVector()
  const runtime = await snapshotExportRuntimeResources({
    streamingSinkAvailable,
  })

  return selectExportExecutionPlan({
    performancePreference: input.fidelity,
    previousResourceFailure: input.previousResourceFailure ?? false,
    previousCrashLikeInterruption:
      input.previousCrashLikeInterruption ?? input.previousInterrupted ?? false,
    previousUserInterrupted: input.previousUserInterrupted ?? false,
    sourceWidth: input.sourceWidth,
    sourceHeight: input.sourceHeight,
    capability,
    runtime,
  })
}

export type { ExportExecutionPlan }

export type FullResolutionExportAttemptEvent = {
  attempt: number
  profile?: ExportExecutionPlan['profile']['name']
  preferredRows?: number
  concurrency?: number
  phase: 'started' | 'retry-scheduled' | 'disposed'
  retryReason?: string
  previousRows?: number
  nextRows?: number
  previousConcurrency?: number
  nextConcurrency?: number
  freshWorker: boolean
  priorClientDisposed?: boolean
}

function emitFullResolutionExportAttempt(
  onAttempt: ((event: FullResolutionExportAttemptEvent) => void) | undefined,
  event: FullResolutionExportAttemptEvent,
) {
  try {
    onAttempt?.(event)
  } catch {
    // Attempt diagnostics must not affect export control flow.
  }
}

export function recommendRetryLevel(
  level: ExportFidelity,
): Exclude<ExportFidelity, 'max'> | null {
  if (level === 'max') return 'balanced'
  if (level === 'balanced') return 'safe'
  return null
}

export async function runPreviewExportJob({
  renderToCanvas,
  filename,
  quality,
}: {
  renderToCanvas: () => Promise<HTMLCanvasElement>
  filename: string
  quality: number
}) {
  const canvas = await renderToCanvas()

  return await new Promise<{ filename: string; blob: Blob }>(
    (resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          if (!blob) {
            reject(new Error('EXPORT_JPEG_BLOB_FAILED'))
            return
          }

          resolve({ filename, blob })
        },
        'image/jpeg',
        quality,
      )
    },
  )
}

export function createFullResolutionExportClient() {
  return new FullResolutionExportWorkerClient()
}

function createFullResolutionExportBridge(
  clientFactory: () => FullResolutionExportWorkerClient,
) {
  return new ExportBridge({
    createClient: clientFactory,
  })
}

function errorLooksLikeFreshWorkerRetry(error: unknown) {
  return (
    error instanceof Error &&
    (error.message === 'FULL_RES_EXPORT_RESOURCE_FAILURE' ||
      error.message === 'FULL_RES_EXPORT_WORKER_FAILED')
  )
}

function getFreshWorkerRetryRows(error: unknown) {
  if (typeof error !== 'object' || !error || !('nextRows' in error)) {
    return undefined
  }

  const nextRows = (error as { nextRows?: unknown }).nextRows
  return typeof nextRows === 'number' && Number.isFinite(nextRows)
    ? nextRows
    : undefined
}

function toWorkerExecutionPlan(
  plan: ExportExecutionPlan,
): FullResWorkerExecutionPlan {
  return {
    profileName: plan.profile.name,
    preferredRows: plan.preferredRows,
    concurrency: plan.concurrency,
    runtimeMemoryProfile: plan.runtimeMemoryProfile,
    outputSink: plan.outputSink,
    checkpointMode: plan.checkpointMode,
  }
}

export async function runFullResolutionExportJob({
  file,
  filename,
  graph,
  geometry,
  quality,
  preferredRows,
  concurrency,
  executionPlan,
  checkpoint,
  onProgress,
  onMetric,
  onAttempt,
  beforeStart,
  signal,
  clientFactory = createFullResolutionExportClient,
}: {
  file: File
  filename: string
  graph: ExportColorGraphDescriptor
  geometry?: RunFullResolutionJpegExportInWorkerInput['geometry']
  quality?: RunFullResolutionJpegExportInWorkerInput['quality']
  preferredRows?: RunFullResolutionJpegExportInWorkerInput['preferredRows']
  concurrency?: RunFullResolutionJpegExportInWorkerInput['concurrency']
  executionPlan?: ExportExecutionPlan
  checkpoint?: FullResWorkerCheckpointConfig
  onProgress?: (progress: FullResolutionExportProgress) => void
  onMetric?: RunFullResolutionJpegExportInWorkerInput['onMetric']
  onAttempt?: (event: FullResolutionExportAttemptEvent) => void
  beforeStart?: () => void | Promise<void>
  signal?: AbortSignal
  clientFactory?: () => FullResolutionExportWorkerClient
}) {
  let plan = executionPlan
  let attempts = 0

  while (true) {
    attempts += 1
    const bridge = createFullResolutionExportBridge(clientFactory)
    const attemptPlan = plan
    const attemptSignal = signal ?? new AbortController().signal

    try {
      emitFullResolutionExportAttempt(onAttempt, {
        attempt: attempts,
        profile: attemptPlan?.profile.name,
        preferredRows: attemptPlan?.preferredRows ?? preferredRows,
        concurrency: attemptPlan?.concurrency ?? concurrency,
        phase: 'started',
        freshWorker: true,
      })

      await beforeStart?.()

      const output = await bridge.runExport(attemptSignal, {
        file,
        filename,
        graph,
        geometry,
        quality,
        preferredRows: attemptPlan?.preferredRows ?? preferredRows,
        concurrency: attemptPlan?.concurrency ?? concurrency,
        executionPlan: attemptPlan
          ? toWorkerExecutionPlan(attemptPlan)
          : undefined,
        checkpoint: attemptPlan?.profile.checkpointOutput
          ? checkpoint
          : undefined,
        onProgress,
        onMetric,
      })

      return { filename, output, attempts }
    } catch (error) {
      if (
        !attemptPlan ||
        attempts >= 3 ||
        !errorLooksLikeFreshWorkerRetry(error)
      ) {
        throw error
      }

      const retryPlan = selectExportExecutionPlan({
        performancePreference: 'safe',
        sourceWidth: attemptPlan.sourceWidth,
        sourceHeight: attemptPlan.sourceHeight,
        previousResourceFailure: true,
        previousCrashLikeInterruption: false,
        previousUserInterrupted: false,
        capability:
          attemptPlan.capabilitySnapshot ?? (await detectCapabilityVector()),
        runtime:
          attemptPlan.runtimeSnapshot ??
          ({
            opfsSinkAvailable: false,
            opfsAvailableMB: null,
            streamingSinkAvailable: false,
          } satisfies ExportRuntimeResources),
      })

      const workerNextRows = getFreshWorkerRetryRows(error)
      const nextRows =
        workerNextRows != null
          ? Math.min(workerNextRows, retryPlan.preferredRows)
          : retryPlan.preferredRows

      emitFullResolutionExportAttempt(onAttempt, {
        attempt: attempts,
        profile: attemptPlan.profile.name,
        preferredRows: attemptPlan.preferredRows,
        concurrency: attemptPlan.concurrency,
        phase: 'retry-scheduled',
        retryReason:
          error instanceof Error
            ? error.message
            : 'FULL_RES_EXPORT_WORKER_FAILED',
        previousRows: attemptPlan.preferredRows,
        nextRows,
        previousConcurrency: attemptPlan.concurrency,
        nextConcurrency: retryPlan.concurrency,
        freshWorker: true,
        priorClientDisposed: false,
      })

      plan =
        retryPlan.preferredRows === nextRows
          ? retryPlan
          : { ...retryPlan, preferredRows: nextRows }
    } finally {
      await bridge.terminate()
      emitFullResolutionExportAttempt(onAttempt, {
        attempt: attempts,
        profile: attemptPlan?.profile.name,
        preferredRows: attemptPlan?.preferredRows ?? preferredRows,
        concurrency: attemptPlan?.concurrency ?? concurrency,
        phase: 'disposed',
        freshWorker: false,
        priorClientDisposed: true,
      })
    }
  }
}
