import type { DecodedPreviewFrame } from '~/lib/preview/preview-frame'
import {
  decodedPreviewFrameKey,
  isEligibleQuickPredecessor,
} from '~/lib/preview/preview-frame'
import type { PreviewViewMode } from '~/lib/preview/preview-view'

import type { DisplaySource } from '../../model/session'

/**
 * A processed frame the surface drew: the generation it drew and the accepted
 * frame whose pixels it drew, or none.
 */
export type PreviewFrameStatus = {
  generationKey: string
  frame: DecodedPreviewFrame | null
  state: 'idle' | 'ready'
}

/** The original layer's frame, keyed and described like the processed one. */
export type OriginalGpuFrameStatus = {
  generationKey: string
  frame: DecodedPreviewFrame | null
  state: 'idle' | 'ready' | 'failed'
}

export const EMPTY_PREVIEW_FRAME_STATUS: PreviewFrameStatus = {
  generationKey: '',
  frame: null,
  state: 'idle',
}

export const EMPTY_ORIGINAL_GPU_FRAME_STATUS: OriginalGpuFrameStatus = {
  generationKey: '',
  frame: null,
  state: 'idle',
}

export function derivePreviewFrameStatusTransition({
  currentStatus,
  nextStatus,
}: {
  currentStatus: PreviewFrameStatus
  nextStatus: PreviewFrameStatus
}) {
  return {
    nextStatus,
    // The generation key names the frame, so an equal key with an equal
    // state is the same status.
    shouldCommit:
      currentStatus.generationKey !== nextStatus.generationKey ||
      currentStatus.state !== nextStatus.state,
  }
}

type DerivePreviewCompareReadinessInput = {
  /**
   * The workflow's accepted descriptor of the decoded frame; null when no
   * decoded frame is live. Without one nothing decoded is drawn, whatever
   * pixels the image ref still holds.
   */
  frame: DecodedPreviewFrame | null
  displaySource: DisplaySource
  hasImageData: boolean
  trackReady: boolean
  embeddedPreviewUrl?: string | null
  viewMode: PreviewViewMode
  dualGpuAllowed: boolean
  suspended: boolean
  supportsCssClip: boolean
  originalGpuStatus: OriginalGpuFrameStatus
  processedFrameStatus: PreviewFrameStatus
}

/**
 * The original layer's generation: the accepted frame plus the compare
 * policy, view, and suspension it was drawn under.
 */
export function getOriginalGpuGenerationKey({
  frame,
  dualGpuAllowed,
  viewMode,
  suspended,
}: Pick<
  DerivePreviewCompareReadinessInput,
  'frame' | 'dualGpuAllowed' | 'viewMode' | 'suspended'
>) {
  return [
    decodedPreviewFrameKey(frame),
    dualGpuAllowed ? 'dual' : 'fallback',
    viewMode,
    suspended ? 'suspended' : 'active',
  ].join(':')
}

export function derivePreviewCompareReadiness({
  frame,
  displaySource,
  hasImageData,
  trackReady,
  embeddedPreviewUrl,
  viewMode,
  dualGpuAllowed,
  suspended,
  supportsCssClip,
  originalGpuStatus,
  processedFrameStatus,
}: DerivePreviewCompareReadinessInput) {
  const showEmbeddedPreview =
    displaySource === 'embedded' && Boolean(embeddedPreviewUrl)
  const hasDecodedFrame = frame !== null && hasImageData
  // The processed surface uploads the accepted frame alone: every frame the
  // producer accepts, a restored one included, is a new generation.
  const processedImageGenerationKey = decodedPreviewFrameKey(frame)
  const currentProcessedFrameReady =
    processedFrameStatus.generationKey === processedImageGenerationKey &&
    processedFrameStatus.state === 'ready'
  const processedPreviewVisible = trackReady && currentProcessedFrameReady
  const originalGpuGenerationKey = getOriginalGpuGenerationKey({
    frame,
    dualGpuAllowed,
    viewMode,
    suspended,
  })
  const originalGpuReady =
    originalGpuStatus.generationKey === originalGpuGenerationKey &&
    originalGpuStatus.state === 'ready'
  const originalGpuFailed =
    originalGpuStatus.generationKey === originalGpuGenerationKey &&
    originalGpuStatus.state === 'failed'
  const originalGpuLayerEligible =
    !showEmbeddedPreview &&
    !suspended &&
    hasDecodedFrame &&
    viewMode === 'compare' &&
    supportsCssClip &&
    dualGpuAllowed
  // A retained quick frame stands in only for the bounded-HQ frame that
  // names it as its predecessor: never for another source's frame, a
  // restored frame, or a frame of equal size that names none.
  const retainedOriginalGpuFrameReady =
    originalGpuLayerEligible &&
    !originalGpuReady &&
    !originalGpuFailed &&
    originalGpuStatus.state === 'ready' &&
    isEligibleQuickPredecessor(originalGpuStatus.frame, frame)
  const retainedProcessedFrameReady =
    hasDecodedFrame &&
    processedFrameStatus.state === 'ready' &&
    isEligibleQuickPredecessor(processedFrameStatus.frame, frame)
  const retainedCompareFrameReady =
    retainedOriginalGpuFrameReady && retainedProcessedFrameReady
  // GPU frames complete asynchronously: the original layer can report its
  // bounded-HQ frame before the processed one commits. The retained quick
  // processed frame keeps the compare pair on screen across that gap.
  const compareFrameBridgeReady =
    retainedProcessedFrameReady &&
    (retainedOriginalGpuFrameReady || originalGpuReady)
  const embeddedPreviewFallbackReady =
    Boolean(embeddedPreviewUrl) &&
    originalGpuLayerEligible &&
    !originalGpuReady &&
    !retainedCompareFrameReady
  // Until the quick frame is on screen, the embedded JPEG covers the stage.
  const embeddedHandoffPreviewVisible =
    displaySource === 'quick' &&
    Boolean(embeddedPreviewUrl) &&
    hasDecodedFrame &&
    !showEmbeddedPreview &&
    !processedPreviewVisible

  return {
    showEmbeddedPreview,
    embeddedHandoffPreviewVisible,
    processedImageGenerationKey,
    currentProcessedFrameReady,
    processedPreviewVisible,
    originalGpuGenerationKey,
    originalGpuReady,
    originalGpuFailed,
    originalGpuLayerEligible,
    retainedOriginalGpuFrameReady,
    retainedProcessedFrameReady,
    retainedCompareFrameReady,
    compareFrameBridgeReady,
    embeddedPreviewFallbackReady,
    shouldMountOriginalGpuLayer: originalGpuLayerEligible && !originalGpuFailed,
    shouldDelayProcessedCompareRender: retainedCompareFrameReady,
  }
}

export type PreviewCompareReadiness = ReturnType<
  typeof derivePreviewCompareReadiness
>

export function derivePreviewTrackReadinessTransition({
  retainedTrackIdentity,
  processedTrackIdentity,
  retainedProcessedFrameReady,
  handoffPreviewVisible = false,
}: {
  retainedTrackIdentity: string
  processedTrackIdentity: string
  retainedProcessedFrameReady: boolean
  handoffPreviewVisible?: boolean
}) {
  if (retainedProcessedFrameReady || handoffPreviewVisible) {
    return {
      nextRetainedTrackIdentity: processedTrackIdentity,
      resetTrackReady: false,
    }
  }

  if (retainedTrackIdentity === processedTrackIdentity) {
    return {
      nextRetainedTrackIdentity: retainedTrackIdentity,
      resetTrackReady: false,
    }
  }

  return {
    nextRetainedTrackIdentity: '',
    resetTrackReady: true,
  }
}
