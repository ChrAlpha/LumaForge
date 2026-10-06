import type {
  ColorGraphIntentSource,
  LUTData,
  RawRenderExposure,
} from '@lumaforge/luma-color-runtime'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { useCallback, useMemo } from 'react'

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
import { useExportDerivedState } from './useExportDerivedState'
import type { PendingRecoveryRetry } from './useExportRecoveryAction'
import { useExportRecoveryAction } from './useExportRecoveryAction'
import { useExportResultActions } from './useExportResultActions'
import type { FullResExportOptions } from './useFullResExportAction'
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
  lutDataRef: MutableRefObject<LUTData | null>
  decodedImageRef: MutableRefObject<DecodedImage | null>
  stats: PipelineStats | null
  refreshExportInterruption: () => void
  interruptionMarkers: ExportInterruptionMarkers
  exportAbortControllerRef: MutableRefObject<AbortController | null>
  exportGraphVersionRef: MutableRefObject<number>
  isMountedRef: MutableRefObject<boolean>
  sessionRef: MutableRefObject<ImageSession | null>
  pipelineRef: MutableRefObject<RawProcessingPipeline | null>
  resourceRegistryRef: MutableRefObject<ResourceRegistry | null>
  previewCopyCanvasRef: MutableRefObject<HTMLCanvasElement | null>
  scheduleToast: (notify: () => void) => void
  abortExportWork: () => void
  abortRuntimeWork: () => void
  terminateRawDecodeBridge: () => void | Promise<void>
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
  pendingRecoveryRetry: PendingRecoveryRetry | null
  setPendingRecoveryRetry: Dispatch<SetStateAction<PendingRecoveryRetry | null>>
  loadFile: (file: File) => Promise<void>
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
  terminateRawDecodeBridge,
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
  pendingRecoveryRetry,
  setPendingRecoveryRetry,
  loadFile,
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
    params,
    lutDataRef,
    decodedImageRef,
    stats,
    refreshExportInterruption,
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
    terminateRawDecodeBridge,
    registerCurrentPreviewPipelineForEvacuation,
    registerExportResultResource,
    revokeCurrentEmbeddedPreviewUrl,
    interruptionMarkers,
  })
  const {
    canExport,
    exportDisabledReason,
    deliveredExportSize,
    exportResult,
    exportShareCapability,
    exportRecovery,
    previewSuspended,
    canPreviewExport,
    previewExportDisabledReason,
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
    stats,
  })
  // Full-resolution export starts only from an explicit user action. The
  // loaded source's interruption hint asks it for the safer plan.
  const exportWithInterruptionHistory = useCallback(
    (options: FullResExportOptions) =>
      exportImage(
        withInterruptionHistory(options, exportInterruptionRef.current),
      ),
    [exportImage, exportInterruptionRef],
  )
  // The retired recovery action still takes a recovery ref; it reads the
  // same projection the surfaces do.
  const exportRecoveryRef = useMemo(
    () => ({ current: exportRecovery }),
    [exportRecovery],
  )
  const { recoverInterruptedExport } = useExportRecoveryAction({
    pendingRecoveryRetry,
    setPendingRecoveryRetry,
    sessionRef,
    discoveredRecoveryRef: exportRecoveryRef,
    loadedFile: loadedImage.file,
    canExport,
    status,
    loadFile,
    exportImage,
    scheduleToast,
    toast,
  })
  const {
    downloadExportResult,
    downloadExportManifest,
    shareExportResult,
    copyExportResult,
  } = useExportResultActions({
    sessionRef,
    pipelineRef,
    previewCopyCanvasRef,
    previewSize: stats?.previewSize,
    scheduleToast,
    toast,
  })
  const { exportPreviewImage } = useHqPreviewExportAction({
    sessionRef,
    decodedImageRef,
    pipelineRef,
    isMountedRef,
    exportGraphVersionRef,
    exportAbortControllerRef,
    previewCopyCanvasRef,
    previewSuspended,
    previewExportDisabledReason,
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
    exportDisabledReason,
    deliveredExportSize,
    exportResult,
    exportShareCapability,
    exportRecovery,
    previewSuspended,
    canPreviewExport,
    previewExportDisabledReason,
    exportImage: exportWithInterruptionHistory,
    recoverInterruptedExport,
    downloadExportResult,
    downloadExportManifest,
    shareExportResult,
    copyExportResult,
    exportPreviewImage,
  }
}
