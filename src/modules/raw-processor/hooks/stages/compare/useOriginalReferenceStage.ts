import type { ProcessingParams } from '@lumaforge/luma-color-runtime'
import type { MutableRefObject } from 'react'
import { useEffect } from 'react'

import type { ResourceRegistry } from '~/lib/export/resource-registry'
import type { DecodedImage } from '~/lib/raw/decoder'

import type { DisplaySource, ImageSession } from '../../../model/session'
import { useOriginalReferenceSnapshot } from '../../useOriginalReferenceSnapshot'
import { useOriginalReferencePolicy } from './useOriginalReferencePolicy'
import { useOriginalReferenceSnapshotResources } from './useOriginalReferenceSnapshotResources'

type UseOriginalReferenceStageInput = {
  sessionId: string | null
  sessionRef: MutableRefObject<ImageSession | null>
  viewMode: ProcessingParams['viewMode']
  previewSuspended: boolean
  decodedImageRef: MutableRefObject<DecodedImage | null>
  decodedImageVersion: number
  displaySource: DisplaySource
  resourceRegistryRef: MutableRefObject<ResourceRegistry | null>
}

export function useOriginalReferenceStage({
  sessionId,
  sessionRef,
  viewMode,
  previewSuspended,
  decodedImageRef,
  decodedImageVersion,
  displaySource,
  resourceRegistryRef,
}: UseOriginalReferenceStageInput) {
  const decodedImage = decodedImageRef.current
  const {
    setPendingOriginalReferenceSnapshotRender,
    trackOriginalReferenceSnapshot,
  } = useOriginalReferenceSnapshotResources({ resourceRegistryRef })
  const {
    originalReferenceCapability,
    dualGpuAllowed,
    shouldPrepareOriginalReferenceSnapshot,
    requestOriginalReferenceFallback,
  } = useOriginalReferencePolicy({
    sessionId,
    sessionRef,
    viewMode,
    previewSuspended,
    previewSourceWidth: decodedImage?.width ?? null,
    previewSourceHeight: decodedImage?.height ?? null,
  })
  const originalReference = useOriginalReferenceSnapshot({
    sessionId,
    image: shouldPrepareOriginalReferenceSnapshot ? decodedImage : null,
    imageVersion: decodedImageVersion,
    displaySource,
    capability: originalReferenceCapability,
    onPendingRenderChange: setPendingOriginalReferenceSnapshotRender,
  })

  useEffect(() => {
    trackOriginalReferenceSnapshot(originalReference.snapshot)
  }, [originalReference.snapshot, trackOriginalReferenceSnapshot])

  return {
    originalReferenceSnapshot: originalReference.snapshot,
    originalReferenceFallbackReason: originalReference.fallbackReason,
    dualGpuAllowed,
    requestOriginalReferenceFallback,
  }
}
