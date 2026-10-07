import type { ColorGraphIntent } from '@lumaforge/luma-color-runtime'
import { deriveInteractivePolicy } from '@lumaforge/render-engine/policy'
import { createProgressivePreviewPlan } from '@lumaforge/render-engine/preview'
import { toast } from 'sonner'

import type { ParsedLUT } from '~/lib/lut/cube-parser'
import { resolvePreviewBackend } from '~/lib/preview/gpu-backend'
import type { PreviewView } from '~/lib/preview/preview-view'
import type { DecodedImage } from '~/lib/raw/decoder'
import { isSupportedRaw } from '~/lib/raw/decoder'
import type { RawRuntimeSessionLease } from '~/lib/raw/raw-runtime-host'
import type { PrewarmOutcome, PrewarmState } from '~/lib/raw/runtime-adapter'
import {
  detectCapabilityVector,
  getCapabilityVectorSnapshot,
} from '~/lib/runtime/capability-vector'
import {
  derivePreviewGpuBudget,
  detectPreviewGpuCapabilitySnapshot,
} from '~/lib/runtime/preview-gpu-budget'
import type { PipelineStats } from '~/lib/webgpu/raw-processing-pipeline'

import type { DisplaySource, ImageSession } from '../../model/session'
import type { RetainedSessionState } from '../../model/session-factory'
import type { ProcessingStatus } from '../../model/workflow'
import { toFullResCapabilityState } from '../export/export-state'
import { resolveActiveLook } from '../look/look-session-state'
import {
  createEmbeddedPreviewObjectUrl,
  revokeEmbeddedPreviewObjectUrls,
} from '../preview/embedded-preview-url'
import { runPreviewPipeline } from '../preview/preview-pipeline'
import {
  applyBoundedHqPreviewFailure,
  applyBoundedHqPreviewSkipped,
  applyPreviewLoadStarted,
  applyPreviewReady,
  applyQuickPreviewFailure,
} from '../preview/preview-session-state'
import { prepareRawLoadState } from './raw-load-preparation'
import {
  getStableErrorCode,
  mapRawDecodePhaseToProcessingStatus,
  toUserFacingErrorCode,
} from './workflow-status'

class RawAdapterErrorLike extends Error {
  readonly code = 'RAW_PREWARM_FAILED'
  constructor(message: string) {
    super(message)
    this.name = 'RawAdapterError'
  }
}

export interface RawLoadContext {
  atoms: {
    setStatus: (status: ProcessingStatus) => void
    setError: (error: string | null) => void
    setProgress: (progress: number) => void
    /** The color intent the photo renders with when the load starts. */
    getColorIntent: () => ColorGraphIntent
    /** The view in effect when the load starts; its split carries over. */
    getView: () => PreviewView
    getLut: () => ParsedLUT | null
    /** Writes the detached color intent; it never carries view state. */
    setColorIntent: (
      value: ColorGraphIntent | ((prev: ColorGraphIntent) => ColorGraphIntent),
    ) => void
    setSession: (
      value:
        | ImageSession
        | null
        | ((prev: ImageSession | null) => ImageSession | null),
    ) => void
    setDecodedImageVersion: (value: number | ((prev: number) => number)) => void
    setStats: (stats: PipelineStats | null) => void
  }
  services: {
    scheduleToast: (notify: () => void) => void
    replaceFile: (
      file: File,
      retainedSessionState: RetainedSessionState,
    ) => ImageSession
    abortRuntimeWork: () => void
    abortExportWork: () => void
    queueExportResultResourceDisposal: () => void
    revokeCurrentEmbeddedPreviewUrl: () => void
    clearSessionEmbeddedPreviewUrl: (id?: string) => void
    setDecodedImageRef: (next: DecodedImage | null) => void
    invalidateExportGraph: () => void
    registerCurrentPreviewPipelineForEvacuation: () => void
    yieldToPaint: () => Promise<void>
    getPrewarmState: () => PrewarmState
    prewarm: () => Promise<PrewarmOutcome>
    /**
     * Hands this load the host's session lease, on the host the load
     * prewarmed. The host owns the native session and its cancellation; the
     * load only decides when it is done with them.
     */
    beginRuntimeSession: () => RawRuntimeSessionLease
  }
  refs: {
    decodedImageRef: { current: DecodedImage | null }
    sessionRef: { current: ImageSession | null }
    embeddedPreviewUrlRef: { current: string | null }
    isMountedRef: { current: boolean }
    runtimeWorkSessionIdRef: { current: string | null }
    pendingLoadSessionIdRef: { current: string | null }
    previewCopyCanvasRef: { current: HTMLCanvasElement | null }
  }
}

export async function orchestrateRawLoad(
  file: File,
  ctx: RawLoadContext,
): Promise<void> {
  if (!isSupportedRaw(file)) {
    ctx.atoms.setError(`Unsupported file format: ${file.name}`)
    return
  }

  let loadSessionId: string | null = null
  let lease: RawRuntimeSessionLease | null = null
  let previewCompleted = false
  let releaseLeaseInFinally = true

  try {
    const initialPhase: 'warming' | 'loading' =
      ctx.services.getPrewarmState() === 'ready' ? 'loading' : 'warming'

    ctx.atoms.setStatus(initialPhase)
    ctx.atoms.setProgress(0)
    ctx.atoms.setError(null)

    ctx.refs.runtimeWorkSessionIdRef.current = null
    ctx.refs.pendingLoadSessionIdRef.current = null
    ctx.services.abortExportWork()
    ctx.services.abortRuntimeWork()
    ctx.services.queueExportResultResourceDisposal()
    ctx.services.revokeCurrentEmbeddedPreviewUrl()
    ctx.refs.previewCopyCanvasRef.current = null
    const loadLease = ctx.services.beginRuntimeSession()
    lease = loadLease
    const runtimeSignal = loadLease.signal
    // Read the current look from the store at load time (not from caller
    // closures) so a LUT loaded before any RAW — or replaced while the picker
    // was open — is always the one retained into the new session.
    const colorIntent = ctx.atoms.getColorIntent()
    const lut = ctx.atoms.getLut()
    const activeStyle = resolveActiveLook({
      session: ctx.refs.sessionRef.current,
      lut,
      intensity: colorIntent.intensity,
    })
    const loadState = prepareRawLoadState({
      view: ctx.atoms.getView(),
      lut,
      activeStyle,
    })

    const nextSession = ctx.services.replaceFile(
      file,
      loadState.retainedSessionState,
    )
    loadSessionId = nextSession.id
    let quickPreview: DecodedImage | null = null
    let boundedHqPreview: DecodedImage | null = null

    ctx.refs.sessionRef.current = nextSession
    ctx.refs.runtimeWorkSessionIdRef.current = nextSession.id
    ctx.refs.pendingLoadSessionIdRef.current = nextSession.id
    ctx.services.setDecodedImageRef(null)
    ctx.atoms.setColorIntent((prev) => ({
      ...prev,
      ...loadState.lookSelectionPatch,
    }))

    ctx.atoms.setSession((prev) => {
      if (!prev || prev.id !== nextSession.id) {
        return prev
      }

      return applyPreviewLoadStarted(prev, loadState.compareSplit)
    })

    await ctx.services.yieldToPaint()
    if (!ctx.refs.isMountedRef.current) {
      return
    }

    if (initialPhase === 'warming') {
      const outcome = await ctx.services.prewarm()
      if (!ctx.refs.isMountedRef.current) {
        return
      }
      if (outcome.status === 'failed') {
        throw new RawAdapterErrorLike(outcome.reason ?? 'Prewarm failed.')
      }
      ctx.atoms.setStatus('loading')
    }

    const matchesActiveSession = () =>
      ctx.refs.isMountedRef.current &&
      ctx.refs.runtimeWorkSessionIdRef.current === nextSession.id &&
      ctx.refs.sessionRef.current?.id === nextSession.id

    const updatePreviewState = (
      source: Exclude<DisplaySource, 'none'>,
      payload: {
        width: number
        height: number
        objectUrl?: string
        mimeType?: string
        timings?: Record<string, number | undefined>
      },
      decoded?: DecodedImage | null,
    ) => {
      if (!matchesActiveSession()) {
        return
      }

      ctx.atoms.setSession((prev) => {
        if (!prev || prev.id !== nextSession.id) {
          return prev
        }

        return applyPreviewReady(prev, source, payload, decoded)
      })

      if (decoded) {
        ctx.services.setDecodedImageRef(decoded)
        ctx.atoms.setStatus('ready')
      }
    }

    const capability =
      getCapabilityVectorSnapshot() ?? (await detectCapabilityVector())
    await resolvePreviewBackend()
    if (!matchesActiveSession()) {
      return
    }

    const activeRuntimeSession = await loadLease.open(file)
    if (!matchesActiveSession()) {
      return
    }

    const gpuCapability = detectPreviewGpuCapabilitySnapshot()
    const previewGpuBudget = gpuCapability
      ? derivePreviewGpuBudget({
          capability,
          gpu: gpuCapability,
          sourceWidth: activeRuntimeSession.sourceDimensions.width ?? 0,
          sourceHeight: activeRuntimeSession.sourceDimensions.height ?? 0,
        })
      : undefined
    const interactivePolicy = deriveInteractivePolicy(capability, {
      previewGpuBudget,
    })
    const previewPlan = createProgressivePreviewPlan({
      sourceWidth: activeRuntimeSession.sourceDimensions.width ?? 0,
      sourceHeight: activeRuntimeSession.sourceDimensions.height ?? 0,
      boundedHqMaxPixels: interactivePolicy.boundedHqMaxPixels,
    })

    const probeExportCapability =
      'probeExportCapability' in activeRuntimeSession &&
      typeof activeRuntimeSession.probeExportCapability === 'function'
        ? activeRuntimeSession.probeExportCapability.bind(activeRuntimeSession)
        : null

    let exportCapabilityPromise: Promise<void> | null = null
    const startExportCapabilityProbe = () => {
      if (exportCapabilityPromise) {
        return exportCapabilityPromise
      }

      if (!probeExportCapability) {
        ctx.atoms.setSession((prev) =>
          prev && prev.id === nextSession.id
            ? {
                ...prev,
                exportState: {
                  ...prev.exportState,
                  fullResCapability: {
                    status: 'unsupported',
                    reason:
                      'Full-resolution export is not available in this runtime build yet.',
                  },
                },
              }
            : prev,
        )
        exportCapabilityPromise = Promise.resolve()
        return exportCapabilityPromise
      }

      exportCapabilityPromise = probeExportCapability(runtimeSignal)
        .then((capability) => {
          if (!matchesActiveSession()) {
            return
          }

          ctx.atoms.setSession((prev) =>
            prev && prev.id === nextSession.id
              ? {
                  ...prev,
                  exportState: {
                    ...prev.exportState,
                    fullResCapability: toFullResCapabilityState(capability),
                  },
                }
              : prev,
          )
        })
        .catch((probeError) => {
          if (!matchesActiveSession()) {
            return
          }

          const reason =
            probeError instanceof Error && probeError.message
              ? probeError.message
              : 'Full-resolution export support could not be verified.'

          ctx.atoms.setSession((prev) =>
            prev && prev.id === nextSession.id
              ? {
                  ...prev,
                  exportState: {
                    ...prev.exportState,
                    fullResCapability: {
                      status: 'unsupported',
                      reason,
                    },
                  },
                }
              : prev,
          )
        })

      return exportCapabilityPromise
    }

    const previewResult = await runPreviewPipeline({
      runtimeSession: {
        extractEmbeddedPreview() {
          return activeRuntimeSession.extractEmbeddedPreview(runtimeSignal)
        },
        async decodeQuickRaw() {
          quickPreview = await activeRuntimeSession.decodeQuickRaw(
            ({ phase, progress }) => {
              if (!matchesActiveSession()) {
                return
              }

              ctx.atoms.setStatus(mapRawDecodePhaseToProcessingStatus(phase))
              ctx.atoms.setProgress(progress)
            },
            runtimeSignal,
          )

          return { width: quickPreview.width, height: quickPreview.height }
        },
        async decodeBoundedHqRaw(options) {
          // The pipeline only runs bounded HQ after a quick frame, whose
          // exposure is this source's pin: a size upgrade renders with it
          // rather than with an estimate from the larger frame.
          const pinnedExposure = quickPreview?.renderExposure
          boundedHqPreview = await activeRuntimeSession.decodeBoundedHqRaw(
            pinnedExposure ? { ...options, pinnedExposure } : options,
            undefined,
            runtimeSignal,
          )

          return {
            width: boundedHqPreview.width,
            height: boundedHqPreview.height,
          }
        },
      },
      previewPlan,
      onEvent: (event) => {
        if (!matchesActiveSession()) {
          return
        }

        switch (event.type) {
          case 'embedded-ready': {
            const objectUrl = createEmbeddedPreviewObjectUrl({
              data: event.data,
              mimeType: event.mimeType,
            })
            const previousUrl = ctx.refs.embeddedPreviewUrlRef.current
            if (previousUrl && previousUrl !== objectUrl) {
              revokeEmbeddedPreviewObjectUrls([previousUrl])
            }
            ctx.refs.embeddedPreviewUrlRef.current = objectUrl

            updatePreviewState('embedded', {
              width: event.width,
              height: event.height,
              objectUrl,
              mimeType: event.mimeType,
              timings: event.timings,
            })
            break
          }
          case 'quick-ready': {
            updatePreviewState('quick', event, quickPreview)
            void startExportCapabilityProbe()
            break
          }
          case 'quick-failed': {
            const errorCode = toUserFacingErrorCode(event.errorCode)

            ctx.atoms.setSession((prev) => {
              if (!prev || prev.id !== nextSession.id) {
                return prev
              }

              return applyQuickPreviewFailure(prev, errorCode)
            })
            ctx.atoms.setStatus('error')
            ctx.atoms.setProgress(100)
            ctx.atoms.setError(event.message)
            ctx.services.scheduleToast(() =>
              toast.error('Preview unavailable', {
                description:
                  'Full-resolution export needs a decoded RAW preview exposure before it can run.',
              }),
            )
            break
          }
          case 'bounded-hq-ready': {
            updatePreviewState('bounded-hq', event, boundedHqPreview)
            if (boundedHqPreview) {
              const description = `${boundedHqPreview.width}×${boundedHqPreview.height} • ${boundedHqPreview.metadata.make || 'Unknown'} ${boundedHqPreview.metadata.model || ''}`
              ctx.services.scheduleToast(() =>
                toast.success(`Loaded ${file.name}`, {
                  description,
                }),
              )
            }
            break
          }
          case 'bounded-hq-failed': {
            const errorCode = toUserFacingErrorCode(event.errorCode)

            ctx.atoms.setSession((prev) => {
              if (!prev || prev.id !== nextSession.id) {
                return prev
              }

              return applyBoundedHqPreviewFailure(prev, errorCode)
            })
            break
          }
          case 'bounded-hq-skipped': {
            ctx.atoms.setSession((prev) => {
              if (!prev || prev.id !== nextSession.id) {
                return prev
              }

              return applyBoundedHqPreviewSkipped(prev, event.reason)
            })
            break
          }
        }
      },
    })
    if (exportCapabilityPromise) {
      await exportCapabilityPromise
    }
    previewCompleted = true
    if (ctx.refs.pendingLoadSessionIdRef.current === nextSession.id) {
      ctx.refs.pendingLoadSessionIdRef.current = null
    }

    if (previewResult.boundedHqPromise) {
      // Bounded HQ still decodes on this lease; it is released once HQ settles.
      releaseLeaseInFinally = false
      void previewResult.boundedHqPromise
        .finally(() => {
          if (
            ctx.refs.runtimeWorkSessionIdRef.current === nextSession.id &&
            ctx.refs.sessionRef.current?.id === nextSession.id
          ) {
            ctx.refs.runtimeWorkSessionIdRef.current = null
          }
          loadLease.release()
        })
        .catch(() => undefined)
    } else if (ctx.refs.runtimeWorkSessionIdRef.current === nextSession.id) {
      ctx.refs.runtimeWorkSessionIdRef.current = null
    }
  } catch (err) {
    if (!ctx.refs.isMountedRef.current) {
      return
    }

    if (!loadSessionId) {
      // The load failed before a session existed (look/state preparation or
      // session creation). That window is synchronous, so no newer load can
      // have superseded this one — surface the failure instead of leaving
      // the workflow stuck in warming/loading with no error.
      const message = err instanceof Error ? err.message : 'Failed to load file'
      ctx.atoms.setError(message)
      ctx.atoms.setStatus('error')
      ctx.services.scheduleToast(() =>
        toast.error('Failed to load RAW file', { description: message }),
      )
      return
    }

    if (
      ctx.refs.runtimeWorkSessionIdRef.current !== loadSessionId ||
      ctx.refs.sessionRef.current?.id !== loadSessionId
    ) {
      return
    }

    ctx.refs.runtimeWorkSessionIdRef.current = null
    ctx.refs.pendingLoadSessionIdRef.current = null

    const message = err instanceof Error ? err.message : 'Failed to load file'
    const errorCode = toUserFacingErrorCode(getStableErrorCode(err) ?? message)
    ctx.atoms.setError(message)
    ctx.atoms.setSession((prev) =>
      prev && prev.id === loadSessionId
        ? {
            ...prev,
            renderState: {
              ...prev.renderState,
              status: 'failed',
              lastErrorCode: errorCode,
            },
          }
        : prev,
    )
    ctx.atoms.setStatus('error')
    ctx.services.scheduleToast(() =>
      toast.error('Failed to load RAW file', { description: message }),
    )
  } finally {
    // A load that stopped early aborts what it left in flight; a completed
    // one only gives its session back. Either is a no-op on a lease a newer
    // load or a reset already cancelled.
    if (releaseLeaseInFinally) {
      if (previewCompleted) lease?.release()
      else lease?.cancel()
    }
  }
}
