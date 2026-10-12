import { pickColorGraphIntent } from '@lumaforge/luma-color-runtime'
import type {
  CpuPreviewFrame,
  CpuPreviewVariant,
} from '@lumaforge/render-engine/preview'

import type {
  PipelineStats,
  RawProcessingPipeline,
} from '~/lib/webgpu/raw-processing-pipeline'

import type { UseRawWorkflowReturn } from '../hooks/useRawWorkflow'
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
  onCompareReset,
  transformActive,
  viewportInteractionDisabled,
  cpuVariant,
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
  onCpuProcessedFrame?: (
    frame: CpuPreviewFrame | null,
    rendering: boolean,
  ) => void
  /** Same reset the desktop Compare tool runs; the split handle reuses it. */
  onCompareReset?: () => void
  transformActive?: boolean
  viewportInteractionDisabled?: boolean
  /**
   * The CPU preview's original / processed choice when another control owns
   * it (the mobile compare lens); unset, the CPU stage keeps its own toggle.
   */
  cpuVariant?: CpuPreviewVariant
}) {
  // The stages draw the color intent; the view reaches them on its own.
  const color = pickColorGraphIntent(workflow.params)

  // Export releases the decoded preview; the shared stage then shows the
  // export-ready handoff with Restore preview, which the CPU stage lacks.
  if (isCpuMode && workflow.hasImage && !workflow.previewSuspended) {
    return (
      <RawCpuPreviewStage
        key={workflow.transform?.state?.sourceId ?? null}
        image={workflow.decodedImageRef.current}
        decodedFrame={workflow.decodedFrame}
        color={color}
        lut={workflow.lutDataRef.current}
        fallbackThumbnailUrl={workflow.embeddedPreviewUrl}
        onProcessedFrame={onCpuProcessedFrame}
        previewFrameRef={onPreviewFrameChange}
        transformActive={transformActive}
        variant={cpuVariant}
      />
    )
  }

  return (
    <ComparePreviewStage
      viewportInteractionDisabled={viewportInteractionDisabled}
      hasImage={workflow.hasImage}
      imageRef={workflow.decodedImageRef}
      imageVersion={workflow.decodedImageVersion}
      decodedFrame={workflow.decodedFrame}
      color={color}
      viewMode={workflow.viewMode}
      lutDataRef={workflow.lutDataRef}
      lutDataVersion={workflow.lutDataVersion}
      embeddedPreviewUrl={workflow.embeddedPreviewUrl}
      displaySource={workflow.displaySource}
      originalReferenceSnapshot={workflow.originalReferenceSnapshot}
      originalReferenceFallbackReason={workflow.originalReferenceFallbackReason}
      dualGpuAllowed={workflow.dualGpuAllowed}
      previewSuspended={workflow.previewSuspended}
      previewViewport={workflow.previewViewport}
      split={workflow.compareSplit}
      splitEnabled={workflow.viewMode === 'compare'}
      onSplitChange={workflow.setCompareSplit}
      onSplitReset={onCompareReset}
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
