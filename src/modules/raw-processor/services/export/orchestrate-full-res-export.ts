import type {
  ColorGraphIntentSource,
  LUTData,
} from '@lumaforge/luma-color-runtime'
import {
  pickColorGraphIntent,
  resolveExportColorGraph,
} from '@lumaforge/luma-color-runtime'
import { toast } from 'sonner'

import type { ExportCheckpointManifest } from '~/lib/export/checkpoint-store'
import {
  createCheckpointStore,
  createOpfsCheckpointBackend,
  selectCheckpointResumeExecutionPlan,
} from '~/lib/export/checkpoint-store'
import type { ExportExecutionPlan } from '~/lib/export/execution-profile'
import {
  emitExportDebugEvent,
  toExportPlanSelectedDebugPayload,
} from '~/lib/export/execution-profile'
import type {
  FullResWorkerCheckpointConfig,
  FullResWorkerOutputLocation,
} from '~/lib/export/full-res-export-client'
import {
  reserveOpfsOutputDirectory,
  scheduleAbandonedOpfsOutputCollection,
} from '~/lib/export/opfs-output-lifetime'
import type { ResourceRegistry } from '~/lib/export/resource-registry'
import { createSourceFingerprint } from '~/lib/export/source-fingerprint'
import type { DecodedImage, ImageMetadata } from '~/lib/raw/decoder'
import type {
  PipelineStats,
  RawProcessingPipeline,
} from '~/lib/webgpu/raw-processing-pipeline'

import type { ExportResult } from '../../model/export-result'
import type {
  ActiveExportPlanState,
  ExportRecoveryState,
  ImageSession,
} from '../../model/session'
import type { ProcessingStatus } from '../../model/workflow'
import {
  getStableErrorCode,
  isRetryableFullResExportFailure,
  toUserFacingErrorCode,
} from '../ingest/workflow-status'
import {
  buildManifestForExportResult,
  ExportManifestUnavailableError,
} from './attach-export-manifest'
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
  createExportPolicyRefusal,
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
    /** The color intent to export; view state plays no part in it. */
    params: ColorGraphIntentSource
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

function toActivePlanState(plan: ExportExecutionPlan): ActiveExportPlanState {
  return {
    profileName: plan.profile.name,
    preferredRows: plan.preferredRows,
    concurrency: plan.concurrency,
    runtimeMemoryProfile: plan.runtimeMemoryProfile,
    outputSink: plan.outputSink,
    checkpointMode: plan.checkpointMode,
  }
}

function expectsDurableCheckpoint(plan: ExportExecutionPlan) {
  return plan.profile.checkpointOutput && plan.outputSink === 'opfs-file'
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
  const currentSession = ctx.refs.sessionRef.current
  const exportReadiness = deriveFullResExportReadiness({
    sourceFile,
    session:
      currentSession?.id === ctx.atoms.session?.id ? currentSession : null,
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
  const exportGeometry = activeSession.exportGeometry ?? null
  /**
   * The frame this export will actually deliver. Geometry crops it, so the
   * checkpoint, the resume plan and the recorded result all size themselves
   * from here rather than from the sensor. Readiness already refused any
   * geometry that will not plan; the worker validates it again on its own.
   */
  const deliveredSize = exportReadiness.deliveredSize

  // One copy of the full intent feeds both the graph and the pre-export
  // snapshot. The strength goes in as given: zero keeps the LUT and its
  // contract checks, it does not clear the look.
  const colorIntent = pickColorGraphIntent(ctx.atoms.params)
  const graph = resolveExportColorGraph({
    ...colorIntent,
    lut: ctx.atoms.lutDataRef.current,
    rawRenderExposure: activeRawRenderExposure,
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
    // Outputs left by closed tabs are collected once per page at idle time;
    // this export never waits for it and cannot fail because of it.
    scheduleAbandonedOpfsOutputCollection()
    if (executionPlan.productCopy === 'cannot-safely-complete') {
      throw createExportPolicyRefusal()
    }
    const jobExecutionPlan = executionPlan
    // An OPFS plan always gets its output address, inside the directory this
    // page reserved. The recovery journal below is best-effort and shares the
    // export id, but its failure only changes durability, never the sink.
    const outputLocation: FullResWorkerOutputLocation | undefined =
      jobExecutionPlan.outputSink === 'opfs-file'
        ? {
            sink: 'opfs-file',
            tabDirectory: await reserveOpfsOutputDirectory(),
            exportId: createExportId(),
          }
        : undefined
    let checkpointStore: ReturnType<typeof createCheckpointStore> | null = null
    let checkpointManifest: ExportCheckpointManifest | null = null
    let checkpoint: FullResWorkerCheckpointConfig | undefined

    if (outputLocation && expectsDurableCheckpoint(jobExecutionPlan)) {
      try {
        checkpointStore = createCheckpointStore(createOpfsCheckpointBackend())
        const exportId = outputLocation.exportId
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
          outputWidth: deliveredSize.width,
          outputHeight: deliveredSize.height,
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
    const activePlan = toActivePlanState(jobExecutionPlan)

    if (jobExecutionPlan.profile.releasePreviewPipelineBeforeExport) {
      // Capture the current GPU pipeline before activePlan state and
      // preview-copy prep can suspend PreviewCanvas and clear the ref.
      ctx.services.registerCurrentPreviewPipelineForEvacuation()
    }

    emitExportDebugEvent({
      type: 'export-plan-selected',
      payload: toExportPlanSelectedDebugPayload(
        jobExecutionPlan,
        expectsDurableCheckpoint(jobExecutionPlan),
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
      intent: colorIntent,
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
      outputLocation,
      checkpoint,
      graph,
      // The geometry the session committed; the worker reproduces exactly it.
      ...(exportGeometry ? { geometry: exportGeometry } : {}),
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
      // A retry or sink fallback replaces the plan; the reported plan has to
      // follow it so it always names the sink the worker writes to.
      onPlan: (plan) => {
        if (!isCurrentExport()) return

        emitExportDebugEvent({
          type: 'export-plan-selected',
          payload: toExportPlanSelectedDebugPayload(
            plan,
            expectsDurableCheckpoint(plan),
          ),
        })
        ctx.atoms.setSession((prev) =>
          prev && prev.id === exportSessionId
            ? {
                ...prev,
                exportState: {
                  ...prev.exportState,
                  activePlan: toActivePlanState(plan),
                },
              }
            : prev,
        )
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
      width: deliveredSize.width,
      height: deliveredSize.height,
      copyCapability,
      manifestState: { status: 'sealing' },
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
                width: deliveredSize.width,
                height: deliveredSize.height,
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
      sourceDimensions: {
        width: completedCapability.width,
        height: completedCapability.height,
      },
      ...(exportGeometry
        ? {
            geometry: {
              matrix: exportGeometry.matrix,
              constrain_crop: exportGeometry.constrainCrop,
              output: deliveredSize,
            },
          }
        : {}),
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
                  result: {
                    ...exportResult,
                    manifest,
                    manifestState: { status: 'ready' },
                  },
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
        const reason =
          error instanceof ExportManifestUnavailableError
            ? error.reason
            : 'internal'
        if (
          ctx.refs.isMountedRef.current &&
          ctx.refs.sessionRef.current?.id === exportSessionId
        ) {
          ctx.atoms.setSession((prev) =>
            prev &&
            prev.id === exportSessionId &&
            prev.exportState.result === exportResult
              ? {
                  ...prev,
                  exportState: {
                    ...prev.exportState,
                    result: {
                      ...exportResult,
                      manifestState: { status: 'unavailable', reason },
                    },
                  },
                }
              : prev,
          )
        }
        emitExportDebugEvent({
          type: 'export-manifest-failed',
          payload: {
            reason,
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
