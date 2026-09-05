import { useState } from 'react'
import { toast } from 'sonner'

import { yieldToPaint } from '~/lib/dom'
import { rawRuntimeAdapter } from '~/lib/raw/runtime-adapter'

import { getLut } from '../state/workflow.atoms'
import { buildRawWorkflowReturn } from './buildRawWorkflowReturn'
import { useRawCalibrationStage } from './stages/calibration/useRawCalibrationStage'
import { useOriginalReferenceStage } from './stages/compare/useOriginalReferenceStage'
import { useRawCompareStage } from './stages/compare/useRawCompareStage'
import { useExportGraphInvalidation } from './stages/export/useExportGraphInvalidation'
import { useExportRecoveryDiscovery } from './stages/export/useExportRecoveryDiscovery'
import { useExportRecoveryState } from './stages/export/useExportRecoveryState'
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
import type { UseRawWorkflowReturn } from './useRawWorkflow.types'
import { useRawWorkflowActions } from './useRawWorkflowActions'
import { useRawWorkflowRefs } from './useRawWorkflowRefs'
import { useRawWorkflowState } from './useRawWorkflowState'

export type { UseRawWorkflowReturn } from './useRawWorkflow.types'

export function useRawWorkflow(): UseRawWorkflowReturn {
  const { baseParams, setParams, lut, setLut } = useRawDetachedWorkflowState()
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
    rawRenderExposureRef,
  } = useRawWorkflowRefs({ session, initialParams: baseParams })
  const compareStage = useRawCompareStage({
    baseParams,
    session,
    sessionRef,
    setParams,
    setSession,
  })
  const [decodedImageVersion, setDecodedImageVersion] = useState(0)
  const {
    discoveredRecovery,
    discoveredRecoveryRef,
    setDiscoveredRecoveryState,
    pendingRecoveryRetry,
    setPendingRecoveryRetry,
  } = useExportRecoveryState()
  const {
    getCurrentProcessingParams,
    scheduleToast,
    dismissError,
    updateStats,
  } = useRawWorkflowActions({
    paramsRef,
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
  const { viewMode, setViewMode, setCompareSplit } = compareStage
  const { disposeRuntimeSession, abortRuntimeWork, abortExportWork } =
    useRawRuntimeControls({
      runtimeSessionRef,
      runtimeAbortControllerRef,
      runtimeWorkSessionIdRef,
      exportAbortControllerRef,
      disposedRuntimeSessionsRef,
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

  const lookStage = useRawLookStage({
    baseParams: compareStage.params,
    session,
    sessionRef,
    setSession,
    lut,
    setLut,
    setParams,
    getProcessingParams: getCurrentProcessingParams,
    lutDataRef,
    setLutDataRef,
    scheduleToast,
    invalidateExportGraph,
    setViewMode,
    setCompareSplit,
  })
  const { params, setParams: handleSetParams } = lookStage
  paramsRef.current = params
  const {
    histogram,
    clearSessionEmbeddedPreviewUrl,
    revokeCurrentEmbeddedPreviewUrl,
    registerCurrentPreviewPipelineForEvacuation,
    setOriginalPreviewPipeline,
    setDecodedImageRef,
    restorePreviewAfterExport,
  } = useRawPreviewStage({
    loadedFile: loadedImage.file,
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
    runtimeAbortControllerRef,
    runtimeWorkSessionIdRef,
    runtimeSessionRef,
    setStatus,
    setProgress,
    setError,
    abortRuntimeWork,
    disposeRuntimeSession,
    openSession: rawRuntimeAdapter.openSession,
    scheduleToast,
    toast,
  })
  const previewStage = {
    histogram,
    restorePreviewAfterExport,
    setOriginalPreviewPipeline,
  }

  useExportRecoveryDiscovery({
    setDiscoveredRecoveryState,
    setSession,
  })

  const { loadFile, reset } = useRawIngestStage({
    setStatus,
    setError,
    setProgress,
    getProcessingParams: getCurrentProcessingParams,
    getLut,
    setParams,
    setSession,
    setDecodedImageVersion,
    setStats,
    setPendingRecoveryRetry,
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
    disposeRuntimeSession,
    yieldToPaint,
    getPrewarmState: () => rawRuntimeAdapter.getPrewarmState(),
    prewarm: () => rawRuntimeAdapter.prewarm(),
    runtimeAbortControllerRef,
    runtimeSessionRef,
    disposedRuntimeSessionsRef,
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

  const {
    canExport,
    exportDisabledReason,
    exportResult,
    exportShareCapability,
    exportRecovery,
    previewSuspended,
    canPreviewExport,
    previewExportDisabledReason,
    exportImage,
    recoverInterruptedExport,
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
    lutDataRef,
    decodedImageRef,
    stats,
    setDiscoveredRecoveryState,
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
    terminateRawDecodeBridge: rawRuntimeAdapter.terminateDecodeBridge,
    registerCurrentPreviewPipelineForEvacuation,
    registerExportResultResource,
    revokeCurrentEmbeddedPreviewUrl,
    discoveredRecovery,
    embeddedPreviewUrl,
    status,
    hasImage,
    displaySource,
    rawRenderExposure,
    pendingRecoveryRetry,
    setPendingRecoveryRetry,
    discoveredRecoveryRef,
    loadFile,
    queueExportResultResourceDisposal,
    toast,
  })
  const exportStage = {
    canExport,
    exportDisabledReason,
    exportResult,
    exportShareCapability,
    exportRecovery,
    previewSuspended,
    canPreviewExport,
    previewExportDisabledReason,
    exportImage,
    recoverInterruptedExport,
    downloadExportResult,
    downloadExportManifest,
    shareExportResult,
    copyExportResult,
    exportPreviewImage,
  }

  const {
    originalReferenceSnapshot,
    originalReferenceFallbackReason,
    dualWebglAllowed,
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
    dualWebglAllowed,
    requestOriginalReferenceFallback,
  }

  // Phase 1 calibration stage. The matching pipeline (body/lens → catalog) is
  // not in scope for this PR; until it lands the stage exposes the trivial
  // no-matches surface so the future UI can render an empty calibration tool
  // without crashing. The white-neutral source is the spec-flagged stopgap:
  // a real WB-slider neutral lands behind the same getter signature.
  const calibrationStage = useRawCalibrationStage({
    sessionId: session?.id ?? null,
    runtimeSessionRef,
    getWhiteNeutral: () => null,
  })

  return buildRawWorkflowReturn({
    workflowState: {
      status,
      error,
      progress,
      stats,
      dismissError,
      updateStats,
    },
    refs: { decodedImageRef, pipelineRef },
    decodedImageVersion,
    lut,
    lutData: {
      lutData: lutDataRef.current,
      lutDataRef,
      lutDataVersion,
    },
    sourceState,
    compareStage,
    lookStage: {
      ...lookStage,
      params,
      setParams: handleSetParams,
    },
    previewStage,
    ingestStage,
    exportStage,
    originalReferenceStage,
    calibrationStage,
  })
}
