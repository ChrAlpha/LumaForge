import type { LUTData, ProcessingParams } from '@lumaforge/luma-color-runtime'
import { resolveExportColorGraph } from '@lumaforge/luma-color-runtime'
import { toast } from 'sonner'

import type { ExportCheckpointManifest } from '~/lib/export/checkpoint-store'
import {
  createCheckpointStore,
  createOpfsCheckpointBackend,
  selectCheckpointResumeExecutionPlan,
} from '~/lib/export/checkpoint-store'
import {
  emitExportDebugEvent,
  getExportModeCopy,
  toExportPlanSelectedDebugPayload,
} from '~/lib/export/execution-profile'
import type { FullResWorkerCheckpointConfig } from '~/lib/export/full-res-export-client'
import type { ResourceRegistry } from '~/lib/export/resource-registry'
import { createSourceFingerprint } from '~/lib/export/source-fingerprint'
import type { PipelineStats, RawProcessingPipeline } from '~/lib/gl/pipeline'
import type { DecodedImage, ImageMetadata } from '~/lib/raw/decoder'

import type { ExportResult } from '../../model/export-result'
import type { ExportRecoveryState, ImageSession } from '../../model/session'
import type { ProcessingStatus } from '../../model/workflow'
import {
  getStableErrorCode,
  isRetryableFullResExportFailure,
  toUserFacingErrorCode,
} from '../ingest/workflow-status'
import { buildManifestForExportResult } from './attach-export-manifest'
import {
  createPreExportSnapshot,
  evacuateBeforeExport,
  getPreExportEvacuationOwners,
  toResourceEvacuatedDebugPayload,
} from './export-evacuation'
import { resolveExportEnvironment } from './export-manifest'
import { deriveFullResExportReadiness } from './export-readiness'
import { resolveExportCopyCapability } from './export-result-actions'
import { createCompletedExportResult } from './export-result-materialization'
import {
  buildExportFailureDescription,
  clearExportResultForActiveExport,
  createSafeRetryManifest,
  isCheckpointMetric,
} from './export-state'
import {
  buildExportFilename,
  recommendRetryLevel,
  runFullResolutionExportJob,
  selectCurrentExportExecutionPlan,
} from './export-system'

export interface ExportContext {
  atoms: {
    setStatus: (status: ProcessingStatus) => void
    setError: (error: string | null) => void
    setProgress: (progress: number) => void
    setSession: (
      value:
        | ImageSession
        | null
        | ((prev: ImageSession | null) => ImageSession | null),
    ) => void
    loadedImage: { file: File | null; metadata: ImageMetadata | null }
    session: ImageSession | null
    params: ProcessingParams
    lutDataRef: { current: LUTData | null }
    decodedImageRef: { current: DecodedImage | null }
    stats: PipelineStats | null
    setDiscoveredRecoveryState: (next: ExportRecoveryState) => void
  }
  refs: {
    exportAbortControllerRef: { current: AbortController | null }
    exportGraphVersionRef: { current: number }
    isMountedRef: { current: boolean }
    sessionRef: { current: ImageSession | null }
    pipelineRef: { current: RawProcessingPipeline | null }
    resourceRegistryRef: { current: ResourceRegistry | null }
    previewCopyCanvasRef: { current: HTMLCanvasElement | null }
  }
  services: {
    scheduleToast: (fn: () => void) => void
    abortExportWork: () => void
    abortRuntimeWork: () => void
    terminateRawDecodeBridge: () => void | Promise<void>
    registerCurrentPreviewPipelineForEvacuation: () => void
    registerExportResultResource: (result: ExportResult) => void
    revokeCurrentEmbeddedPreviewUrl: () => void
  }
}

function createExportId() {
  return globalThis.crypto?.randomUUID?.() ?? `export-${Date.now()}`
}

function deferSuccessfulCheckpointCleanup(task: () => void) {
  if (typeof globalThis.requestIdleCallback === 'function') {
    globalThis.requestIdleCallback(() => task(), { timeout: 2000 })
    return
  }

  globalThis.setTimeout(task, 0)
}

function scheduleSuccessfulCheckpointCleanup(input: {
  checkpointStore: ReturnType<typeof createCheckpointStore>
  checkpoint: FullResWorkerCheckpointConfig
  recoveredExportId?: string
}) {
  void (async () => {
    await input.checkpointStore
      .removeActiveManifest(input.checkpoint.exportId)
      .catch(() => undefined)
    if (
      input.recoveredExportId &&
      input.recoveredExportId !== input.checkpoint.exportId
    ) {
      await input.checkpointStore
        .removeActiveManifest(input.recoveredExportId)
        .catch(() => undefined)
    }
  })()
}

export async function orchestrateFullResExport(
  options: {
    quality: 'standard' | 'high'
    fidelity: 'safe' | 'balanced' | 'max'
    previousInterrupted?: boolean
    recoveredExportId?: string
    recoveredManifest?: ExportCheckpointManifest
  },
  ctx: ExportContext,
): Promise<void> {
  const { quality, fidelity, previousInterrupted, recoveredExportId } = options

  const rawRenderExposure =
    ctx.atoms.decodedImageRef.current?.renderExposure ?? null
  const sourceFile = ctx.atoms.loadedImage.file
  const exportReadiness = deriveFullResExportReadiness({
    sourceFile,
    session: ctx.atoms.session,
    rawRenderExposure,
  })
  if (!exportReadiness.canExport) {
    const description = exportReadiness.disabledReason
    ctx.services.scheduleToast(() =>
      toast.error(
        'Full-resolution export is not ready',
        description ? { description } : undefined,
      ),
    )
    return
  }

  const activeSession = exportReadiness.session
  const activeSourceFile = exportReadiness.sourceFile
  const activeRawRenderExposure = exportReadiness.rawRenderExposure
  const exportCapability = exportReadiness.fullResCapability

  const graph = resolveExportColorGraph({
    styleKind: ctx.atoms.params.styleKind,
    intensity: ctx.atoms.params.intensity,
    builtinPreset: ctx.atoms.params.builtinPreset,
    lut: ctx.atoms.lutDataRef.current,
    rawRenderExposure: activeRawRenderExposure,
    userExposureEv: ctx.atoms.params.userExposureEv,
    userContrast: ctx.atoms.params.userContrast,
    userHighlights: ctx.atoms.params.userHighlights,
    userShadows: ctx.atoms.params.userShadows,
    userWhites: ctx.atoms.params.userWhites,
    userBlacks: ctx.atoms.params.userBlacks,
    userTemperature: ctx.atoms.params.userTemperature,
    userTint: ctx.atoms.params.userTint,
    userSaturation: ctx.atoms.params.userSaturation,
    userVibrance: ctx.atoms.params.userVibrance,
    selectiveColor: ctx.atoms.params.selectiveColor,
  })

  if (!graph.supported) {
    ctx.atoms.setError(graph.message)
    ctx.atoms.setStatus('error')
    ctx.atoms.setSession((prev) =>
      prev
        ? {
            ...prev,
            exportState: {
              ...prev.exportState,
              status: 'failed',
              result: undefined,
              lastErrorCode: 'EXPORT_UNSUPPORTED_PIPELINE',
              retryRecommended: false,
              recommendedRetryLevel: undefined,
            },
          }
        : prev,
    )
    return
  }
  const graphFingerprint = JSON.stringify(graph.steps)

  const exportSessionId = activeSession.id
  const exportGraphVersion = ctx.refs.exportGraphVersionRef.current
  ctx.services.abortExportWork()
  const exportAbortController = new AbortController()
  ctx.refs.exportAbortControllerRef.current = exportAbortController

  const isCurrentExport = () =>
    ctx.refs.isMountedRef.current &&
    !exportAbortController.signal.aborted &&
    ctx.refs.exportGraphVersionRef.current === exportGraphVersion &&
    ctx.refs.sessionRef.current?.id === exportSessionId

  try {
    ctx.atoms.setStatus('exporting')
    ctx.atoms.setProgress(0)
    ctx.atoms.setError(null)
    toast.dismiss()
    ctx.refs.previewCopyCanvasRef.current = null
    const executionPlan =
      previousInterrupted && options.recoveredManifest
        ? await selectCheckpointResumeExecutionPlan({
            manifest: options.recoveredManifest,
            fidelity,
          })
        : await selectCurrentExportExecutionPlan({
            fidelity,
            sourceWidth: exportCapability.width,
            sourceHeight: exportCapability.height,
            previousCrashLikeInterruption: previousInterrupted,
            previousResourceFailure: false,
            previousUserInterrupted: false,
          })
    if (executionPlan.productCopy === 'cannot-safely-complete') {
      throw Object.assign(
        new Error(getExportModeCopy(executionPlan.productCopy)),
        { code: 'EXPORT_POLICY_CANNOT_COMPLETE' },
      )
    }
    const jobExecutionPlan = executionPlan
    let checkpointStore: ReturnType<typeof createCheckpointStore> | null = null
    let checkpointManifest: ExportCheckpointManifest | null = null
    let checkpoint: FullResWorkerCheckpointConfig | undefined

    if (
      executionPlan.profile.checkpointOutput &&
      executionPlan.outputSink === 'opfs-file'
    ) {
      try {
        checkpointStore = createCheckpointStore(createOpfsCheckpointBackend())
        const exportId = createExportId()
        const sourceFingerprint = await createSourceFingerprint(
          activeSourceFile,
          {
            width: exportCapability.width,
            height: exportCapability.height,
          },
        )
        checkpointManifest = createSafeRetryManifest({
          exportId,
          file: activeSourceFile,
          sourceFingerprint,
          outputWidth: exportCapability.width,
          outputHeight: exportCapability.height,
          graphFingerprint,
          profile: executionPlan.profile.name,
          derivedLabel: executionPlan.derivedLabel,
          preferredRows: executionPlan.preferredRows,
          outputSink: executionPlan.outputSink,
        })
        await checkpointStore.writeActive(checkpointManifest)
        if (isCurrentExport()) {
          emitExportDebugEvent({
            type: 'checkpoint-written',
            payload: {
              exportId,
              completedRowsForDiagnostics:
                checkpointManifest.completedRowsForDiagnostics,
              totalRows: checkpointManifest.totalRows,
              updatedAt: checkpointManifest.updatedAt,
            },
          })
        }
        checkpoint = {
          exportId,
          graphFingerprint,
          sourceFingerprint,
        }
      } catch {
        checkpointStore = null
        checkpointManifest = null
      }
    }

    if (!isCurrentExport()) {
      return
    }

    if (previousInterrupted) {
      ctx.atoms.setDiscoveredRecoveryState({ status: 'none' })
    }
    const activePlan = {
      profileName: jobExecutionPlan.profile.name,
      preferredRows: jobExecutionPlan.preferredRows,
      concurrency: jobExecutionPlan.concurrency,
      runtimeMemoryProfile: jobExecutionPlan.runtimeMemoryProfile,
      outputSink: jobExecutionPlan.outputSink,
      checkpointMode: jobExecutionPlan.checkpointMode,
    }

    if (jobExecutionPlan.profile.releasePreviewPipelineBeforeExport) {
      // Capture the current WebGL pipeline before activePlan state and
      // preview-copy prep can suspend PreviewCanvas and clear the ref.
      ctx.services.registerCurrentPreviewPipelineForEvacuation()
    }

    emitExportDebugEvent({
      type: 'export-plan-selected',
      payload: toExportPlanSelectedDebugPayload(
        jobExecutionPlan,
        jobExecutionPlan.profile.checkpointOutput &&
          jobExecutionPlan.outputSink === 'opfs-file',
      ),
    })

    ctx.atoms.setSession((prev) =>
      prev && prev.id === exportSessionId
        ? {
            ...prev,
            exportState: {
              ...prev.exportState,
              status: 'exporting',
              qualityPreset: quality,
              fidelityLevel: fidelity,
              activePlan,
              checkpointDurable: Boolean(checkpoint),
              recovery: { status: 'none' },
              result: undefined,
              lastProgress: undefined,
              retryRecommended: false,
              recommendedRetryLevel: undefined,
            },
          }
        : prev,
    )

    let copyCapability = resolveExportCopyCapability()
    let previewCopyCanvas: HTMLCanvasElement | null = null
    const preparePreviewCopyCanvas =
      copyCapability.mode === 'preview-size' &&
      !jobExecutionPlan.profile.releasePreviewPipelineBeforeExport

    if (preparePreviewCopyCanvas) {
      const pipeline = ctx.refs.pipelineRef.current
      const previewSize = ctx.atoms.stats?.previewSize

      if (pipeline && previewSize) {
        try {
          previewCopyCanvas = await pipeline.renderToHiddenCanvas({
            width: previewSize.width,
            height: previewSize.height,
          })
        } catch {
          previewCopyCanvas = null
        }
      }

      if (!isCurrentExport()) {
        return
      }

      if (!previewCopyCanvas) {
        copyCapability = {
          mode: 'unavailable',
          reason: 'Preview image is not ready to copy.',
        }
      }
    }

    const snapshot = createPreExportSnapshot({
      file: activeSourceFile,
      metadata: ctx.atoms.loadedImage.metadata,
      graph,
      graphFingerprint,
      lutTitle:
        activeSession.activeStyle?.kind === 'custom'
          ? activeSession.activeStyle.name
          : undefined,
      quickPreviewReady:
        activeSession.previewBundle.quickDecodePreview.status === 'ready',
      tone: {
        userExposureEv: ctx.atoms.params.userExposureEv,
        userContrast: ctx.atoms.params.userContrast,
        userHighlights: ctx.atoms.params.userHighlights,
        userShadows: ctx.atoms.params.userShadows,
        userWhites: ctx.atoms.params.userWhites,
        userBlacks: ctx.atoms.params.userBlacks,
      },
      color: {
        userTemperature: ctx.atoms.params.userTemperature,
        userTint: ctx.atoms.params.userTint,
        userSaturation: ctx.atoms.params.userSaturation,
        userVibrance: ctx.atoms.params.userVibrance,
      },
      style: activeSession.activeStyle,
    })
    const registry = ctx.refs.resourceRegistryRef.current
    if (!registry) {
      throw Object.assign(new Error('EXPORT_RESOURCE_REGISTRY_MISSING'), {
        code: 'EXPORT_RESOURCE_REGISTRY_MISSING',
      })
    }

    const evacuationOwners = getPreExportEvacuationOwners(
      jobExecutionPlan.profile.name,
    )
    const evacuation = await evacuateBeforeExport({
      registry,
      snapshot,
      owners: evacuationOwners,
      abortPreview: () => {
        ctx.services.abortRuntimeWork()
        ctx.services.revokeCurrentEmbeddedPreviewUrl()
      },
      abortBoundedHq: ctx.services.abortRuntimeWork,
      releasePreviousExportResult() {
        ctx.atoms.setSession((prev) =>
          prev && prev.id === exportSessionId
            ? clearExportResultForActiveExport(prev)
            : prev,
        )
      },
      stopLutFetches() {
        // Online LUT fetches already use per-request abort signals. This hook keeps
        // the owner contract explicit for future registered LUT fetch resources.
      },
    })

    if (!isCurrentExport()) {
      return
    }

    emitExportDebugEvent({
      type: 'resource-evacuated',
      payload: toResourceEvacuatedDebugPayload({
        profile: jobExecutionPlan.profile.name,
        evacuation,
      }),
    })

    if (!evacuation.registryCheck.ok) {
      throw Object.assign(new Error('EXPORT_RESOURCE_EVICTION_INCOMPLETE'), {
        code: 'EXPORT_RESOURCE_EVICTION_INCOMPLETE',
      })
    }

    const filename = buildExportFilename(
      activeSession.sourceFile.name,
      activeSession.activeStyle?.name ?? 'neutral',
    )

    const jpegQuality = quality === 'high' ? 0.92 : 0.86
    const result = await runFullResolutionExportJob({
      file: activeSourceFile,
      filename,
      quality: jpegQuality,
      executionPlan: jobExecutionPlan,
      checkpoint,
      graph,
      onMetric: (metric) => {
        if (
          !checkpointStore ||
          !checkpointManifest ||
          !isCheckpointMetric(metric)
        ) {
          return
        }

        checkpointManifest = {
          ...checkpointManifest,
          completedRowsForDiagnostics: metric.completedRowsForDiagnostics,
          totalRows: metric.totalRows,
          updatedAt: metric.timestamp,
        }
      },
      onAttempt: (attempt) => {
        if (!isCurrentExport()) return

        emitExportDebugEvent({
          type: 'export-worker-attempt',
          payload: attempt,
        })
      },
      onProgress: (entry) => {
        if (
          !ctx.refs.isMountedRef.current ||
          exportAbortController.signal.aborted ||
          ctx.refs.exportGraphVersionRef.current !== exportGraphVersion ||
          ctx.refs.sessionRef.current?.id !== exportSessionId
        ) {
          return
        }

        if (entry.progress >= 99) {
          emitExportDebugEvent({
            type: 'export-progress',
            payload: {
              completedStrips: entry.completedStrips,
              totalStrips: entry.totalStrips,
              progress: entry.progress,
              recordedAt: new Date().toISOString(),
            },
          })
        }

        ctx.atoms.setProgress(entry.progress)
        ctx.atoms.setSession((prev) =>
          prev && prev.id === exportSessionId
            ? {
                ...prev,
                exportState: {
                  ...prev.exportState,
                  lastProgress: {
                    completedStrips: entry.completedStrips,
                    totalStrips: entry.totalStrips,
                  },
                },
              }
            : prev,
        )
      },
      beforeStart: ctx.services.terminateRawDecodeBridge,
      signal: exportAbortController.signal,
    })

    const completedSession = ctx.refs.sessionRef.current
    if (
      !ctx.refs.isMountedRef.current ||
      exportAbortController.signal.aborted ||
      ctx.refs.exportGraphVersionRef.current !== exportGraphVersion ||
      !completedSession ||
      completedSession.id !== exportSessionId ||
      completedSession.exportState.fullResCapability.status !== 'supported'
    ) {
      return
    }
    const completedCapability = completedSession.exportState.fullResCapability

    let cleanupSuccessfulCheckpoint: (() => void) | null = null
    if (checkpointStore && checkpoint) {
      cleanupSuccessfulCheckpoint = () =>
        scheduleSuccessfulCheckpointCleanup({
          checkpointStore,
          checkpoint,
          recoveredExportId,
        })
    }

    const exportResult = createCompletedExportResult({
      jobResult: result,
      metadata: ctx.atoms.loadedImage.metadata,
      width: completedCapability.width,
      height: completedCapability.height,
      copyCapability,
    })
    ctx.refs.previewCopyCanvasRef.current = previewCopyCanvas
    ctx.services.registerExportResultResource(exportResult)

    ctx.atoms.setSession((prev) =>
      prev && prev.id === exportSessionId
        ? {
            ...prev,
            exportState: {
              ...prev.exportState,
              status: 'ready',
              result: exportResult,
              retryRecommended: false,
              lastSuccessfulSize: {
                width: completedCapability.width,
                height: completedCapability.height,
              },
            },
          }
        : prev,
    )
    ctx.atoms.setStatus('ready')
    if (cleanupSuccessfulCheckpoint) {
      deferSuccessfulCheckpointCleanup(cleanupSuccessfulCheckpoint)
    }

    // The manifest is attached after "ready" so hashing the source and the
    // delivered JPEG never delays the download; a failure only logs.
    void buildManifestForExportResult({
      result: exportResult,
      sourceFile: activeSourceFile,
      graph,
      params: ctx.atoms.params,
      rawRenderExposure: activeRawRenderExposure,
      style: activeSession.activeStyle,
      quality: jpegQuality,
      policy: {
        kind: 'export-full',
        row_slice: jobExecutionPlan.preferredRows,
        concurrency: jobExecutionPlan.concurrency,
      },
      environment: resolveExportEnvironment(
        jobExecutionPlan.runtimeMemoryProfile,
      ),
    })
      .then((manifest) => {
        if (
          !ctx.refs.isMountedRef.current ||
          ctx.refs.sessionRef.current?.id !== exportSessionId
        ) {
          return
        }
        ctx.atoms.setSession((prev) =>
          prev &&
          prev.id === exportSessionId &&
          prev.exportState.result === exportResult
            ? {
                ...prev,
                exportState: {
                  ...prev.exportState,
                  result: { ...exportResult, manifest },
                },
              }
            : prev,
        )
        emitExportDebugEvent({
          type: 'export-manifest-ready',
          payload: {
            manifestSha256: manifest.manifest_sha256,
            outputSha256: manifest.output.sha256,
            sourceSha256: manifest.source_raw.sha256,
            filename: manifest.output.filename,
            producedAt: manifest.produced_at,
          },
        })
      })
      .catch((error: unknown) => {
        emitExportDebugEvent({
          type: 'export-manifest-failed',
          payload: {
            message: error instanceof Error ? error.message : String(error),
          },
        })
      })
  } catch (err) {
    if (
      exportAbortController.signal.aborted ||
      !ctx.refs.isMountedRef.current ||
      ctx.refs.exportGraphVersionRef.current !== exportGraphVersion ||
      ctx.refs.sessionRef.current?.id !== exportSessionId
    ) {
      return
    }

    const message = err instanceof Error ? err.message : 'Export failed'
    const rawErrorCode = toUserFacingErrorCode(
      getStableErrorCode(err) ?? message,
    )
    const errorCode =
      rawErrorCode === 'RAW_UNKNOWN' ? 'EXPORT_RENDER_FAILED' : rawErrorCode
    const retryLevel = isRetryableFullResExportFailure(errorCode)
      ? recommendRetryLevel(fidelity)
      : null

    ctx.atoms.setSession((prev) =>
      prev && prev.id === exportSessionId
        ? {
            ...prev,
            exportState: {
              ...prev.exportState,
              status: 'failed',
              result: undefined,
              lastErrorCode: errorCode,
              retryRecommended: Boolean(retryLevel),
              recommendedRetryLevel: retryLevel ?? undefined,
            },
          }
        : prev,
    )
    ctx.atoms.setStatus('ready')
    ctx.services.scheduleToast(() =>
      toast.error('Export failed', {
        description: buildExportFailureDescription(message, retryLevel),
      }),
    )
  } finally {
    if (ctx.refs.exportAbortControllerRef.current === exportAbortController) {
      ctx.refs.exportAbortControllerRef.current = null
    }
  }
}
