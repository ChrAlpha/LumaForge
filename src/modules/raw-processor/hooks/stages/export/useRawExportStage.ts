import type {
  ColorGraphIntentSource,
  LUTData,
  RawRenderExposure,
} from '@lumaforge/luma-color-runtime'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { useCallback } from 'react'

import type { ResourceRegistry } from '~/lib/export/resource-registry'
import type { DecodedImage, ImageMetadata } from '~/lib/raw/decoder'
import type {
  PipelineStats,
  RawProcessingPipeline,
} from '~/lib/webgpu/raw-processing-pipeline'

import type { DisplaySource, ImageSession } from '../../../model/session'
import type { ProcessingStatus } from '../../../model/workflow'
import type {
  ExportInterruptionMarkers,
  SourceInterruptionHint,
} from '../../../services/export/export-recovery'
import { withInterruptionHistory } from '../../../services/export/export-recovery'
import type { ExportContext } from '../../../services/export/orchestrate-full-res-export'
import { useExportDerivedState } from './useExportDerivedState'
import { useExportResultActions } from './useExportResultActions'
import { useFullResExportAction } from './useFullResExportAction'
import { useHqPreviewExportAction } from './useHqPreviewExportAction'

type ExportToast = {
  error: (message: string, options?: { description?: string }) => void
  success: (message: string, options?: { description?: string }) => void
}

type UseRawExportStageInput = {
  setStatus: (status: ProcessingStatus) => void
  setError: (error: string | null) => void
  setProgress: (progress: number) => void
  setSession: Dispatch<SetStateAction<ImageSession | null>>
  loadedImage: { file: File | null; metadata: ImageMetadata | null }
  session: ImageSession | null
  params: ColorGraphIntentSource
  /** Reads the session from the store when called. */
  getSession: () => ImageSession | null
  /** Reads the color intent the photo renders with from the store when called. */
  getColorIntent: () => ColorGraphIntentSource
  /** Reads the LUT the store holds when called. */
  getLutData: () => LUTData | null
  lutDataRef: MutableRefObject<LUTData | null>
  decodedImageRef: MutableRefObject<DecodedImage | null>
  stats: PipelineStats | null
  refreshExportInterruption: () => void
  interruptionMarkers: ExportInterruptionMarkers
  exportAbortControllerRef: MutableRefObject<AbortController | null>
  exportGraphVersionRef: MutableRefObject<number>
  isMountedRef: MutableRefObject<boolean>
  pipelineRef: MutableRefObject<RawProcessingPipeline | null>
  resourceRegistryRef: MutableRefObject<ResourceRegistry | null>
  previewCopyCanvasRef: MutableRefObject<HTMLCanvasElement | null>
  scheduleToast: (notify: () => void) => void
  abortExportWork: () => void
  /** The preview's RAW runtime on the workflow host, evacuated for export. */
  previewRuntime: ExportContext['services']['previewRuntime']
  registerCurrentPreviewPipelineForEvacuation: () => void
  registerExportResultResource: NonNullable<
    Parameters<typeof useFullResExportAction>[0]['registerExportResultResource']
  >
  revokeCurrentEmbeddedPreviewUrl: () => void
  exportInterruption: SourceInterruptionHint | null
  exportInterruptionRef: MutableRefObject<SourceInterruptionHint | null>
  embeddedPreviewUrl: string | null
  status: ProcessingStatus
  hasImage: boolean
  displaySource: DisplaySource
  rawRenderExposure: RawRenderExposure | null
  queueExportResultResourceDisposal: () => void
  toast: ExportToast
}

export function useRawExportStage({
  setStatus,
  setError,
  setProgress,
  setSession,
  loadedImage,
  session,
  params,
  getSession,
  getColorIntent,
  getLutData,
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
}: UseRawExportStageInput) {
  const { exportImage } = useFullResExportAction({
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
    interruptionMarkers,
  })
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
  } = useExportDerivedState({
    session,
    exportInterruption,
    decodedImageRef,
    embeddedPreviewUrl,
    status,
    hasImage,
    displaySource,
    sourceFile: loadedImage.file,
    rawRenderExposure,
    params,
    lutData: lutDataRef.current,
    stats,
  })
  // Full-resolution export starts only from an explicit user action, which
  // chooses nothing: the JPEG quality is fixed. The loaded source's
  // interruption hint asks it for the safer plan.
  const exportWithInterruptionHistory = useCallback(
    () => exportImage(withInterruptionHistory(exportInterruptionRef.current)),
    [exportImage, exportInterruptionRef],
  )
  const {
    downloadExportResult,
    downloadExportManifest,
    shareExportResult,
    copyExportResult,
  } = useExportResultActions({
    getSession,
    getColorIntent,
    getLutData,
    exportGraphVersionRef,
    exportAbortControllerRef,
    isMountedRef,
    pipelineRef,
    previewCopyCanvasRef,
    previewSize: stats?.previewSize,
    scheduleToast,
    toast,
  })
  const { exportPreviewImage } = useHqPreviewExportAction({
    getSession,
    getColorIntent,
    getLutData,
    decodedImageRef,
    pipelineRef,
    isMountedRef,
    exportGraphVersionRef,
    exportAbortControllerRef,
    previewCopyCanvasRef,
    previewSuspended,
    previewExportRefusal,
    abortExportWork,
    queueExportResultResourceDisposal,
    registerExportResultResource,
    scheduleToast,
    setProgress,
    setSession,
    setStatus,
    toast,
  })

  return {
    canExport,
    exportRefusal,
    deliveredExportSize,
    exportResult,
    exportShareCapability,
    exportInterrupted,
    previewSuspended,
    canPreviewExport,
    previewExportRefusal,
    exportImage: exportWithInterruptionHistory,
    downloadExportResult,
    downloadExportManifest,
    shareExportResult,
    copyExportResult,
    exportPreviewImage,
  }
}
