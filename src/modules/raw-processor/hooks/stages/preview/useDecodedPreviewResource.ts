import type { RawRenderExposure } from '@lumaforge/luma-color-runtime'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { useCallback, useRef } from 'react'

import type {
  ResourceRegistry,
  TrackedLargeResource,
} from '~/lib/export/resource-registry'
import type { DecodedImage } from '~/lib/raw/decoder'

import { hasSameRawRenderExposure } from '../../../services/export/export-state'

type UseDecodedPreviewResourceInput = {
  decodedImageRef: MutableRefObject<DecodedImage | null>
  rawRenderExposureRef: MutableRefObject<RawRenderExposure | null>
  resourceRegistryRef: MutableRefObject<ResourceRegistry | null>
  setDecodedImageVersion: Dispatch<SetStateAction<number>>
  invalidateExportGraph: () => void
}

/**
 * The RAW render exposure is a source-level pin: the first quick frame of a
 * source sets it, and only releasing the source (a null frame on replacement
 * or reset) clears it. Bounded HQ frames, restored frames and preview
 * evacuation never move it, and a frame decoded without a pin cannot create
 * one unless it is a quick frame.
 */
function resolveSourceExposure(
  currentExposure: RawRenderExposure | null,
  nextDecoded: DecodedImage | null,
): RawRenderExposure | null {
  if (!nextDecoded) return null
  if (currentExposure) return currentExposure
  return nextDecoded.source === 'quick' ? nextDecoded.renderExposure : null
}

function withSourceExposure(
  decoded: DecodedImage | null,
  sourceExposure: RawRenderExposure | null,
): DecodedImage | null {
  if (
    !decoded ||
    !sourceExposure ||
    hasSameRawRenderExposure(decoded.renderExposure, sourceExposure)
  ) {
    return decoded
  }

  // Every preview executor reads the frame's exposure, so the frame carries
  // the pin rather than the value it estimated from its own pixels.
  return { ...decoded, renderExposure: { ...sourceExposure } }
}

export function useDecodedPreviewResource({
  decodedImageRef,
  rawRenderExposureRef,
  resourceRegistryRef,
  setDecodedImageVersion,
  invalidateExportGraph,
}: UseDecodedPreviewResourceInput) {
  const decodedPreviewResourceIdRef = useRef(0)
  const decodedPreviewResourceRef = useRef<TrackedLargeResource | null>(null)

  const registerDecodedPreviewForEvacuation = useCallback(
    (decoded: DecodedImage | null) => {
      const previousResource = decodedPreviewResourceRef.current
      decodedPreviewResourceRef.current = null
      if (previousResource) {
        void previousResource.dispose().catch((error) => {
          console.warn('Failed to clean up decoded preview resource:', error)
        })
      }

      const registry = resourceRegistryRef.current
      if (!decoded || !registry) return

      let tracked: TrackedLargeResource | null = null
      tracked = registry.register({
        id: `decoded-preview-${++decodedPreviewResourceIdRef.current}`,
        owner: 'preview',
        kind: 'array-buffer',
        estimatedBytes: decoded.data.byteLength,
        dispose: () => {
          if (decodedPreviewResourceRef.current === tracked) {
            decodedPreviewResourceRef.current = null
          }
          // Evacuation frees the pixels only; the source exposure pin stays
          // so a restored frame and the export keep rendering with it.
          if (decodedImageRef.current === decoded) {
            decodedImageRef.current = null
            setDecodedImageVersion((version) => version + 1)
          }
        },
      })
      decodedPreviewResourceRef.current = tracked
    },
    [decodedImageRef, resourceRegistryRef, setDecodedImageVersion],
  )

  const setDecodedImageRef = useCallback(
    (
      nextDecoded: DecodedImage | null,
      options?: { preserveExportResult?: boolean },
    ) => {
      const currentExposure = rawRenderExposureRef.current
      const nextExposure = resolveSourceExposure(currentExposure, nextDecoded)
      const stored = withSourceExposure(nextDecoded, nextExposure)
      decodedImageRef.current = stored
      rawRenderExposureRef.current = nextExposure
      registerDecodedPreviewForEvacuation(stored)
      setDecodedImageVersion((version) => version + 1)

      if (
        !options?.preserveExportResult &&
        !hasSameRawRenderExposure(currentExposure, nextExposure)
      ) {
        invalidateExportGraph()
      }
    },
    [
      decodedImageRef,
      invalidateExportGraph,
      rawRenderExposureRef,
      registerDecodedPreviewForEvacuation,
      setDecodedImageVersion,
    ],
  )

  return { setDecodedImageRef }
}
