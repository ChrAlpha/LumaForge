import type { LUTData } from '@lumaforge/luma-color-runtime'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'

import { yieldToPaint } from '~/lib/dom'
import { toLUTData } from '~/lib/lut/cube-parser'

import { hasActiveExport } from '../services/export/export-state'
import { getCurrentSession, setCurrentSession } from '../state/session.atoms'
import { getEffectiveColorIntent, getLut } from '../state/workflow.atoms'
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

/**
 * The LUT the store holds, in the shape the pipeline reads, read when
 * called. `lutDataRef` follows the store only once its effect runs; this
 * shares the parsed table with what it then holds, so a request that names
 * the table here names the one `lutDataRef` catches up to.
 */
function getStoredLutData(): LUTData | null {
  const lut = getLut()
  return lut ? toLUTData(lut) : null
}

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
    embeddedPreviewUrlRef,
    isMountedRef,
    runtimeWorkSessionIdRef,
    pendingLoadSessionIdRef,
    exportAbortControllerRef,
    exportGraphVersionRef,
    decodedImageRef,
    viewRef,
    rawRenderExposureRef,
  } = useRawWorkflowRefs({ initialView: detachedView })
  const compareStage = useRawCompareStage({
    detachedView,
    setDetachedView,
    session,
    decodedImageRef,
  })
  const [decodedImageVersion, setDecodedImageVersion] = useState(0)
  const { getCurrentView, scheduleToast, dismissError, updateStats } =
    useRawWorkflowActions({
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
    runtimeWorkSessionIdRef,
    exportAbortControllerRef,
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
    useExportResourceManagement({ resourceRegistryRef })

  const { invalidateExportGraph } = useExportGraphInvalidation({
    exportGraphVersionRef,
    previewCopyCanvasRef,
    exportAbortControllerRef,
    getSession: getCurrentSession,
    abortExportWork,
    queueExportResultResourceDisposal,
    setSession,
    setStatus,
    setProgress,
  })
  const { lutDataRef, lutDataVersion, setLutDataRef } = useLutDataState(lut)
  // A LUT landing while an export runs or holds the preview released would
  // cancel that export or discard its JPEG, so it never applies then. The
  // export state is read from the store when the LUT is about to land.
  const previewSuspendedRef = useRef(false)
  const canApplyLoadedLut = useCallback(
    () =>
      !previewSuspendedRef.current &&
      !hasActiveExport(exportAbortControllerRef.current, getCurrentSession()),
    [exportAbortControllerRef],
  )
  // Transform events reduce the session in the store when they land; every
  // export reader reads the store, so none needs a copy kept in step.
  const { transform } = useRawPreviewTransform({
    session,
    getSession: getCurrentSession,
    setSession: setCurrentSession,
    invalidateExportGraph,
  })

  const lookStage = useRawLookStage({
    baseParams: colorIntent,
    session,
    lut,
    setLut,
    setColorIntent,
    lutDataRef,
    setLutDataRef,
    scheduleToast,
    invalidateExportGraph,
    canApplyLoadedLut,
  })
  // The color the photo renders with is read from the store wherever a
  // command needs it; only the view it is shown in is published here, and
  // never through a color setter.
  const { params } = lookStage
  viewRef.current = compareStage.view
  const {
    decodedFrame,
    histogram,
    clearSessionEmbeddedPreviewUrl,
    revokeCurrentEmbeddedPreviewUrl,
    registerCurrentPreviewPipelineForEvacuation,
    setOriginalPreviewPipeline,
    setDecodedImageRef,
    restorePreviewAfterExport,
  } = useRawPreviewStage({
    decodedImageRef,
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
    decodedFrame,
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
    getColorIntent: getEffectiveColorIntent,
    getView: getCurrentView,
    getLut,
    setColorIntent,
    getSession: getCurrentSession,
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
    yieldToPaint,
    getPrewarmState: rawRuntimeHost.getPrewarmState,
    beginRuntimeSession: rawRuntimeHost.beginSession,
    decodedImageRef,
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
    exportRefusal,
    deliveredExportSize,
    exportResult,
    exportShareCapability,
    exportInterrupted,
    previewSuspended,
    canPreviewExport,
    previewExportRefusal,
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
    getSession: getCurrentSession,
    getColorIntent: getEffectiveColorIntent,
    getLutData: getStoredLutData,
    lutDataRef,
    decodedImageRef,
    stats,
    refreshExportInterruption,
    interruptionMarkers,
    exportAbortControllerRef,
    exportGraphVersionRef,
    isMountedRef,
    pipelineRef,
    resourceRegistryRef,
    previewCopyCanvasRef,
    scheduleToast,
    abortExportWork,
    previewRuntime,
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
    exportRefusal,
    deliveredExportSize,
    exportResult,
    exportShareCapability,
    exportInterrupted,
    previewSuspended,
    canPreviewExport,
    previewExportRefusal,
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
    viewMode,
    previewSuspended,
    decodedImageRef,
    decodedFrame,
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
