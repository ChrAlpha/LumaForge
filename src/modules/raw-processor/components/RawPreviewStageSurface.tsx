import type { CpuPreviewFrame } from '@lumaforge/render-engine/preview'

import type { PipelineStats, RawProcessingPipeline } from '~/lib/gl/pipeline'

import type { UseRawWorkflowReturn } from '../hooks/useRawWorkflow'
import { clampCompareSplit } from '../services/compare/compare-split'
import { ComparePreviewStage } from './ComparePreviewStage'
import type { RawRuntimeReadinessState } from './raw-runtime-readiness'
import { RawCpuPreviewStage } from './RawCpuPreviewStage'

export function RawPreviewStageSurface({
  workflow,
  isCpuMode,
  isProcessing,
  runtimeReadinessState,
  onPrepareRuntime,
  onRawDrop,
  onStatsUpdate,
  onPipelineChange,
  onPreviewFrameChange,
  onCpuProcessedFrame,
  transformActive,
}: {
  workflow: UseRawWorkflowReturn
  isCpuMode: boolean
  isProcessing: boolean
  runtimeReadinessState: RawRuntimeReadinessState
  onPrepareRuntime: () => void
  onRawDrop: (files: File[]) => void
  onStatsUpdate: (stats: PipelineStats) => void
  onPipelineChange: (pipeline: RawProcessingPipeline | null) => void
  onPreviewFrameChange: (node: HTMLDivElement | null) => void
  onCpuProcessedFrame?: (frame: CpuPreviewFrame | null) => void
  transformActive?: boolean
}) {
  if (isCpuMode && workflow.hasImage) {
    return (
      <RawCpuPreviewStage
        image={workflow.decodedImageRef.current}
        imageVersion={workflow.decodedImageVersion}
        params={workflow.params}
        lut={workflow.lutDataRef.current}
        fallbackThumbnailUrl={workflow.embeddedPreviewUrl}
        onProcessedFrame={onCpuProcessedFrame}
        previewFrameRef={onPreviewFrameChange}
        transformActive={transformActive}
      />
    )
  }

  return (
    <ComparePreviewStage
      hasImage={workflow.hasImage}
      imageRef={workflow.decodedImageRef}
      imageVersion={workflow.decodedImageVersion}
      params={workflow.params}
      lutDataRef={workflow.lutDataRef}
      lutDataVersion={workflow.lutDataVersion}
      embeddedPreviewUrl={workflow.embeddedPreviewUrl}
      displaySource={workflow.displaySource}
      originalReferenceSnapshot={workflow.originalReferenceSnapshot}
      originalReferenceFallbackReason={workflow.originalReferenceFallbackReason}
      dualWebglAllowed={workflow.dualWebglAllowed}
      previewSuspended={workflow.previewSuspended}
      previewViewport={workflow.previewViewport}
      split={workflow.compareSplit}
      splitEnabled={workflow.viewMode === 'compare'}
      onSplitChange={workflow.setCompareSplit}
      onSplitPreviewChange={(split) => {
        workflow.setParams({ compareSplit: clampCompareSplit(split) })
      }}
      onPreviewViewportChange={workflow.setPreviewViewport}
      isProcessing={isProcessing}
      runtimeReadinessState={runtimeReadinessState}
      onPrepareRuntime={onPrepareRuntime}
      phase={getPreviewStagePhase(workflow.status)}
      progress={workflow.progress}
      recoveryHint={workflow.progressRecoveryHint}
      onRawDrop={onRawDrop}
      onStatsUpdate={onStatsUpdate}
      onPipelineChange={onPipelineChange}
      onOriginalPreviewPipelineChange={workflow.setOriginalPreviewPipeline}
      onRequestOriginalReferenceFallback={
        workflow.requestOriginalReferenceFallback
      }
      onRestorePreview={workflow.restorePreviewAfterExport}
      previewFrameRef={onPreviewFrameChange}
    />
  )
}

function getPreviewStagePhase(status: UseRawWorkflowReturn['status']) {
  return status === 'warming'
    ? 'warming'
    : status === 'loading'
      ? 'loading'
      : status === 'decoding'
        ? 'decoding'
        : status === 'exporting'
          ? 'exporting'
          : 'processing'
}
