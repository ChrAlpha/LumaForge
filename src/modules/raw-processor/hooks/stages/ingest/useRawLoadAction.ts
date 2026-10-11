import { useCallback, useMemo } from 'react'
import { toast } from 'sonner'

import type {
  RawLoadContext,
  RawLoadNotification,
} from '../../../services/ingest/orchestrate-raw-load'
import { orchestrateRawLoad } from '../../../services/ingest/orchestrate-raw-load'

export type UseRawLoadActionInput = RawLoadContext['atoms'] &
  Omit<RawLoadContext['services'], 'notify'> &
  RawLoadContext['refs'] & {
    /** Runs a toast after the current commit, and only while mounted. */
    scheduleToast: (show: () => void) => void
    orchestrateLoad?: typeof orchestrateRawLoad
  }

function showRawLoadNotification(notification: RawLoadNotification) {
  switch (notification.kind) {
    case 'preview-unavailable':
      toast.error('Preview unavailable', {
        description:
          'Full-resolution export needs a decoded RAW preview exposure before it can run.',
      })
      break
    case 'loaded':
      toast.success(`Loaded ${notification.fileName}`, {
        description: `${notification.width}×${notification.height} • ${notification.make || 'Unknown'} ${notification.model || ''}`,
      })
      break
    case 'load-failed':
      toast.error('Failed to load RAW file', {
        description: notification.message,
      })
      break
  }
}

export function useRawLoadAction({
  setStatus,
  setError,
  setProgress,
  getColorIntent,
  getView,
  getLut,
  setColorIntent,
  getSession,
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
  beginRuntimeSession,
  decodedImageRef,
  embeddedPreviewUrlRef,
  isMountedRef,
  runtimeWorkSessionIdRef,
  pendingLoadSessionIdRef,
  previewCopyCanvasRef,
  orchestrateLoad = orchestrateRawLoad,
}: UseRawLoadActionInput) {
  // The load decides what to report while it owns the session; the toast
  // itself waits for the scheduled post-commit task.
  const notify = useCallback(
    (notification: RawLoadNotification) => {
      scheduleToast(() => showRawLoadNotification(notification))
    },
    [scheduleToast],
  )

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
        getSession,
        setSession,
        setDecodedImageVersion,
        setStats,
      },
      services: {
        notify,
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
        beginRuntimeSession,
      },
      refs: {
        decodedImageRef,
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
      beginRuntimeSession,
      clearSessionEmbeddedPreviewUrl,
      decodedImageRef,
      embeddedPreviewUrlRef,
      getColorIntent,
      getLut,
      getPrewarmState,
      getSession,
      getView,
      invalidateExportGraph,
      isMountedRef,
      pendingLoadSessionIdRef,
      previewCopyCanvasRef,
      queueExportResultResourceDisposal,
      registerCurrentPreviewPipelineForEvacuation,
      replaceFile,
      revokeCurrentEmbeddedPreviewUrl,
      notify,
      runtimeWorkSessionIdRef,
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
