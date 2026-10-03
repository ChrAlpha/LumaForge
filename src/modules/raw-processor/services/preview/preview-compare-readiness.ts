import type { ProcessingParams } from '@lumaforge/luma-color-runtime'

import type { DecodedImageSource } from '~/lib/raw/decoder'

import type { DisplaySource } from '../../model/session'

export type PreviewFrameStatus = {
  generationKey: string
  displaySource: DisplaySource
  source: DecodedImageSource | 'preview'
  state: 'idle' | 'ready'
}

export type OriginalGpuFrameStatus = {
  generationKey: string
  displaySource: DisplaySource
  state: 'idle' | 'ready' | 'failed'
}

export const EMPTY_PREVIEW_FRAME_STATUS: PreviewFrameStatus = {
  generationKey: '',
  displaySource: 'none',
  source: 'preview',
  state: 'idle',
}

export const EMPTY_ORIGINAL_GPU_FRAME_STATUS: OriginalGpuFrameStatus = {
  generationKey: '',
  displaySource: 'none',
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
    shouldCommit:
      currentStatus.generationKey !== nextStatus.generationKey ||
      currentStatus.displaySource !== nextStatus.displaySource ||
      currentStatus.source !== nextStatus.source ||
      currentStatus.state !== nextStatus.state,
  }
}

type DerivePreviewCompareReadinessInput = {
  imageVersion: number
  displaySource: DisplaySource
  imageSource?: DecodedImageSource
  imageWidth: number
  imageHeight: number
  hasImageData: boolean
  trackReady: boolean
  embeddedPreviewUrl?: string | null
  viewMode: ProcessingParams['viewMode']
  dualGpuAllowed: boolean
  suspended: boolean
  supportsCssClip: boolean
  originalGpuStatus: OriginalGpuFrameStatus
  processedFrameStatus: PreviewFrameStatus
}

export function getProcessedImageGenerationKey({
  imageVersion,
  displaySource,
  imageSource,
  imageWidth,
  imageHeight,
  hasImageData,
}: Pick<
  DerivePreviewCompareReadinessInput,
  | 'imageVersion'
  | 'displaySource'
  | 'imageSource'
  | 'imageWidth'
  | 'imageHeight'
  | 'hasImageData'
>) {
  return [
    imageVersion,
    displaySource,
    imageSource ?? 'preview',
    imageWidth,
    imageHeight,
    hasImageData ? 'data' : 'empty',
  ].join(':')
}

export function getOriginalGpuGenerationKey({
  imageVersion,
  displaySource,
  dualGpuAllowed,
  viewMode,
  suspended,
}: Pick<
  DerivePreviewCompareReadinessInput,
  'imageVersion' | 'displaySource' | 'dualGpuAllowed' | 'viewMode' | 'suspended'
>) {
  return [
    imageVersion,
    displaySource,
    dualGpuAllowed ? 'dual' : 'fallback',
    viewMode,
    suspended ? 'suspended' : 'active',
  ].join(':')
}

export function derivePreviewCompareReadiness({
  imageVersion,
  displaySource,
  imageSource,
  imageWidth,
  imageHeight,
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
  const processedImageGenerationKey = getProcessedImageGenerationKey({
    imageVersion,
    displaySource,
    imageSource,
    imageWidth,
    imageHeight,
    hasImageData,
  })
  const currentProcessedFrameReady =
    processedFrameStatus.generationKey === processedImageGenerationKey &&
    processedFrameStatus.state === 'ready'
  const processedPreviewVisible = trackReady && currentProcessedFrameReady
  const originalGpuGenerationKey = getOriginalGpuGenerationKey({
    imageVersion,
    displaySource,
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
    hasImageData &&
    viewMode === 'compare' &&
    supportsCssClip &&
    dualGpuAllowed
  const retainedOriginalGpuFrameReady =
    originalGpuLayerEligible &&
    !originalGpuReady &&
    !originalGpuFailed &&
    originalGpuStatus.state === 'ready' &&
    originalGpuStatus.displaySource === 'quick' &&
    displaySource === 'bounded-hq' &&
    imageSource === 'bounded-hq'
  const retainedProcessedFrameReady =
    processedFrameStatus.state === 'ready' &&
    processedFrameStatus.displaySource === 'quick' &&
    processedFrameStatus.source === 'quick' &&
    displaySource === 'bounded-hq' &&
    imageSource === 'bounded-hq'
  const retainedCompareFrameReady =
    retainedOriginalGpuFrameReady && retainedProcessedFrameReady
  const embeddedPreviewFallbackReady =
    Boolean(embeddedPreviewUrl) &&
    originalGpuLayerEligible &&
    !originalGpuReady &&
    !retainedCompareFrameReady

  return {
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
    embeddedPreviewFallbackReady,
    shouldMountOriginalGpuLayer: originalGpuLayerEligible && !originalGpuFailed,
    shouldDelayProcessedCompareRender: retainedCompareFrameReady,
  }
}

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
