import type { MutableRefObject } from 'react'

import type { RawRuntimeHost } from '~/lib/raw/raw-runtime-host'
import type {
  PipelineStats,
  RawProcessingPipeline,
} from '~/lib/webgpu/raw-processing-pipeline'

import type { ProcessingStatus } from '../model/workflow'
import type { PipelineFacts } from '../services/preview/pipeline-stats'
import type { useOriginalReferenceStage } from './stages/compare/useOriginalReferenceStage'
import type { useRawCompareStage } from './stages/compare/useRawCompareStage'
import type { useRawExportStage } from './stages/export/useRawExportStage'
import type { useRawIngestStage } from './stages/ingest/useRawIngestStage'
import type { useRawSourceState } from './stages/ingest/useRawSourceState'
import type { useRawLookStage } from './stages/look/useRawLookStage'
import type { useRawPreviewStage } from './stages/preview/useRawPreviewStage'
import type { UseRawWorkflowReturn } from './useRawWorkflow.types'

type BuildRawWorkflowReturnInput = {
  transform: UseRawWorkflowReturn['transform']
  workflowState: {
    status: ProcessingStatus
    error: string | null
    progress: number
    previewFacts: PipelineFacts | null
    dismissError: () => void
    updateStats: (stats: PipelineStats) => void
  }
  refs: {
    decodedImageRef: UseRawWorkflowReturn['decodedImageRef']
    pipelineRef: MutableRefObject<RawProcessingPipeline | null>
  }
  rawRuntimeHost: RawRuntimeHost
  decodedImageVersion: number
  lutData: Pick<
    UseRawWorkflowReturn,
    'lutData' | 'lutDataRef' | 'lutDataVersion'
  >
  sourceState: ReturnType<typeof useRawSourceState>
  compareStage: ReturnType<typeof useRawCompareStage>
  lookStage: ReturnType<typeof useRawLookStage>
  previewStage: Pick<
    ReturnType<typeof useRawPreviewStage>,
    'decodedFrame' | 'restorePreviewAfterExport' | 'setOriginalPreviewPipeline'
  >
  ingestStage: Pick<ReturnType<typeof useRawIngestStage>, 'loadFile' | 'reset'>
  exportStage: ReturnType<typeof useRawExportStage>
  originalReferenceStage: ReturnType<typeof useOriginalReferenceStage>
}

export function buildRawWorkflowReturn({
  transform,
  workflowState,
  refs,
  rawRuntimeHost,
  decodedImageVersion,
  lutData,
  sourceState,
  compareStage,
  lookStage,
  previewStage,
  ingestStage,
  exportStage,
  originalReferenceStage,
}: BuildRawWorkflowReturnInput): UseRawWorkflowReturn {
  return {
    transform,
    params: lookStage.params,
    loadedImage: {
      file: sourceState.loadedImage.file,
      metadata: sourceState.loadedImage.metadata,
    },
    decodedImageRef: refs.decodedImageRef,
    decodedImageVersion,
    decodedFrame: previewStage.decodedFrame,
    status: workflowState.status,
    error: workflowState.error,
    progress: workflowState.progress,
    lutData: lutData.lutData,
    lutDataRef: lutData.lutDataRef,
    lutDataVersion: lutData.lutDataVersion,
    previewFacts: workflowState.previewFacts,
    hasImage: sourceState.hasImage,
    canExport: exportStage.canExport,
    exportRefusal: exportStage.exportRefusal,
    deliveredExportSize: exportStage.deliveredExportSize,
    canPreviewExport: exportStage.canPreviewExport,
    previewExportRefusal: exportStage.previewExportRefusal,
    exportResult: exportStage.exportResult,
    exportShareCapability: exportStage.exportShareCapability,
    exportInterrupted: exportStage.exportInterrupted,
    activeStyle: lookStage.activeStyle,
    lutProfileSelection: lookStage.lutProfileSelection,
    viewMode: compareStage.viewMode,
    compareSplit: compareStage.compareSplit,
    previewViewport: compareStage.previewViewport,
    currentLutName: lookStage.currentLutName,
    sourceFileName: sourceState.sourceFileName,
    supportLevel: sourceState.supportLevel,
    progressRecoveryHint: sourceState.progressRecoveryHint,
    embeddedPreviewUrl: sourceState.embeddedPreviewUrl,
    displaySource: sourceState.displaySource,
    originalReferenceSnapshot: originalReferenceStage.originalReferenceSnapshot,
    originalReferenceFallbackReason:
      originalReferenceStage.originalReferenceFallbackReason,
    dualGpuAllowed: originalReferenceStage.dualGpuAllowed,
    previewSuspended: exportStage.previewSuspended,
    loadFile: ingestStage.loadFile,
    loadLUT: lookStage.loadLUT,
    loadOnlineLUT: lookStage.loadOnlineLUT,
    selectLUTProfile: lookStage.selectLUTProfile,
    setIntensity: lookStage.setIntensity,
    setViewMode: compareStage.setViewMode,
    setCompareSplit: compareStage.setCompareSplit,
    resetCompareView: compareStage.resetCompareView,
    setPreviewViewport: compareStage.setPreviewViewport,
    clearLUT: lookStage.clearLUT,
    setToneParams: lookStage.setToneParams,
    resetTone: lookStage.resetTone,
    setColorParams: lookStage.setColorParams,
    resetColor: lookStage.resetColor,
    setSelectiveColorBand: lookStage.setSelectiveColorBand,
    resetSelectiveColor: lookStage.resetSelectiveColor,
    exportImage: exportStage.exportImage,
    exportPreviewImage: exportStage.exportPreviewImage,
    downloadExportResult: exportStage.downloadExportResult,
    downloadExportManifest: exportStage.downloadExportManifest,
    shareExportResult: exportStage.shareExportResult,
    copyExportResult: exportStage.copyExportResult,
    restorePreviewAfterExport: previewStage.restorePreviewAfterExport,
    requestOriginalReferenceFallback:
      originalReferenceStage.requestOriginalReferenceFallback,
    setOriginalPreviewPipeline: previewStage.setOriginalPreviewPipeline,
    reset: ingestStage.reset,
    dismissError: workflowState.dismissError,
    updateStats: workflowState.updateStats,
    pipelineRef: refs.pipelineRef,
    rawRuntimeHost,
  }
}
