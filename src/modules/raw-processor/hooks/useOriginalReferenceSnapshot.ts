import type {
  CapabilityVector,
  PreviewGpuBudget,
} from '@lumaforge/render-engine/policy'
import { useEffect, useMemo, useRef, useState } from 'react'

import type { DecodedPreviewFrame } from '~/lib/preview/preview-frame'
import type { DecodedImage } from '~/lib/raw/decoder'

import type { DisplaySource } from '../model/session'
import { renderOriginalReferenceSnapshot } from '../services/compare/original-reference-renderer'
import type { OriginalReferenceSnapshot } from '../services/compare/original-reference-snapshot'
import {
  createOriginalReferenceSnapshotKey,
  getOriginalReferenceSnapshotMaxPixels,
} from '../services/compare/original-reference-snapshot'

export type OriginalReferenceSnapshotCapability = {
  webKitClass: CapabilityVector['webKitClass']
  pthread: boolean
  previewGpuBudget?: Pick<
    PreviewGpuBudget,
    | 'boundedHqMaxPixels'
    | 'dualGpuAllowed'
    | 'originalReferenceSnapshotMaxPixels'
  >
}

export type UseOriginalReferenceSnapshotInput = {
  sessionId: string | null
  image: DecodedImage | null
  imageVersion: number
  /**
   * The workflow's accepted descriptor for `image`; null while no decoded
   * frame is accepted. The snapshot key is built from `imageVersion`, not
   * from it.
   */
  frame?: DecodedPreviewFrame | null
  displaySource: DisplaySource
  capability: OriginalReferenceSnapshotCapability
  styleVersion?: number
  renderSnapshot?: typeof renderOriginalReferenceSnapshot
  // The snapshot URL owner. `trackSnapshot` takes a resolved snapshot before
  // it is published and retires the previous one; `null` hands the current
  // snapshot back. `discardSnapshot` takes results that will never publish.
  trackSnapshot: (snapshot: OriginalReferenceSnapshot | null) => void
  discardSnapshot: (snapshot: OriginalReferenceSnapshot) => void
  onPendingRenderChange?: (
    pending: PendingOriginalReferenceSnapshotRender | null,
    key?: string,
  ) => void
}

export type PendingOriginalReferenceSnapshotRender = {
  key: string
  dispose: () => Promise<void>
}

function getOriginalReferenceSnapshotFallbackReason(error: unknown): string {
  if (
    error &&
    typeof error === 'object' &&
    'message' in error &&
    typeof error.message === 'string' &&
    error.message
  ) {
    return error.message
  }

  return 'ORIGINAL_REFERENCE_SNAPSHOT_FAILED'
}

export function useOriginalReferenceSnapshot({
  sessionId,
  image,
  imageVersion,
  displaySource,
  capability,
  renderSnapshot = renderOriginalReferenceSnapshot,
  trackSnapshot,
  discardSnapshot,
  onPendingRenderChange,
}: UseOriginalReferenceSnapshotInput) {
  const [snapshot, setSnapshot] = useState<OriginalReferenceSnapshot | null>(
    null,
  )
  const [fallbackReason, setFallbackReason] = useState<string | null>(null)
  const snapshotRef = useRef<OriginalReferenceSnapshot | null>(null)
  const snapshotSessionIdRef = useRef<string | null>(null)
  const previewGpuBudgetMaxPixels =
    capability.previewGpuBudget?.originalReferenceSnapshotMaxPixels

  const key = useMemo(() => {
    if (!sessionId || !image) return null
    if (displaySource !== 'quick' && displaySource !== 'bounded-hq') return null

    return createOriginalReferenceSnapshotKey({
      sessionId,
      displaySource,
      imageVersion,
      width: image.width,
      height: image.height,
      renderExposureEv: image.renderExposure.ev,
      policyVersion: 1,
    })
  }, [displaySource, image, imageVersion, sessionId])

  useEffect(() => {
    if (
      !key ||
      !image ||
      (displaySource !== 'quick' && displaySource !== 'bounded-hq')
    ) {
      if (snapshotRef.current) {
        snapshotRef.current = null
        snapshotSessionIdRef.current = null
        setSnapshot(null)
        trackSnapshot(null)
      }
      setFallbackReason(null)
      return
    }

    if (snapshotRef.current && snapshotSessionIdRef.current !== sessionId) {
      snapshotRef.current = null
      snapshotSessionIdRef.current = null
      setSnapshot(null)
      trackSnapshot(null)
    }

    if (snapshotRef.current?.key === key) return

    let cancelled = false
    const abortController = new AbortController()
    setFallbackReason(null)

    const maxPixels = getOriginalReferenceSnapshotMaxPixels({
      displaySourcePixels: image.width * image.height,
      webKitClass: capability.webKitClass,
      pthread: capability.pthread,
      previewGpuBudgetMaxPixels,
    })

    void renderSnapshot({
      image,
      key,
      maxPixels,
      signal: abortController.signal,
    })
      .then((nextSnapshot) => {
        if (cancelled) {
          discardSnapshot(nextSnapshot)
          return
        }
        // Ownership moves before React state can expose the URL.
        trackSnapshot(nextSnapshot)
        snapshotRef.current = nextSnapshot
        snapshotSessionIdRef.current = sessionId
        setSnapshot(nextSnapshot)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setFallbackReason(getOriginalReferenceSnapshotFallbackReason(error))
      })
      .finally(() => {
        onPendingRenderChange?.(null, key)
      })

    onPendingRenderChange?.({
      key,
      dispose: async () => {
        cancelled = true
        abortController.abort()
      },
    })

    return () => {
      cancelled = true
      abortController.abort()
      onPendingRenderChange?.(null, key)
    }
  }, [
    capability.pthread,
    capability.webKitClass,
    discardSnapshot,
    displaySource,
    image,
    key,
    renderSnapshot,
    sessionId,
    trackSnapshot,
    onPendingRenderChange,
    previewGpuBudgetMaxPixels,
  ])

  useEffect(() => {
    return () => {
      if (snapshotRef.current) {
        trackSnapshot(null)
      }
      snapshotRef.current = null
      snapshotSessionIdRef.current = null
    }
  }, [trackSnapshot])

  return {
    snapshot,
    fallbackReason,
  }
}
