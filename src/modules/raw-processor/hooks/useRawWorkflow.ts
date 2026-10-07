import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

import { yieldToPaint } from '~/lib/dom'

import { hasActiveExport } from '../services/export/export-state'
import { getLut } from '../state/workflow.atoms'
import { buildRawWorkflowReturn } from './buildRawWorkflowReturn'
import { useOriginalReferenceStage } from './stages/compare/useOriginalReferenceStage'
import { useRawCompareStage } from './stages/compare/useRawCompareStage'
import { useExportGraphInvalidation } from './stages/export/useExportGraphInvalidation'
import { useExportInterruptionState } from './stages/export/useExportInterruptionState'
import { useExportResourceManagement } from './stages/export/useExportResourceManagement'
import { useRawExportStage } from './stages/export/useRawExportStage'
import { useRawIngestStage } from './stages/ingest/useRawIngestStage'
import { useRawRuntimeControls } from './stages/ingest/useRawRuntimeControls'
import { useRawSourceState } from './stages/ingest/useRawSourceState'
import { useLutDataState } from './stages/look/useLutDataState'
import { useRawLookStage } from './stages/look/useRawLookStage'
import { useRawPreviewStage } from './stages/preview/useRawPreviewStage'
import { useImageSession } from './useImageSession'
import { useRawDetachedWorkflowState } from './useRawDetachedWorkflowState'
import { useRawPreviewTransform } from './useRawPreviewTransform'
import type { UseRawWorkflowReturn } from './useRawWorkflow.types'
import { useRawWorkflowActions } from './useRawWorkflowActions'
import { useRawWorkflowRefs } from './useRawWorkflowRefs'
import { useRawWorkflowState } from './useRawWorkflowState'

export type { UseRawWorkflowReturn } from './useRawWorkflow.types'

export function useRawWorkflow(): UseRawWorkflowReturn {
  const {
    colorIntent,
    setColorIntent,
    detachedView,
    setDetachedView,
    lut,
    setLut,
  } = useRawDetachedWorkflowState()
  const {
    status,
    setStatus,
    error,
    setError,
    progress,
    setProgress,
    stats,
    setStats,
  } = useRawWorkflowState()
  const { session, replaceFile, resetSession, setSession } = useImageSession()

  const {
    rawRuntimeHost,
    pipelineRef,
    resourceRegistryRef,
    previewCopyCanvasRef,
    sessionRef,
    embeddedPreviewUrlRef,
    isMountedRef,
    runtimeWorkSessionIdRef,
    pendingLoadSessionIdRef,
    runtimeSessionRef,
    runtimeAbortControllerRef,
    exportAbortControllerRef,
    exportGraphVersionRef,
    disposedRuntimeSessionsRef,
    decodedImageRef,
    paramsRef,
    viewRef,
    rawRenderExposureRef,
  } = useRawWorkflowRefs({
    session,
    initialParams: colorIntent,
    initialView: detachedView,
  })
  const compareStage = useRawCompareStage({
    detachedView,
    setDetachedView,
    session,
    sessionRef,
    setSession,
    decodedImageRef,
  })
  const [decodedImageVersion, setDecodedImageVersion] = useState(0)
  const {
    getCurrentColorIntent,
    getCurrentView,
    scheduleToast,
    dismissError,
    updateStats,
  } = useRawWorkflowActions({
    paramsRef,
    viewRef,
    isMountedRef,
    status,
    setError,
    setStatus,
    setStats,
  })
  const {
    hasImage,
    loadedImage,
    sourceFileName,
    supportLevel,
    progressRecoveryHint,
    embeddedPreviewUrl,
    displaySource,
  } = useRawSourceState({ session, status })
  const sourceState = {
    hasImage,
    loadedImage,
    sourceFileName,
    supportLevel,
    progressRecoveryHint,
    embeddedPreviewUrl,
    displaySource,
  }
  const rawRenderExposure =
    decodedImageRef.current?.renderExposure ?? rawRenderExposureRef.current
  const { viewMode } = compareStage
  const { abortRuntimeWork, abortExportWork } = useRawRuntimeControls({
    cancelHostSession: rawRuntimeHost.cancelSession,
    runtimeSessionRef,
    runtimeAbortControllerRef,
    disposedRuntimeSessionsRef,
    runtimeWorkSessionIdRef,
    exportAbortControllerRef,
  })

  const { registerExportResultResource, queueExportResultResourceDisposal } =
    useExportResourceManagement({ resourceRegistryRef })

  const { invalidateExportGraph } = useExportGraphInvalidation({
    exportGraphVersionRef,
    previewCopyCanvasRef,
    exportAbortControllerRef,
    sessionRef,
    abortExportWork,
    queueExportResultResourceDisposal,
    setSession,
    setStatus,
    setProgress,
  })
  const { lutDataRef, lutDataVersion, setLutDataRef } = useLutDataState(lut)
  // A LUT landing while an export runs or holds the preview released would
  // cancel that export or discard its JPEG, so it never applies then.
  const previewSuspendedRef = useRef(false)
  const canApplyLoadedLut = useCallback(
    () =>
      !previewSuspendedRef.current &&
      !hasActiveExport(exportAbortControllerRef.current, sessionRef.current),
    [exportAbortControllerRef, sessionRef],
  )
  const { previewTransform, transform } = useRawPreviewTransform({
    session,
    sessionRef,
    setSession,
    invalidateExportGraph,
  })

  const lookStage = useRawLookStage({
    baseParams: colorIntent,
    session,
    sessionRef,
    setSession,
    lut,
    setLut,
    setColorIntent,
    lutDataRef,
    setLutDataRef,
    scheduleToast,
    invalidateExportGraph,
    canApplyLoadedLut,
  })
  // The color the photo renders with and the view it is shown in are
  // published apart; neither is ever written through the other's setter.
  const { params } = lookStage
  paramsRef.current = params
  viewRef.current = compareStage.view
  const {
    histogram,
    clearSessionEmbeddedPreviewUrl,
    revokeCurrentEmbeddedPreviewUrl,
    registerCurrentPreviewPipelineForEvacuation,
    setOriginalPreviewPipeline,
    setDecodedImageRef,
    restorePreviewAfterExport,
  } = useRawPreviewStage({
    session,
    sessionRef,
    pendingLoadSessionIdRef,
    decodedImageRef,
    decodedImageVersion,
    rawRenderExposureRef,
    resourceRegistryRef,
    setDecodedImageVersion,
    invalidateExportGraph,
    embeddedPreviewUrlRef,
    setSession,
    pipelineRef,
    params,
    lutDataRef,
    lutDataVersion,
    displaySource,
    isMountedRef,
    runtimeWorkSessionIdRef,
    beginRuntimeSession: rawRuntimeHost.beginSession,
    setStatus,
    setProgress,
    setError,
    scheduleToast,
    toast,
  })
  const previewStage = {
    histogram,
    restorePreviewAfterExport,
    setOriginalPreviewPipeline,
  }

  const {
    interruptionMarkers,
    exportInterruption,
    exportInterruptionRef,
    refreshExportInterruption,
  } = useExportInterruptionState(loadedImage.file)

  const { loadFile, reset } = useRawIngestStage({
    setStatus,
    setError,
    setProgress,
    getColorIntent: getCurrentColorIntent,
    getView: getCurrentView,
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
    getPrewarmState: rawRuntimeHost.getPrewarmState,
    prewarm: rawRuntimeHost.prewarm,
    beginRuntimeSession: rawRuntimeHost.beginSession,
    decodedImageRef,
    sessionRef,
    embeddedPreviewUrlRef,
    isMountedRef,
    runtimeWorkSessionIdRef,
    pendingLoadSessionIdRef,
    previewCopyCanvasRef,
    resetSession,
  })
  const ingestStage = { loadFile, reset }
  // The host lives as long as the workflow: unmounting terminates its worker,
  // including a warm-up still in flight. This cleanup runs after the ingest
  // lifecycle has cancelled the RAW session on the host, so it finds no
  // session left to dispose, and a remount (StrictMode) finds the host usable
  // again with a fresh history.
  useEffect(() => () => rawRuntimeHost.dispose(), [rawRuntimeHost])

  const {
    canExport,
    exportDisabledReason,
    deliveredExportSize,
    exportResult,
    exportShareCapability,
    exportInterrupted,
    previewSuspended,
    canPreviewExport,
    previewExportDisabledReason,
    exportImage,
    downloadExportResult,
    downloadExportManifest,
    shareExportResult,
    copyExportResult,
    exportPreviewImage,
  } = useRawExportStage({
    setStatus,
    setError,
    setProgress,
    setSession,
    loadedImage,
    session,
    params,
    paramsRef,
    lutDataRef,
    decodedImageRef,
    stats,
    refreshExportInterruption,
    interruptionMarkers,
    exportAbortControllerRef,
    exportGraphVersionRef,
    isMountedRef,
    sessionRef,
    pipelineRef,
    resourceRegistryRef,
    previewCopyCanvasRef,
    scheduleToast,
    abortExportWork,
    abortRuntimeWork,
    terminateRawDecodeBridge: rawRuntimeHost.terminateDecodeBridge,
    registerCurrentPreviewPipelineForEvacuation,
    registerExportResultResource,
    revokeCurrentEmbeddedPreviewUrl,
    exportInterruption,
    exportInterruptionRef,
    embeddedPreviewUrl,
    status,
    hasImage,
    displaySource,
    rawRenderExposure,
    queueExportResultResourceDisposal,
    toast,
  })
  previewSuspendedRef.current = previewSuspended
  // Export commits the look on screen, so a local LUT still reading or
  // parsing when it starts is dropped rather than held for afterwards.
  const { cancelLUTFileLoad } = lookStage
  useEffect(() => {
    if (status === 'exporting' || previewSuspended) cancelLUTFileLoad()
  }, [cancelLUTFileLoad, previewSuspended, status])
  const exportStage = {
    canExport,
    exportDisabledReason,
    deliveredExportSize,
    exportResult,
    exportShareCapability,
    exportInterrupted,
    previewSuspended,
    canPreviewExport,
    previewExportDisabledReason,
    exportImage,
    downloadExportResult,
    downloadExportManifest,
    shareExportResult,
    copyExportResult,
    exportPreviewImage,
  }

  const {
    originalReferenceSnapshot,
    originalReferenceFallbackReason,
    dualGpuAllowed,
    requestOriginalReferenceFallback,
  } = useOriginalReferenceStage({
    sessionId: session?.id ?? null,
    sessionRef,
    viewMode,
    previewSuspended,
    decodedImageRef,
    decodedImageVersion,
    displaySource,
    resourceRegistryRef,
  })
  const originalReferenceStage = {
    originalReferenceSnapshot,
    originalReferenceFallbackReason,
    dualGpuAllowed,
    requestOriginalReferenceFallback,
  }

  return buildRawWorkflowReturn({
    previewTransform,
    transform,
    workflowState: {
      status,
      error,
      progress,
      stats,
      dismissError,
      updateStats,
    },
    refs: { decodedImageRef, pipelineRef },
    rawRuntimeHost,
    decodedImageVersion,
    lut,
    lutData: {
      lutData: lutDataRef.current,
      lutDataRef,
      lutDataVersion,
    },
    sourceState,
    compareStage,
    lookStage,
    previewStage,
    ingestStage,
    exportStage,
    originalReferenceStage,
  })
}
