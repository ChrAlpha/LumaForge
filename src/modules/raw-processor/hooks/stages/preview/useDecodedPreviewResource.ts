import type { RawRenderExposure } from '@lumaforge/luma-color-runtime'
import type { MutableRefObject } from 'react'
import { useCallback, useRef, useState } from 'react'

import type {
  ResourceRegistry,
  TrackedLargeResource,
} from '~/lib/export/resource-registry'
import type {
  DecodedPreviewFrame,
  DecodedPreviewFrameExposure,
} from '~/lib/preview/preview-frame'
import type { DecodedImage } from '~/lib/raw/decoder'

import { hasSameRawRenderExposure } from '../../../services/export/export-state'

type UseDecodedPreviewResourceInput = {
  decodedImageRef: MutableRefObject<DecodedImage | null>
  rawRenderExposureRef: MutableRefObject<RawRenderExposure | null>
  resourceRegistryRef: MutableRefObject<ResourceRegistry | null>
  invalidateExportGraph: () => void
  /**
   * The source session a frame belongs to, read when the frame is accepted.
   * A frame accepted without one gets no descriptor.
   */
  getSessionId: () => string | null
}

/** A descriptor together with the pixels it names. */
type AcceptedDecodedFrame = {
  readonly image: DecodedImage
  readonly descriptor: DecodedPreviewFrame
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

function describeExposure(
  stored: DecodedImage,
  sourceExposure: RawRenderExposure | null,
): DecodedPreviewFrameExposure {
  return Object.freeze(
    sourceExposure
      ? {
          kind: 'source-pin' as const,
          value: Object.freeze({ ...sourceExposure }),
        }
      : {
          kind: 'unpinned' as const,
          value: Object.freeze({ ...stored.renderExposure }),
        },
  )
}

/**
 * Describes a frame as it is accepted, after it carries the source pin. A
 * frame whose decoder named no stage is `unknown`, never taken for a quick
 * frame. Only a bounded-HQ frame replacing the live quick frame of the same
 * session names a predecessor.
 */
function describeAcceptedFrame({
  stored,
  sessionId,
  frameId,
  sourceExposure,
  live,
}: {
  stored: DecodedImage
  sessionId: string
  frameId: string
  sourceExposure: RawRenderExposure | null
  live: DecodedPreviewFrame | null
}): DecodedPreviewFrame {
  const stage = stored.source ?? 'unknown'
  const quickPredecessorFrameId =
    stage === 'bounded-hq' &&
    live?.stage === 'quick' &&
    live.sessionId === sessionId
      ? live.frameId
      : null

  return Object.freeze({
    sessionId,
    frameId,
    stage,
    width: stored.width,
    height: stored.height,
    exposure: describeExposure(stored, sourceExposure),
    quickPredecessorFrameId,
  })
}

export function useDecodedPreviewResource({
  decodedImageRef,
  rawRenderExposureRef,
  resourceRegistryRef,
  invalidateExportGraph,
  getSessionId,
}: UseDecodedPreviewResourceInput) {
  const decodedPreviewResourceIdRef = useRef(0)
  const decodedPreviewResourceRef = useRef<TrackedLargeResource | null>(null)
  const decodedFrameSequenceRef = useRef(0)
  const acceptedFrameRef = useRef<AcceptedDecodedFrame | null>(null)
  // Accepting or releasing a frame publishes its descriptor, which rerenders
  // the owner; the render then reads the descriptor the live pixels carry.
  // Pixels accepted without one are never drawn, so they need no render.
  const [, publishDecodedFrame] = useState<DecodedPreviewFrame | null>(null)

  // A descriptor names pixels only while they are the live frame: released
  // or evacuated pixels take their descriptor with them, whoever released
  // them.
  const readLiveDecodedFrame = useCallback((): DecodedPreviewFrame | null => {
    const accepted = acceptedFrameRef.current
    return accepted && accepted.image === decodedImageRef.current
      ? accepted.descriptor
      : null
  }, [decodedImageRef])

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
          // Only the live resource releases the frame. A replaced resource
          // has already handed its frame over, and the frame it names may be
          // the very object accepted again in its place.
          if (decodedPreviewResourceRef.current !== tracked) return
          decodedPreviewResourceRef.current = null
          // Evacuation frees the pixels and their descriptor only; the
          // source exposure pin stays so a restored frame and the export keep
          // rendering with it.
          if (acceptedFrameRef.current?.image === decoded) {
            acceptedFrameRef.current = null
            publishDecodedFrame(null)
          }
          if (decodedImageRef.current === decoded) {
            decodedImageRef.current = null
          }
        },
      })
      decodedPreviewResourceRef.current = tracked
    },
    [decodedImageRef, resourceRegistryRef],
  )

  const setDecodedImageRef = useCallback(
    (
      nextDecoded: DecodedImage | null,
      options?: { preserveExportResult?: boolean },
    ) => {
      const currentExposure = rawRenderExposureRef.current
      const nextExposure = resolveSourceExposure(currentExposure, nextDecoded)
      const stored = withSourceExposure(nextDecoded, nextExposure)
      const sessionId = stored ? getSessionId() : null
      // Accepting a frame is the one place a frame identity is minted; a
      // released source (a null frame) ends its lineage.
      acceptedFrameRef.current =
        stored && sessionId
          ? {
              image: stored,
              descriptor: describeAcceptedFrame({
                stored,
                sessionId,
                frameId: `decoded-frame-${++decodedFrameSequenceRef.current}`,
                sourceExposure: nextExposure,
                live: readLiveDecodedFrame(),
              }),
            }
          : null
      decodedImageRef.current = stored
      rawRenderExposureRef.current = nextExposure
      registerDecodedPreviewForEvacuation(stored)
      publishDecodedFrame(acceptedFrameRef.current?.descriptor ?? null)

      if (
        !options?.preserveExportResult &&
        !hasSameRawRenderExposure(currentExposure, nextExposure)
      ) {
        invalidateExportGraph()
      }
    },
    [
      decodedImageRef,
      getSessionId,
      invalidateExportGraph,
      rawRenderExposureRef,
      readLiveDecodedFrame,
      registerDecodedPreviewForEvacuation,
    ],
  )

  return { setDecodedImageRef, decodedFrame: readLiveDecodedFrame() }
}
