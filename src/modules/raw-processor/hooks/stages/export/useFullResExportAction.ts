import { useCallback, useMemo } from 'react'

import type {
  ExportContext,
  FullResExportRequest,
} from '../../../services/export/orchestrate-full-res-export'
import { orchestrateFullResExport } from '../../../services/export/orchestrate-full-res-export'

export type UseFullResExportActionInput = ExportContext['atoms'] &
  ExportContext['refs'] &
  ExportContext['services'] & {
    orchestrateExport?: typeof orchestrateFullResExport
  }

export function useFullResExportAction({
  loadedImage,
  session,
  params,
  stats,
  lutDataRef,
  decodedImageRef,
  exportAbortControllerRef,
  exportGraphVersionRef,
  isMountedRef,
  sessionRef,
  pipelineRef,
  resourceRegistryRef,
  previewCopyCanvasRef,
  setStatus,
  setError,
  setProgress,
  setSession,
  refreshExportInterruption,
  scheduleToast,
  abortExportWork,
  previewRuntime,
  registerCurrentPreviewPipelineForEvacuation,
  registerExportResultResource,
  revokeCurrentEmbeddedPreviewUrl,
  interruptionMarkers,
  orchestrateExport = orchestrateFullResExport,
}: UseFullResExportActionInput) {
  const exportCtx = useMemo<ExportContext>(
    () => ({
      atoms: {
        setStatus,
        setError,
        setProgress,
        setSession,
        loadedImage,
        session,
        params,
        lutDataRef,
        decodedImageRef,
        stats,
        refreshExportInterruption,
      },
      refs: {
        exportAbortControllerRef,
        exportGraphVersionRef,
        isMountedRef,
        sessionRef,
        pipelineRef,
        resourceRegistryRef,
        previewCopyCanvasRef,
      },
      services: {
        scheduleToast,
        abortExportWork,
        previewRuntime,
        registerCurrentPreviewPipelineForEvacuation,
        registerExportResultResource,
        revokeCurrentEmbeddedPreviewUrl,
        interruptionMarkers,
      },
    }),
    [
      abortExportWork,
      decodedImageRef,
      exportAbortControllerRef,
      exportGraphVersionRef,
      interruptionMarkers,
      isMountedRef,
      loadedImage,
      lutDataRef,
      params,
      pipelineRef,
      previewCopyCanvasRef,
      previewRuntime,
      refreshExportInterruption,
      registerCurrentPreviewPipelineForEvacuation,
      registerExportResultResource,
      resourceRegistryRef,
      revokeCurrentEmbeddedPreviewUrl,
      scheduleToast,
      session,
      sessionRef,
      setError,
      setProgress,
      setSession,
      setStatus,
      stats,
    ],
  )

  const exportImage = useCallback(
    async (request: FullResExportRequest = {}) => {
      await orchestrateExport(request, exportCtx)
    },
    [exportCtx, orchestrateExport],
  )

  return { exportImage }
}
