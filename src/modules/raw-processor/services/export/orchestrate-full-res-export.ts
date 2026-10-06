import type {
  ColorGraphIntentSource,
  LUTData,
} from '@lumaforge/luma-color-runtime'
import {
  pickColorGraphIntent,
  resolveExportColorGraph,
} from '@lumaforge/luma-color-runtime'
import { toast } from 'sonner'

import type { ExportExecutionPlan } from '~/lib/export/execution-profile'
import {
  emitExportDebugEvent,
  toExportPlanSelectedDebugPayload,
} from '~/lib/export/execution-profile'
import type { FullResWorkerOutputLocation } from '~/lib/export/full-res-export-client'
import {
  reserveOpfsOutputDirectory,
  scheduleAbandonedOpfsOutputCollection,
} from '~/lib/export/opfs-output-lifetime'
import type { ResourceRegistry } from '~/lib/export/resource-registry'
import type { DecodedImage, ImageMetadata } from '~/lib/raw/decoder'
import type {
  PipelineStats,
  RawProcessingPipeline,
} from '~/lib/webgpu/raw-processing-pipeline'

import type { ExportResult } from '../../model/export-result'
import type { ActiveExportPlanState, ImageSession } from '../../model/session'
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
import type { ExportAttemptOutcome } from './export-interruption'
import { resolveExportEnvironment } from './export-manifest'
import { deriveFullResExportReadiness } from './export-readiness'
import type {
  ExportInterruptionMarkers,
  SourceInterruptionHint,
} from './export-recovery'
import {
  classifyExportAttemptOutcome,
  interruptionForSource,
  toExportSourceTuple,
} from './export-recovery'
import { resolveExportCopyCapability } from './export-result-actions'
import { createCompletedExportResult } from './export-result-materialization'
import {
  buildExportFailureDescription,
  clearExportResultForActiveExport,
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
    /** Asks the page to read the loaded source's interruption hint again. */
    refreshExportInterruption: () => void
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
    interruptionMarkers: Pick<
      ExportInterruptionMarkers,
      'begin' | 'finish' | 'retire'
    >
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

export async function orchestrateFullResExport(
  options: {
    quality: 'standard' | 'high'
    fidelity: 'safe' | 'balanced' | 'max'
    /** The hint read for the loaded source; it applies only to that file. */
    interruption?: SourceInterruptionHint
  },
  ctx: ExportContext,
): Promise<void> {
  const { quality, fidelity } = options

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
   * recorded result sizes itself from here rather than from the sensor.
   * Readiness already refused any geometry that will not plan; the worker
   * validates it again on its own.
   */
  const deliveredSize = exportReadiness.deliveredSize
  // A hint read for another file, or for an older copy of this one, asks
  // for nothing: the plan, its size and its flags come from this source.
  const interruption = interruptionForSource(
    options.interruption,
    activeSourceFile,
  )

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

  // This attempt's marker, from just before the worker work until the
  // attempt ends; each attempt ends only its own marker.
  const markers = ctx.services.interruptionMarkers
  let markedAttempt: string | null = null
  const endAttempt = (outcome: ExportAttemptOutcome) => {
    if (markedAttempt === null) return
    const ended = markedAttempt
    markedAttempt = null
    markers.finish(ended, outcome)
  }

  try {
    ctx.atoms.setStatus('exporting')
    ctx.atoms.setProgress(0)
    ctx.atoms.setError(null)
    toast.dismiss()
    ctx.refs.previewCopyCanvasRef.current = null
    const executionPlan = await selectCurrentExportExecutionPlan({
      fidelity,
      sourceWidth: exportCapability.width,
      sourceHeight: exportCapability.height,
      previousCrashLikeInterruption:
        interruption?.previousCrashLikeInterruption ?? false,
      previousResourceFailure: interruption?.previousResourceFailure ?? false,
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
    // page reserved. No recovery journal is written next to it.
    const outputLocation: FullResWorkerOutputLocation | undefined =
      jobExecutionPlan.outputSink === 'opfs-file'
        ? {
            sink: 'opfs-file',
            tabDirectory: await reserveOpfsOutputDirectory(),
            exportId: createExportId(),
          }
        : undefined

    if (!isCurrentExport()) {
      return
    }

    // Readiness, graph, geometry and plan have all passed, so only an export
    // that is about to run leaves a marker. The marker is a hint and never
    // blocks: when it cannot be stored the export goes ahead unmarked.
    markedAttempt = (await markers.begin(toExportSourceTuple(activeSourceFile)))
      .attempt

    if (!isCurrentExport()) {
      return
    }

    const activePlan = toActivePlanState(jobExecutionPlan)

    if (jobExecutionPlan.profile.releasePreviewPipelineBeforeExport) {
      // Capture the current GPU pipeline before activePlan state and
      // preview-copy prep can suspend PreviewCanvas and clear the ref.
      ctx.services.registerCurrentPreviewPipelineForEvacuation()
    }

    // No export state outlives the tab: an interrupted export always starts
    // again from the first row, whatever the sink.
    emitExportDebugEvent({
      type: 'export-plan-selected',
      payload: toExportPlanSelectedDebugPayload(jobExecutionPlan, false),
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
              checkpointDurable: false,
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
      graph,
      // The geometry the session committed; the worker reproduces exactly it.
      ...(exportGeometry ? { geometry: exportGeometry } : {}),
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
          payload: toExportPlanSelectedDebugPayload(plan, false),
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
    // The job finished, so the attempt is over even if its JPEG is dropped.
    endAttempt('completed')

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
    if (interruption) {
      // The safer export of this source delivered, whatever its sink: the
      // hint has been used, and the page reads the source's hint again.
      markers.retire(interruption.attempts)
      ctx.atoms.refreshExportInterruption()
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
    const message = err instanceof Error ? err.message : 'Export failed'
    const rawErrorCode = toUserFacingErrorCode(
      getStableErrorCode(err) ?? message,
    )
    const errorCode =
      rawErrorCode === 'RAW_UNKNOWN' ? 'EXPORT_RENDER_FAILED' : rawErrorCode
    const hadAttempt = markedAttempt !== null
    const outcome = classifyExportAttemptOutcome({
      aborted: exportAbortController.signal.aborted,
      errorCode,
      error: err,
    })
    endAttempt(outcome)

    if (
      exportAbortController.signal.aborted ||
      !ctx.refs.isMountedRef.current ||
      ctx.refs.exportGraphVersionRef.current !== exportGraphVersion ||
      ctx.refs.sessionRef.current?.id !== exportSessionId
    ) {
      return
    }

    if (hadAttempt && outcome === 'resource-failure') {
      // The failure stays as a hint for the next export of this source.
      ctx.atoms.refreshExportInterruption()
    }

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
    // An export dropped before its job ran ended without an interruption.
    endAttempt('cancelled')
    if (ctx.refs.exportAbortControllerRef.current === exportAbortController) {
      ctx.refs.exportAbortControllerRef.current = null
    }
  }
}
