import type { LUTData } from '@lumaforge/luma-color-runtime'
import { toLUTData } from '@lumaforge/luma-color-runtime'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { toast } from 'sonner'

import { withInterruptionHistory } from '../services/export/export-recovery'
import { hasActiveExport } from '../services/export/export-state'
import {
  useDetachedPreviewViewValue,
  useSetDetachedPreviewView,
} from '../state/preview-view.atoms'
import { useCurrentSession } from '../state/session.atoms'
import {
  getLut,
  getPipelineStats,
  rawWorkflowStore,
  useErrorMessageValue,
  useLutValue,
  usePipelineFactsValue,
  useProcessingParamsValue,
  useProcessingStatusValue,
  useProgressValue,
  useSetPipelineStats,
} from '../state/workflow.atoms'
import { useOriginalReference } from './stages/compare/useOriginalReference'
import { useRawCompareStage } from './stages/compare/useRawCompareStage'
import { useExportDerivedState } from './stages/export/useExportDerivedState'
import { useExportGraphInvalidation } from './stages/export/useExportGraphInvalidation'
import { useExportInterruptionState } from './stages/export/useExportInterruptionState'
import { useExportResourceManagement } from './stages/export/useExportResourceManagement'
import { useExportResultActions } from './stages/export/useExportResultActions'
import { useFullResExportAction } from './stages/export/useFullResExportAction'
import { useHqPreviewExportAction } from './stages/export/useHqPreviewExportAction'
import { useRawIngestStage } from './stages/ingest/useRawIngestStage'
import { useRawRuntimeControls } from './stages/ingest/useRawRuntimeControls'
import { useRawSourceState } from './stages/ingest/useRawSourceState'
import { useRawLookStage } from './stages/look/useRawLookStage'
import { useDecodedPreviewResource } from './stages/preview/useDecodedPreviewResource'
import { useEmbeddedPreviewUrlLifecycle } from './stages/preview/useEmbeddedPreviewUrlLifecycle'
import { usePreviewPipelineEvacuation } from './stages/preview/usePreviewPipelineEvacuation'
import { useRestorePreviewAfterExport } from './stages/preview/useRestorePreviewAfterExport'
import { useRawPreviewTransform } from './useRawPreviewTransform'
import type { UseRawWorkflowReturn } from './useRawWorkflow.types'
import { useRawWorkflowActions } from './useRawWorkflowActions'
import { useRawWorkflowRefs } from './useRawWorkflowRefs'

/**
 * The LUT the store holds, in the shape the export reads, read when called.
 * It shares the parsed table with the stored record the preview draws, so a
 * request that names the table here names the one on screen.
 */
function getStoredLutData(): LUTData | null {
  const lut = getLut()
  return lut ? toLUTData(lut) : null
}

/** A frame belongs to the session the store holds when it is accepted. */
function getCurrentSessionId(): string | null {
  return rawWorkflowStore.getSession()?.id ?? null
}

export type { UseRawWorkflowReturn } from './useRawWorkflow.types'

export function useRawWorkflow(): UseRawWorkflowReturn {
  const colorIntent = useProcessingParamsValue()
  const detachedView = useDetachedPreviewViewValue()
  const setDetachedView = useSetDetachedPreviewView()
  const lut = useLutValue()
  const status = useProcessingStatusValue()
  const error = useErrorMessageValue()
  const progress = useProgressValue()
  // The facts alone: the timings a preview render reports are the stats
  // provider's, so a new timing leaves the workflow as it was.
  const previewFacts = usePipelineFactsValue()
  const setStats = useSetPipelineStats()
  const [session] = useCurrentSession()

  const runtime = useRawWorkflowRefs()
  const { rawRuntimeHost, decodedImageRef, rawRenderExposureRef } = runtime
  const { view: _view, ...compareStage } = useRawCompareStage({
    detachedView,
    setDetachedView,
    session,
    decodedImageRef,
  })
  const { scheduleToast, dismissError, updateStats } = useRawWorkflowActions({
    isMountedRef: runtime.isMountedRef,
    status,
    setError: rawWorkflowStore.setError,
    setStatus: rawWorkflowStore.setStatus,
    setStats,
    getStats: getPipelineStats,
  })
  const sourceState = useRawSourceState({ session, status })
  const { hasImage, loadedImage, displaySource } = sourceState
  const rawRenderExposure =
    decodedImageRef.current?.renderExposure ?? rawRenderExposureRef.current
  const { abortRuntimeWork, abortExportWork } = useRawRuntimeControls({
    cancelHostSession: rawRuntimeHost.cancelSession,
    runtimeWorkSessionIdRef: runtime.runtimeWorkSessionIdRef,
    exportAbortControllerRef: runtime.exportAbortControllerRef,
  })

  // Export evacuates the preview through the host: its session lease ends,
  // then its decode worker stops before the export worker starts. The export
  // keeps its own controller, so neither step can cancel the export.
  const previewRuntime = useMemo(
    () => ({
      cancel: abortRuntimeWork,
      terminate: rawRuntimeHost.terminateDecodeBridge,
    }),
    [abortRuntimeWork, rawRuntimeHost],
  )

  const { registerExportResultResource, queueExportResultResourceDisposal } =
    useExportResourceManagement(runtime)

  const { invalidateExportGraph } = useExportGraphInvalidation({
    ...runtime,
    ...rawWorkflowStore,
    abortExportWork,
    queueExportResultResourceDisposal,
  })
  // A LUT landing while an export runs or holds the preview released would
  // cancel that export or discard its JPEG, so it never applies then. The
  // export state is read from the store when the LUT is about to land.
  const previewSuspendedRef = useRef(false)
  const canApplyLoadedLut = useCallback(
    () =>
      !previewSuspendedRef.current &&
      !hasActiveExport(
        runtime.exportAbortControllerRef.current,
        rawWorkflowStore.getSession(),
      ),
    [runtime],
  )
  // Transform events reduce the session in the store when they land; every
  // export reader reads the store, so none needs a copy kept in step.
  const { transform } = useRawPreviewTransform({
    session,
    getSession: rawWorkflowStore.getSession,
    setSession: rawWorkflowStore.setSession,
    invalidateExportGraph,
  })

  const { cancelLUTFileLoad, ...lookStage } = useRawLookStage({
    baseParams: colorIntent,
    session,
    lut,
    scheduleToast,
    invalidateExportGraph,
    canApplyLoadedLut,
  })
  // The color the photo renders with is read from the store wherever a
  // command needs it; only the view it is shown in is published here, and
  // never through a color setter.
  const { params } = lookStage

  // Embedded URL cleanup and restore read the session in the store when they
  // run, so a load or reset landing before this rerenders is the source they
  // act on.
  const { revokeCurrentEmbeddedPreviewUrl } = useEmbeddedPreviewUrlLifecycle({
    ...runtime,
    ...rawWorkflowStore,
  })
  const {
    registerCurrentPreviewPipelineForEvacuation,
    setOriginalPreviewPipeline,
  } = usePreviewPipelineEvacuation(runtime)
  const { setDecodedImageRef, decodedFrame } = useDecodedPreviewResource({
    ...runtime,
    invalidateExportGraph,
    getSessionId: getCurrentSessionId,
  })
  const { restorePreviewAfterExport } = useRestorePreviewAfterExport({
    ...runtime,
    ...rawWorkflowStore,
    beginRuntimeSession: rawRuntimeHost.beginSession,
    setDecodedImageRef,
    scheduleToast,
  })

  const {
    interruptionMarkers,
    exportInterruption,
    exportInterruptionRef,
    refreshExportInterruption,
  } = useExportInterruptionState(loadedImage.file)

  const { loadFile, reset } = useRawIngestStage({
    runtime,
    scheduleToast,
    abortRuntimeWork,
    abortExportWork,
    queueExportResultResourceDisposal,
    revokeCurrentEmbeddedPreviewUrl,
    setDecodedImageRef,
  })
  // The host lives as long as the workflow: unmounting terminates its worker,
  // including a warm-up still in flight. This cleanup runs after the ingest
  // lifecycle has cancelled the RAW session on the host, so it finds no
  // session left to dispose, and a remount (StrictMode) finds the host usable
  // again with a fresh history.
  useEffect(() => () => rawRuntimeHost.dispose(), [rawRuntimeHost])

  const exportCommandInput = {
    ...runtime,
    ...rawWorkflowStore,
    getLutData: getStoredLutData,
    scheduleToast,
    abortExportWork,
    registerExportResultResource,
  }
  const { exportImage } = useFullResExportAction({
    ...exportCommandInput,
    loadedImage,
    session,
    refreshExportInterruption,
    previewRuntime,
    registerCurrentPreviewPipelineForEvacuation,
    revokeCurrentEmbeddedPreviewUrl,
    interruptionMarkers,
  })
  const exportState = useExportDerivedState({
    session,
    exportInterruption,
    decodedImageRef,
    status,
    hasImage,
    displaySource,
    sourceFile: loadedImage.file,
    rawRenderExposure,
    params,
    lutData: lut,
    previewFacts,
  })
  const { previewSuspended, previewExportRefusal } = exportState
  previewSuspendedRef.current = previewSuspended
  // Full-resolution export starts only from an explicit user action, which
  // chooses nothing: the JPEG quality is fixed. The loaded source's
  // interruption hint asks it for the safer plan.
  const exportWithInterruptionHistory = useCallback(
    () => exportImage(withInterruptionHistory(exportInterruptionRef.current)),
    [exportImage, exportInterruptionRef],
  )
  const exportResultActions = useExportResultActions({
    ...exportCommandInput,
    previewSize: previewFacts?.previewSize,
    toast,
  })
  const { exportPreviewImage } = useHqPreviewExportAction({
    ...exportCommandInput,
    previewSuspended,
    previewExportRefusal,
    queueExportResultResourceDisposal,
    toast,
  })
  // Export commits the look on screen, so a local LUT still reading or
  // parsing when it starts is dropped rather than held for afterwards.
  useEffect(() => {
    if (status === 'exporting' || previewSuspended) cancelLUTFileLoad()
  }, [cancelLUTFileLoad, previewSuspended, status])

  const originalReference = useOriginalReference({
    ...runtime,
    sessionId: session?.id ?? null,
    viewMode: compareStage.viewMode,
    previewSuspended,
    decodedFrame,
    displaySource,
  })

  return {
    ...sourceState,
    ...compareStage,
    ...lookStage,
    ...exportState,
    ...exportResultActions,
    ...originalReference,
    transform,
    decodedImageRef,
    decodedFrame,
    status,
    error,
    progress,
    lutData: lut,
    previewFacts,
    exportImage: exportWithInterruptionHistory,
    exportPreviewImage,
    restorePreviewAfterExport,
    setOriginalPreviewPipeline,
    loadFile,
    reset,
    dismissError,
    updateStats,
    pipelineRef: runtime.pipelineRef,
    rawRuntimeHost,
  }
}
