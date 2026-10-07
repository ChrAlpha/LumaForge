import { useCallback, useMemo } from 'react'

import type {
  RawRuntimeHost,
  RawRuntimeSessionLease,
} from '~/lib/raw/raw-runtime-host'

import type { RawLoadContext } from '../../../services/ingest/orchestrate-raw-load'
import { orchestrateRawLoad } from '../../../services/ingest/orchestrate-raw-load'

export type UseRawLoadActionInput = RawLoadContext['atoms'] &
  Omit<RawLoadContext['services'], 'beginRuntimeSession'> &
  RawLoadContext['refs'] & {
    /** The workflow host's lease for the next load's source session. */
    beginRuntimeSession: RawRuntimeHost['beginSession']
    /**
     * Restore and the runtime controls still cancel preview work through
     * this ref, so each load's lease is reachable from it while it lasts.
     */
    runtimeAbortControllerRef: { current: AbortController | null }
    orchestrateLoad?: typeof orchestrateRawLoad
  }

export function useRawLoadAction({
  setStatus,
  setError,
  setProgress,
  getColorIntent,
  getView,
  getLut,
  setColorIntent,
  setSession,
  setDecodedImageVersion,
  setStats,
  scheduleToast,
  replaceFile,
  abortRuntimeWork,
  abortExportWork,
  queueExportResultResourceDisposal,
  revokeCurrentEmbeddedPreviewUrl,
  clearSessionEmbeddedPreviewUrl,
  setDecodedImageRef,
  invalidateExportGraph,
  registerCurrentPreviewPipelineForEvacuation,
  yieldToPaint,
  getPrewarmState,
  prewarm,
  beginRuntimeSession,
  runtimeAbortControllerRef,
  decodedImageRef,
  sessionRef,
  embeddedPreviewUrlRef,
  isMountedRef,
  runtimeWorkSessionIdRef,
  pendingLoadSessionIdRef,
  previewCopyCanvasRef,
  orchestrateLoad = orchestrateRawLoad,
}: UseRawLoadActionInput) {
  const beginLoadSession = useCallback((): RawRuntimeSessionLease => {
    const lease = beginRuntimeSession()
    // Aborting the shared ref cancels this lease on the host, which aborts
    // its native work and disposes its session.
    const cancellation: AbortController = {
      signal: lease.signal,
      abort: () => lease.cancel(),
    }
    const forget = () => {
      if (runtimeAbortControllerRef.current === cancellation) {
        runtimeAbortControllerRef.current = null
      }
    }
    runtimeAbortControllerRef.current = cancellation
    lease.signal.addEventListener('abort', forget, { once: true })
    return {
      signal: lease.signal,
      open: lease.open,
      release() {
        lease.release()
        forget()
      },
      cancel: lease.cancel,
    }
  }, [beginRuntimeSession, runtimeAbortControllerRef])

  const rawLoadCtx = useMemo<RawLoadContext>(
    () => ({
      atoms: {
        setStatus,
        setError,
        setProgress,
        getColorIntent,
        getView,
        getLut,
        setColorIntent,
        setSession,
        setDecodedImageVersion,
        setStats,
      },
      services: {
        scheduleToast,
        replaceFile,
        abortRuntimeWork,
        abortExportWork,
        queueExportResultResourceDisposal,
        revokeCurrentEmbeddedPreviewUrl,
        clearSessionEmbeddedPreviewUrl,
        setDecodedImageRef,
        invalidateExportGraph,
        registerCurrentPreviewPipelineForEvacuation,
        yieldToPaint,
        getPrewarmState,
        prewarm,
        beginRuntimeSession: beginLoadSession,
      },
      refs: {
        decodedImageRef,
        sessionRef,
        embeddedPreviewUrlRef,
        isMountedRef,
        runtimeWorkSessionIdRef,
        pendingLoadSessionIdRef,
        previewCopyCanvasRef,
      },
    }),
    [
      abortExportWork,
      abortRuntimeWork,
      beginLoadSession,
      clearSessionEmbeddedPreviewUrl,
      decodedImageRef,
      embeddedPreviewUrlRef,
      getColorIntent,
      getLut,
      getPrewarmState,
      getView,
      invalidateExportGraph,
      isMountedRef,
      pendingLoadSessionIdRef,
      prewarm,
      previewCopyCanvasRef,
      queueExportResultResourceDisposal,
      registerCurrentPreviewPipelineForEvacuation,
      replaceFile,
      revokeCurrentEmbeddedPreviewUrl,
      runtimeWorkSessionIdRef,
      scheduleToast,
      sessionRef,
      setColorIntent,
      setDecodedImageRef,
      setDecodedImageVersion,
      setError,
      setProgress,
      setSession,
      setStats,
      setStatus,
      yieldToPaint,
    ],
  )

  const loadFile = useCallback(
    (file: File) => orchestrateLoad(file, rawLoadCtx),
    [orchestrateLoad, rawLoadCtx],
  )

  return { loadFile }
}
