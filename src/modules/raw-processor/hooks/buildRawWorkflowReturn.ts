import type { MutableRefObject } from 'react'

import type { PipelineStats, RawProcessingPipeline } from '~/lib/gl/pipeline'
import type { ParsedLUT } from '~/lib/lut/cube-parser'

import type { ProcessingStatus } from '../model/workflow'
import type { useRawCalibrationStage } from './stages/calibration/useRawCalibrationStage'
import type { useOriginalReferenceStage } from './stages/compare/useOriginalReferenceStage'
import type { useRawCompareStage } from './stages/compare/useRawCompareStage'
import type { useRawExportStage } from './stages/export/useRawExportStage'
import type { useRawIngestStage } from './stages/ingest/useRawIngestStage'
import type { useRawSourceState } from './stages/ingest/useRawSourceState'
import type { useRawLookStage } from './stages/look/useRawLookStage'
import type { useRawPreviewStage } from './stages/preview/useRawPreviewStage'
import type { UseRawWorkflowReturn } from './useRawWorkflow.types'

type BuildRawWorkflowReturnInput = {
  workflowState: {
    status: ProcessingStatus
    error: string | null
    progress: number
    stats: PipelineStats | null
    dismissError: () => void
    updateStats: (stats: PipelineStats) => void
  }
  refs: {
    decodedImageRef: UseRawWorkflowReturn['decodedImageRef']
    pipelineRef: MutableRefObject<RawProcessingPipeline | null>
  }
  decodedImageVersion: number
  lut: ParsedLUT | null
  lutData: Pick<
    UseRawWorkflowReturn,
    'lutData' | 'lutDataRef' | 'lutDataVersion'
  >
  sourceState: ReturnType<typeof useRawSourceState>
  compareStage: ReturnType<typeof useRawCompareStage>
  lookStage: ReturnType<typeof useRawLookStage>
  previewStage: Pick<
    ReturnType<typeof useRawPreviewStage>,
    'histogram' | 'restorePreviewAfterExport' | 'setOriginalPreviewPipeline'
  >
  ingestStage: Pick<ReturnType<typeof useRawIngestStage>, 'loadFile' | 'reset'>
  exportStage: ReturnType<typeof useRawExportStage>
  originalReferenceStage: ReturnType<typeof useOriginalReferenceStage>
  calibrationStage: ReturnType<typeof useRawCalibrationStage>
}

export function buildRawWorkflowReturn({
  workflowState,
  refs,
  decodedImageVersion,
  lut,
  lutData,
  sourceState,
  compareStage,
  lookStage,
  previewStage,
  ingestStage,
  exportStage,
  originalReferenceStage,
  calibrationStage,
}: BuildRawWorkflowReturnInput): UseRawWorkflowReturn {
  return {
    params: lookStage.params,
    loadedImage: {
      file: sourceState.loadedImage.file,
      metadata: sourceState.loadedImage.metadata,
    },
    decodedImageRef: refs.decodedImageRef,
    decodedImageVersion,
    status: workflowState.status,
    error: workflowState.error,
    progress: workflowState.progress,
    lut,
    lutData: lutData.lutData,
    lutDataRef: lutData.lutDataRef,
    lutDataVersion: lutData.lutDataVersion,
    stats: workflowState.stats,
    hasImage: sourceState.hasImage,
    canExport: exportStage.canExport,
    exportDisabledReason: exportStage.exportDisabledReason,
    canPreviewExport: exportStage.canPreviewExport,
    previewExportDisabledReason: exportStage.previewExportDisabledReason,
    exportResult: exportStage.exportResult,
    exportShareCapability: exportStage.exportShareCapability,
    exportRecovery: exportStage.exportRecovery,
    activeStyle: lookStage.activeStyle,
    lutProfileSelection: lookStage.lutProfileSelection,
    activeIntensity: lookStage.activeIntensity,
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
    dualWebglAllowed: originalReferenceStage.dualWebglAllowed,
    histogram: previewStage.histogram,
    previewSuspended: exportStage.previewSuspended,
    loadFile: ingestStage.loadFile,
    loadLUT: lookStage.loadLUT,
    loadOnlineLUT: lookStage.loadOnlineLUT,
    selectLUTProfile: lookStage.selectLUTProfile,
    selectIntensityLevel: lookStage.selectIntensityLevel,
    setViewMode: compareStage.setViewMode,
    setCompareSplit: compareStage.setCompareSplit,
    setPreviewViewport: compareStage.setPreviewViewport,
    resetPreviewViewport: compareStage.resetPreviewViewport,
    clearLUT: lookStage.clearLUT,
    setParams: lookStage.setParams,
    setToneParams: lookStage.setToneParams,
    resetTone: lookStage.resetTone,
    setColorParams: lookStage.setColorParams,
    resetColor: lookStage.resetColor,
    setSelectiveColorBand: lookStage.setSelectiveColorBand,
    resetSelectiveColor: lookStage.resetSelectiveColor,
    exportImage: exportStage.exportImage,
    exportPreviewImage: exportStage.exportPreviewImage,
    recoverInterruptedExport: exportStage.recoverInterruptedExport,
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
    calibrationStage,
  }
}
