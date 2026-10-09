import type { MutableRefObject } from 'react'

import type { ResourceRegistry } from '~/lib/export/resource-registry'
import type { DecodedPreviewFrame } from '~/lib/preview/preview-frame'
import type { PreviewViewMode } from '~/lib/preview/preview-view'
import type { DecodedImage } from '~/lib/raw/decoder'

import type { DisplaySource } from '../../../model/session'
import { useOriginalReferenceSnapshot } from '../../useOriginalReferenceSnapshot'
import { useOriginalReferencePolicy } from './useOriginalReferencePolicy'
import { useOriginalReferenceSnapshotResources } from './useOriginalReferenceSnapshotResources'

type UseOriginalReferenceStageInput = {
  sessionId: string | null
  viewMode: PreviewViewMode
  previewSuspended: boolean
  decodedImageRef: MutableRefObject<DecodedImage | null>
  decodedImageVersion: number
  /**
   * The accepted descriptor of the frame `decodedImageRef` holds; null while
   * no decoded frame is live.
   */
  decodedFrame: DecodedPreviewFrame | null
  displaySource: DisplaySource
  resourceRegistryRef: MutableRefObject<ResourceRegistry | null>
}

export function useOriginalReferenceStage({
  sessionId,
  viewMode,
  previewSuspended,
  decodedImageRef,
  decodedImageVersion,
  decodedFrame,
  displaySource,
  resourceRegistryRef,
}: UseOriginalReferenceStageInput) {
  const decodedImage = decodedImageRef.current
  const {
    setPendingOriginalReferenceSnapshotRender,
    trackOriginalReferenceSnapshot,
    discardOriginalReferenceSnapshot,
  } = useOriginalReferenceSnapshotResources({ resourceRegistryRef })
  const {
    originalReferenceCapability,
    dualGpuAllowed,
    shouldPrepareOriginalReferenceSnapshot,
    requestOriginalReferenceFallback,
  } = useOriginalReferencePolicy({
    sessionId,
    viewMode,
    previewSuspended,
    previewSourceWidth: decodedImage?.width ?? null,
    previewSourceHeight: decodedImage?.height ?? null,
  })
  // The descriptor travels with the pixels it names: a frame the stage
  // prepares no snapshot for hands the port neither.
  const originalReference = useOriginalReferenceSnapshot({
    sessionId,
    image: shouldPrepareOriginalReferenceSnapshot ? decodedImage : null,
    imageVersion: decodedImageVersion,
    frame: shouldPrepareOriginalReferenceSnapshot ? decodedFrame : null,
    displaySource,
    capability: originalReferenceCapability,
    trackSnapshot: trackOriginalReferenceSnapshot,
    discardSnapshot: discardOriginalReferenceSnapshot,
    onPendingRenderChange: setPendingOriginalReferenceSnapshotRender,
  })

  return {
    originalReferenceSnapshot: originalReference.snapshot,
    originalReferenceFallbackReason: originalReference.fallbackReason,
    dualGpuAllowed,
    requestOriginalReferenceFallback,
  }
}
