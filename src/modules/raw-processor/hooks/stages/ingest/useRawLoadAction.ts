import { useCallback, useMemo } from 'react'

import type { RawLoadContext } from '../../../services/ingest/orchestrate-raw-load'
import { orchestrateRawLoad } from '../../../services/ingest/orchestrate-raw-load'

export type UseRawLoadActionInput = RawLoadContext['atoms'] &
  RawLoadContext['services'] &
  RawLoadContext['refs'] & {
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
      runtimeWorkSessionIdRef,
      scheduleToast,
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
