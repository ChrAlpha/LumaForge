import type { ColorGraphIntent, LUTData } from '@lumaforge/luma-color-runtime'
import {
  pickColorGraphIntent,
  resolveExportColorGraph,
} from '@lumaforge/luma-color-runtime'
import type {
  ExportGeometry,
  ExportOutputResult,
} from '@lumaforge/render-engine/export'
import type { PerformancePreference } from '@lumaforge/render-engine/policy'

import {
  emitExportDebugEvent,
  toExportPlanSelectedDebugPayload,
} from '~/lib/export/execution-profile'
import { toExportAttemptPlan } from '~/lib/export/export-plan'
import type { FullResWorkerOutputLocation } from '~/lib/export/full-res-export-client'
import {
  reserveOpfsOutputDirectory,
  scheduleAbandonedOpfsOutputCollection,
} from '~/lib/export/opfs-output-lifetime'
import type { ResourceRegistry } from '~/lib/export/resource-registry'
import type { DecodedImage, ImageMetadata } from '~/lib/raw/decoder'

import type {
  ExportResult,
  FullResExportReason,
} from '../../model/export-result'
import type { ImageSession, TransformIntent } from '../../model/session'
import type { ProcessingStatus } from '../../model/workflow'
import {
  getStableErrorCode,
  isRetryableFullResExportFailure,
  toUserFacingErrorCode,
} from '../ingest/workflow-status'
import {
  buildManifestForExportResult,
  ExportManifestUnavailableError,
  sealExportResultManifest,
} from './attach-export-manifest'
import {
  createPreExportSnapshot,
  evacuateBeforeExport,
  getPreExportEvacuationOwners,
  toResourceEvacuatedDebugPayload,
} from './export-evacuation'
import type { ExportAttemptOutcome } from './export-interruption'
import { resolveExportEnvironment } from './export-manifest'
import {
  deriveFullResExportReadiness,
  deriveTransformExportRefusalReason,
  planFullResExport,
  planFullResExportRequest,
} from './export-readiness'
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
import { captureExportResultIdentity } from './export-result-identity'
import { createCompletedExportResult } from './export-result-materialization'
import {
  claimExportSlot,
  clearExportResultForActiveExport,
  clearExportResultState,
  isLatestExportClaim,
} from './export-state'
import {
  buildExportFilename,
  createExportPolicyRefusal,
  EXPORT_JPEG_QUALITY,
  recommendRetryLevel,
  runFullResolutionExportJob,
  sampleExportPlanFacts,
} from './export-system'

/**
 * What a full-resolution export tells the user. An attempt reports each one
 * only while it is current, and a refusal or a failure carries its structured
 * reason or the runtime's message as given; how and when each is shown, and
 * in which locale, belongs to the caller.
 */
export type FullResExportNotification =
  /** The attempt claimed the export slot: earlier notices no longer apply. */
  | { kind: 'started' }
  /** The export cannot start, or a running attempt can no longer finish. */
  | { kind: 'refused'; refusal: FullResExportReason }
  /**
   * The attempt failed with the stable `code` the session records and the
   * runtime's `message`, null when what it threw carried none; `retryLevel`
   * is the safer plan to retry with.
   */
  | {
      kind: 'failed'
      code: string
      message: string | null
      retryLevel: Exclude<PerformancePreference, 'max'> | null
    }

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
    /**
     * The session the caller rendered with. Admission refuses when the live
     * session is another source; nothing else reads it.
     */
    session: ImageSession | null
    /**
     * Reads the session from the store when called, so a write in the same
     * tick is seen before any rerender. Admission and every later currency
     * check read it here.
     */
    getSession: () => ImageSession | null
    /**
     * Reads the color intent the photo renders with from the store when
     * called; view state plays no part in it. The export samples it once,
     * when the command is admitted.
     */
    getColorIntent: () => ColorGraphIntent
    /**
     * Reads the LUT the store holds when called. A LUT apply or a contract
     * change writes it in the same tick as the session's look and the
     * color, so the export samples all three together, when the command is
     * admitted.
     */
    getLutData: () => LUTData | null
    decodedImageRef: { current: DecodedImage | null }
    /** Asks the page to read the loaded source's interruption hint again. */
    refreshExportInterruption: () => void
  }
  refs: {
    exportAbortControllerRef: { current: AbortController | null }
    exportGraphVersionRef: { current: number }
    isMountedRef: { current: boolean }
    resourceRegistryRef: { current: ResourceRegistry | null }
  }
  services: {
    notify: (notification: FullResExportNotification) => void
    abortExportWork: () => void
    /**
     * The preview's RAW runtime on the workflow host. Evacuation cancels its
     * session lease and preview work; the export worker starts only after
     * `terminate` stopped the host's decode worker. Neither reaches the
     * export's own cancellation: the export worker runs its own runtime.
     */
    previewRuntime: {
      cancel: () => void
      terminate: () => void | Promise<void>
    }
    registerCurrentPreviewPipelineForEvacuation: () => void
    registerExportResultResource: (result: ExportResult) => void
    revokeCurrentEmbeddedPreviewUrl: () => void
    interruptionMarkers: Pick<
      ExportInterruptionMarkers,
      'begin' | 'finish' | 'retire'
    >
  }
}

let lastExportAttempt = 0

/**
 * Unique per call: without `randomUUID` the counter keeps two exports
 * started in the same millisecond apart.
 */
function createExportId() {
  lastExportAttempt += 1
  return (
    globalThis.crypto?.randomUUID?.() ??
    `export-${Date.now()}-${lastExportAttempt}`
  )
}

/**
 * One full-resolution export attempt, fixed when it starts: the source it
 * reads, the export graph generation, the Transform intent and geometry it
 * was admitted with, and its own abort controller.
 */
type FullResExportAttempt = Readonly<{
  sessionId: string
  graphVersion: number
  transformIntent: TransformIntent | undefined
  exportGeometry: ExportGeometry | null
  controller: AbortController
}>

/**
 * Where an attempt stands. It is `obsolete` once the view unmounts, its
 * signal aborts, a later attempt has claimed the export slot (even one that
 * has since ended), the export graph moves, another source loads, or the
 * source asks for another Transform or holds another geometry. Every edit
 * makes a new intent, so asking again for an earlier Transform does not make
 * an attempt current again; an event that asks for the same Transform keeps
 * the intent, so it leaves the attempt current. Whoever made it obsolete
 * settles the workflow.
 *
 * While it still works towards its JPEG, an attempt also needs the live
 * Transform to stay one export may reproduce. A new frame or a failure that
 * leaves it pending, invalid or unavailable makes no edit, so nothing else
 * ends the attempt: it stands `refused`, with the refusal, and ends itself.
 * Once the JPEG is delivered the session keeps it through such events, so
 * sealing its manifest reads only whether the attempt is obsolete.
 */
type AttemptStanding =
  | { kind: 'current' }
  | { kind: 'obsolete' }
  | { kind: 'refused'; refusal: FullResExportReason }

function readAttemptStanding(
  ctx: ExportContext,
  attempt: FullResExportAttempt,
  stage: 'work' | 'sealing',
): AttemptStanding {
  const { refs } = ctx
  const live = ctx.atoms.getSession()
  if (
    !refs.isMountedRef.current ||
    attempt.controller.signal.aborted ||
    !isLatestExportClaim(refs.exportAbortControllerRef, attempt.controller) ||
    refs.exportGraphVersionRef.current !== attempt.graphVersion ||
    !live ||
    live.id !== attempt.sessionId ||
    live.transform?.intent !== attempt.transformIntent ||
    (live.exportGeometry ?? null) !== attempt.exportGeometry
  ) {
    return { kind: 'obsolete' }
  }
  if (stage === 'sealing') return { kind: 'current' }
  const refusal = deriveTransformExportRefusalReason(live, 'full-resolution')
  return refusal ? { kind: 'refused', refusal } : { kind: 'current' }
}

/**
 * Removes a finished output no export result took. Only a file-backed output
 * holds storage of its own; failing to remove it is logged, never thrown.
 */
function discardUnadoptedOutput(output: ExportOutputResult | undefined) {
  if (output?.kind !== 'file-backed' || !output.cleanup) return
  const warn = (error: unknown) => {
    console.warn('Failed to remove an export output no result took:', error)
  }
  try {
    void output.cleanup().catch(warn)
  } catch (error) {
    warn(error)
  }
}

export type FullResExportRequest = {
  /** How hard the plan may push this device; never the JPEG quality. */
  performancePreference?: PerformancePreference
  /** The hint read for the loaded source; it applies only to that file. */
  interruption?: SourceInterruptionHint
}

export async function orchestrateFullResExport(
  options: FullResExportRequest = {},
  ctx: ExportContext,
): Promise<void> {
  const performancePreference = options.performancePreference ?? 'balanced'

  const rawRenderExposure =
    ctx.atoms.decodedImageRef.current?.renderExposure ?? null
  const sourceFile = ctx.atoms.loadedImage.file
  // The live session answers only for the source the caller rendered: a
  // source loaded since then is still loading as far as this command knows.
  const currentSession = ctx.atoms.getSession()
  const exportReadiness = deriveFullResExportReadiness({
    sourceFile,
    session:
      currentSession?.id === ctx.atoms.session?.id ? currentSession : null,
    rawRenderExposure,
  })
  // The refusal stays structured up to the caller, which alone turns it into
  // copy. Runtime diagnostics travel as given.
  const refuse = (refusal: FullResExportReason) => {
    ctx.services.notify({ kind: 'refused', refusal })
  }
  if (!exportReadiness.canExport) {
    refuse(exportReadiness.refusal)
    return
  }

  const activeSession = exportReadiness.session
  // Read from the live session as the action runs, so an action a surface
  // captured before the Transform was edited still refuses.
  const transformRefusal = deriveTransformExportRefusalReason(
    activeSession,
    'full-resolution',
  )
  if (transformRefusal) {
    refuse(transformRefusal)
    return
  }

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
  // Sized from the sensor frame the worker decodes, whatever the geometry
  // crops. The request holds no device facts; those are sampled for this
  // export once it owns the export slot.
  const planRequest = planFullResExportRequest({
    source: { width: exportCapability.width, height: exportCapability.height },
    performancePreference,
    interruption,
  })

  // Sampled once, from the store, as the command is admitted: one copy of
  // the full intent and the LUT read in the same instant as the session
  // feeds the graph, the pre-export snapshot, the result's identity and the
  // manifest's look, whatever the store holds afterwards. The strength goes
  // in as given: zero keeps the LUT and its contract checks, it does not
  // clear the look.
  const colorIntent = pickColorGraphIntent(ctx.atoms.getColorIntent())
  const lut = ctx.atoms.getLutData()
  const graph = resolveExportColorGraph({
    ...colorIntent,
    lut,
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
  // The request the result will answer, fixed from the same reads the graph
  // took; the result and its manifest carry it whatever moves meanwhile.
  const identity = captureExportResultIdentity({
    resultKind: 'full-resolution',
    attemptId: createExportId(),
    sessionId: activeSession.id,
    sourceFile: activeSourceFile,
    intent: colorIntent,
    lut,
    rawRenderExposure: activeRawRenderExposure,
    geometry: exportGeometry,
  })

  const exportSessionId = activeSession.id
  const exportGraphVersion = ctx.refs.exportGraphVersionRef.current
  ctx.services.abortExportWork()
  const attempt: FullResExportAttempt = Object.freeze({
    sessionId: exportSessionId,
    graphVersion: exportGraphVersion,
    transformIntent: activeSession.transform?.intent,
    exportGeometry,
    controller: new AbortController(),
  })
  const exportAbortController = attempt.controller
  claimExportSlot(
    ctx.refs.exportAbortControllerRef,
    exportAbortController,
    identity.attemptId,
  )

  // Checked before every write that follows an asynchronous step. A refused
  // attempt stops its own work and settles the workflow with the reason.
  // Having claimed the export slot, it already left any earlier result
  // undeliverable, so it drops that result and its resources too rather
  // than leave the session offering a JPEG it cannot hand over.
  const isCurrentExport = () => {
    const standing = readAttemptStanding(ctx, attempt, 'work')
    if (standing.kind === 'refused') {
      exportAbortController.abort()
      const replacedResult = Boolean(ctx.atoms.getSession()?.exportState.result)
      ctx.atoms.setSession((prev) =>
        prev && prev.id === exportSessionId
          ? clearExportResultState(prev)
          : prev,
      )
      if (replacedResult) {
        void ctx.refs.resourceRegistryRef.current
          ?.disposeOwners(['export-result'])
          .catch((error: unknown) => {
            console.warn('Failed to release the replaced export result:', error)
          })
      }
      ctx.atoms.setStatus('ready')
      ctx.atoms.setProgress(0)
      refuse(standing.refusal)
    }
    return standing.kind === 'current'
  }
  const isCurrentSeal = () =>
    readAttemptStanding(ctx, attempt, 'sealing').kind === 'current'

  // This attempt's marker, from just before the worker work until the
  // attempt ends; each attempt ends only its own marker.
  const markers = ctx.services.interruptionMarkers
  let markedAttempt: string | null = null
  // The job's finished output belongs to this attempt until a registered
  // result holds it. Whatever ends the attempt before then removes it.
  let unadoptedOutput: ExportOutputResult | undefined
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
    ctx.services.notify({ kind: 'started' })
    // The device facts are sampled now, for this export. Facts sampled for
    // an attempt that is no longer current plan nothing.
    const sampledFacts = await sampleExportPlanFacts()
    if (!isCurrentExport()) {
      return
    }
    // Outputs left by closed tabs are collected once per page at idle time;
    // this export never waits for it and cannot fail because of it.
    scheduleAbandonedOpfsOutputCollection()
    const planned = planFullResExport(planRequest, sampledFacts)
    if (planned.kind === 'refuse') {
      throw createExportPolicyRefusal()
    }
    const jobExecutionPlan = planned.plan
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

    const activePlan = toExportAttemptPlan(jobExecutionPlan)

    // Capture the current GPU pipeline before the active plan suspends
    // PreviewCanvas and clears the ref; evacuation releases it.
    ctx.services.registerCurrentPreviewPipelineForEvacuation()

    // No export state outlives the tab: an interrupted export always starts
    // again from the first row, whatever the sink.
    emitExportDebugEvent({
      type: 'export-plan-selected',
      payload: toExportPlanSelectedDebugPayload(jobExecutionPlan),
    })

    ctx.atoms.setSession((prev) =>
      prev && prev.id === exportSessionId
        ? {
            ...prev,
            exportState: {
              ...prev.exportState,
              status: 'exporting',
              activePlan,
              result: undefined,
              lastProgress: undefined,
              retryRecommended: false,
              recommendedRetryLevel: undefined,
            },
          }
        : prev,
    )

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
      jobExecutionPlan.profileName,
    )
    const evacuation = await evacuateBeforeExport({
      registry,
      snapshot,
      owners: evacuationOwners,
      abortPreview: () => {
        ctx.services.previewRuntime.cancel()
        ctx.services.revokeCurrentEmbeddedPreviewUrl()
      },
      abortBoundedHq: ctx.services.previewRuntime.cancel,
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
        profile: jobExecutionPlan.profileName,
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

    const result = await runFullResolutionExportJob({
      file: activeSourceFile,
      filename,
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
          payload: toExportPlanSelectedDebugPayload(plan),
        })
        ctx.atoms.setSession((prev) =>
          prev && prev.id === exportSessionId
            ? {
                ...prev,
                exportState: {
                  ...prev.exportState,
                  activePlan: toExportAttemptPlan(plan),
                },
              }
            : prev,
        )
      },
      onProgress: (entry) => {
        if (!isCurrentExport()) return

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
      beforeStart: ctx.services.previewRuntime.terminate,
      signal: exportAbortController.signal,
    })
    unadoptedOutput = result.output
    // The job finished, so the attempt is over even if its JPEG is dropped.
    endAttempt('completed')

    const completedSession = ctx.atoms.getSession()
    if (
      !isCurrentExport() ||
      !completedSession ||
      completedSession.exportState.fullResCapability.status !== 'supported'
    ) {
      return
    }
    const completedCapability = completedSession.exportState.fullResCapability

    const exportResult = createCompletedExportResult({
      jobResult: result,
      kind: identity.resultKind,
      metadata: ctx.atoms.loadedImage.metadata,
      width: deliveredSize.width,
      height: deliveredSize.height,
      copyCapability: resolveExportCopyCapability(),
      manifestState: { status: 'sealing' },
      identity,
    })
    ctx.services.registerExportResultResource(exportResult)
    unadoptedOutput = undefined

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
    // delivered JPEG never delays the download; a failure only logs. Either
    // outcome lands only while no later attempt or edit has replaced it, and
    // records the request the result's identity names.
    void buildManifestForExportResult({
      result: exportResult,
      sourceFile: activeSourceFile,
      graph,
      sourceDimensions: {
        width: completedCapability.width,
        height: completedCapability.height,
      },
      style: activeSession.activeStyle,
      quality: EXPORT_JPEG_QUALITY,
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
        if (!isCurrentSeal()) return
        ctx.atoms.setSession((prev) =>
          prev &&
          prev.id === exportSessionId &&
          prev.exportState.result === exportResult
            ? {
                ...prev,
                exportState: {
                  ...prev.exportState,
                  result: sealExportResultManifest(exportResult, {
                    status: 'ready',
                    manifest,
                  }),
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
        if (!isCurrentSeal()) return
        const reason =
          error instanceof ExportManifestUnavailableError
            ? error.reason
            : 'internal'
        ctx.atoms.setSession((prev) =>
          prev &&
          prev.id === exportSessionId &&
          prev.exportState.result === exportResult
            ? {
                ...prev,
                exportState: {
                  ...prev.exportState,
                  result: sealExportResultManifest(exportResult, {
                    status: 'unavailable',
                    reason,
                  }),
                },
              }
            : prev,
        )
        emitExportDebugEvent({
          type: 'export-manifest-failed',
          payload: {
            reason,
            message: error instanceof Error ? error.message : String(error),
          },
        })
      })
  } catch (err) {
    const message = err instanceof Error ? err.message : null
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

    if (!isCurrentExport()) {
      return
    }

    if (hadAttempt && outcome === 'resource-failure') {
      // The failure stays as a hint for the next export of this source.
      ctx.atoms.refreshExportInterruption()
    }

    const retryLevel = isRetryableFullResExportFailure(errorCode)
      ? recommendRetryLevel(performancePreference)
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
    ctx.services.notify({
      kind: 'failed',
      code: errorCode,
      message,
      retryLevel,
    })
  } finally {
    discardUnadoptedOutput(unadoptedOutput)
    // An export dropped before its job ran ended without an interruption.
    endAttempt('cancelled')
    if (ctx.refs.exportAbortControllerRef.current === exportAbortController) {
      ctx.refs.exportAbortControllerRef.current = null
    }
  }
}
