import type {
  LUTData,
  ProcessingParams,
  RawRenderExposure,
} from '@lumaforge/luma-color-runtime'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'

import type { ResourceRegistry } from '~/lib/export/resource-registry'
import type { PipelineStats, RawProcessingPipeline } from '~/lib/gl/pipeline'
import type { DecodedImage, ImageMetadata } from '~/lib/raw/decoder'

import type {
  DisplaySource,
  ExportRecoveryState,
  ImageSession,
} from '../../../model/session'
import type { ProcessingStatus } from '../../../model/workflow'
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
  params: ProcessingParams
  lutDataRef: MutableRefObject<LUTData | null>
  decodedImageRef: MutableRefObject<DecodedImage | null>
  stats: PipelineStats | null
  setDiscoveredRecoveryState: (next: ExportRecoveryState) => void
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
  discoveredRecovery: ExportRecoveryState
  embeddedPreviewUrl: string | null
  status: ProcessingStatus
  hasImage: boolean
  displaySource: DisplaySource
  rawRenderExposure: RawRenderExposure | null
  pendingRecoveryRetry: PendingRecoveryRetry | null
  setPendingRecoveryRetry: Dispatch<SetStateAction<PendingRecoveryRetry | null>>
  discoveredRecoveryRef: MutableRefObject<ExportRecoveryState>
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
  terminateRawDecodeBridge,
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
    terminateRawDecodeBridge,
    registerCurrentPreviewPipelineForEvacuation,
    registerExportResultResource,
    revokeCurrentEmbeddedPreviewUrl,
  })
  const {
    canExport,
    exportDisabledReason,
    exportResult,
    exportShareCapability,
    exportRecovery,
    previewSuspended,
    canPreviewExport,
    previewExportDisabledReason,
  } = useExportDerivedState({
    session,
    discoveredRecovery,
    decodedImageRef,
    embeddedPreviewUrl,
    status,
    hasImage,
    displaySource,
    sourceFile: loadedImage.file,
    rawRenderExposure,
    stats,
  })
  const { recoverInterruptedExport } = useExportRecoveryAction({
    pendingRecoveryRetry,
    setPendingRecoveryRetry,
    sessionRef,
    discoveredRecoveryRef,
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
    exportResult,
    exportShareCapability,
    exportRecovery,
    previewSuspended,
    canPreviewExport,
    previewExportDisabledReason,
    exportImage: exportImage as (
      options: FullResExportOptions,
    ) => Promise<void>,
    recoverInterruptedExport,
    downloadExportResult,
    downloadExportManifest,
    shareExportResult,
    copyExportResult,
    exportPreviewImage,
  }
}
