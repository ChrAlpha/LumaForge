import { useCallback, useMemo } from 'react'

import { useI18n } from '~/lib/i18n'

import type {
  ExportContext,
  FullResExportRequest,
} from '../../../services/export/orchestrate-full-res-export'
import { orchestrateFullResExport } from '../../../services/export/orchestrate-full-res-export'

export type UseFullResExportActionInput = ExportContext['atoms'] &
  ExportContext['refs'] &
  Omit<ExportContext['services'], 't'> & {
    orchestrateExport?: typeof orchestrateFullResExport
  }

export function useFullResExportAction({
  loadedImage,
  session,
  getSession,
  getColorIntent,
  getLutData,
  stats,
  decodedImageRef,
  exportAbortControllerRef,
  exportGraphVersionRef,
  isMountedRef,
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
  const { t } = useI18n()
  const exportCtx = useMemo<ExportContext>(
    () => ({
      atoms: {
        setStatus,
        setError,
        setProgress,
        setSession,
        loadedImage,
        session,
        getSession,
        getColorIntent,
        getLutData,
        decodedImageRef,
        stats,
        refreshExportInterruption,
      },
      refs: {
        exportAbortControllerRef,
        exportGraphVersionRef,
        isMountedRef,
        pipelineRef,
        resourceRegistryRef,
        previewCopyCanvasRef,
      },
      services: {
        scheduleToast,
        t,
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
      getColorIntent,
      getLutData,
      getSession,
      interruptionMarkers,
      isMountedRef,
      loadedImage,
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
      setError,
      setProgress,
      setSession,
      setStatus,
      stats,
      t,
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
