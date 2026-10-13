import type { MutableRefObject } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'

import type {
  ResourceRegistry,
  TrackedLargeResource,
} from '~/lib/export/resource-registry'
import type { DecodedPreviewFrame } from '~/lib/preview/preview-frame'
import type { PreviewViewMode } from '~/lib/preview/preview-view'
import type { DecodedImage } from '~/lib/raw/decoder'
import {
  classifyUserAgent,
  getCapabilityVectorSnapshot,
} from '~/lib/runtime/capability-vector'
import {
  derivePreviewGpuBudget,
  detectPreviewGpuCapabilitySnapshot,
} from '~/lib/runtime/preview-gpu-budget'

import type { DisplaySource } from '../../../model/session'
import { supportsLayeredCompareCss } from '../../../services/compare/compare-render-mode'
import { renderOriginalReferenceSnapshot } from '../../../services/compare/original-reference-renderer'
import type { OriginalReferenceSnapshot } from '../../../services/compare/original-reference-snapshot'
import {
  createOriginalReferenceSnapshotKey,
  getOriginalReferenceSnapshotMaxPixels,
  releaseOriginalReferenceSnapshot,
} from '../../../services/compare/original-reference-snapshot'
import { getCurrentSession } from '../../../state/session.atoms'

type UseOriginalReferenceInput = {
  sessionId: string | null
  viewMode: PreviewViewMode
  previewSuspended: boolean
  decodedImageRef: MutableRefObject<DecodedImage | null>
  /**
   * The accepted descriptor of the frame `decodedImageRef` holds, which keys
   * the snapshot; null while no decoded frame is live. Pixels without an
   * accepted frame, or a frame of another session, are never drawn.
   */
  decodedFrame: DecodedPreviewFrame | null
  displaySource: DisplaySource
  resourceRegistryRef: MutableRefObject<ResourceRegistry | null>
}

type OwnedSnapshot = {
  snapshot: OriginalReferenceSnapshot
  sessionId: string | null
  release: () => void
  resource: TrackedLargeResource | null
}

/** What this device can afford for the original: dual GPU, or a snapshot. */
function readCapability(width: number | null, height: number | null) {
  const capability = getCapabilityVectorSnapshot()
  if (capability) {
    const gpu = width && height ? detectPreviewGpuCapabilitySnapshot() : null
    const budget = gpu
      ? derivePreviewGpuBudget({
          capability,
          gpu,
          sourceWidth: width ?? 0,
          sourceHeight: height ?? 0,
        })
      : undefined
    return {
      webKitClass: capability.webKitClass,
      pthread: capability.pthread,
      dualGpuAllowed:
        budget?.dualGpuAllowed ??
        (capability.webKitClass === 'chromium' && capability.pthread),
      snapshotMaxPixels: budget?.originalReferenceSnapshotMaxPixels,
    }
  }

  const nav = globalThis.navigator
  const touch =
    typeof nav?.maxTouchPoints === 'number' ? nav.maxTouchPoints > 0 : false
  const webKitClass = classifyUserAgent(nav?.userAgent ?? '', touch)
  const pthread =
    Boolean(globalThis.crossOriginIsolated) &&
    typeof SharedArrayBuffer !== 'undefined'
  return {
    webKitClass,
    pthread,
    dualGpuAllowed: webKitClass === 'chromium' && pthread,
    snapshotMaxPixels: undefined,
  }
}

function fallbackReasonOf(error: unknown): string {
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

function warnCleanupFailure(error: unknown) {
  console.warn('Failed to clean up original reference snapshot:', error)
}

// A snapshot's URL is revoked at most once, whichever of replacement,
// evacuation, discard or unmount reaches it first; a revoke that throws stays
// retryable.
function releaseOnce(snapshot: OriginalReferenceSnapshot) {
  let released = false
  return () => {
    if (released) return
    releaseOriginalReferenceSnapshot(snapshot)
    released = true
  }
}

// A registered snapshot releases through the registry, so its live set stays
// in step and a failed release stays visible to export evacuation.
function retire(owned: OwnedSnapshot) {
  if (owned.resource) {
    void owned.resource.dispose().catch(warnCleanupFailure)
    return
  }
  try {
    owned.release()
  } catch (error) {
    warnCleanupFailure(error)
  }
}

/**
 * The original the compare view draws beside the processed photo. With dual
 * GPU compare the original layer renders it, unless that layer asked for the
 * snapshot fallback; without it, the original is a capped JPEG snapshot of
 * the accepted frame. This hook is the snapshot URL's only owner: every
 * resolved snapshot is owned and registered for export evacuation before it
 * is published, and a render that will never publish is released at once.
 */
export function useOriginalReference({
  sessionId,
  viewMode,
  previewSuspended,
  decodedImageRef,
  decodedFrame,
  displaySource,
  resourceRegistryRef,
}: UseOriginalReferenceInput) {
  const image = decodedImageRef.current
  const capability = readCapability(image?.width ?? null, image?.height ?? null)
  const { dualGpuAllowed, webKitClass, pthread, snapshotMaxPixels } = capability

  const [fallbackRequestSessionId, setFallbackRequestSessionId] = useState<
    string | null
  >(null)
  useEffect(() => {
    if (viewMode !== 'compare' || previewSuspended) {
      setFallbackRequestSessionId(null)
    }
  }, [previewSuspended, viewMode])
  // The request names the session in the store when it runs, so a request in
  // the same tick as a load or reset belongs to the source that exists after
  // it, and a request never carries over to a replacement source.
  const requestOriginalReferenceFallback = useCallback(() => {
    setFallbackRequestSessionId(getCurrentSession()?.id ?? null)
  }, [])

  const prepare =
    viewMode === 'compare' &&
    !previewSuspended &&
    supportsLayeredCompareCss() &&
    (!dualGpuAllowed ||
      (Boolean(sessionId) && fallbackRequestSessionId === sessionId))
  const snapshotSource =
    displaySource === 'quick' || displaySource === 'bounded-hq'
      ? displaySource
      : null
  // The snapshot is the technical original of one accepted frame of this
  // session, so a frame decoded again gets a new key however alike it is.
  const key =
    prepare &&
    sessionId &&
    image &&
    snapshotSource &&
    decodedFrame?.sessionId === sessionId
      ? createOriginalReferenceSnapshotKey({
          frame: decodedFrame,
          displaySource: snapshotSource,
          policyVersion: 1,
        })
      : null

  const [snapshot, setSnapshot] = useState<OriginalReferenceSnapshot | null>(
    null,
  )
  const [fallbackReason, setFallbackReason] = useState<string | null>(null)
  const ownedRef = useRef<OwnedSnapshot | null>(null)
  const resourceIdRef = useRef(0)

  // Takes ownership synchronously and retires the previous snapshot unless it
  // shares the URL; `null` retires the current one. An evacuation that runs
  // before React commits the published snapshot therefore still releases it.
  const publish = useCallback(
    (next: OriginalReferenceSnapshot | null, owner: string | null) => {
      const current = ownedRef.current
      if (current?.snapshot.objectUrl === next?.objectUrl) return
      ownedRef.current = null
      if (current) retire(current)
      setSnapshot(next)
      if (!next) return
      const release = releaseOnce(next)
      ownedRef.current = {
        snapshot: next,
        sessionId: owner,
        release,
        resource:
          resourceRegistryRef.current?.register({
            id: `original-reference-snapshot-${++resourceIdRef.current}`,
            owner: 'preview',
            kind: 'object-url',
            estimatedBytes: next.estimatedBytes,
            dispose: release,
          }) ?? null,
      }
    },
    [resourceRegistryRef],
  )

  useEffect(() => {
    if (!key || !image) {
      publish(null, null)
      setFallbackReason(null)
      return
    }
    // Another session's snapshot never stands in while this one renders.
    if (ownedRef.current && ownedRef.current.sessionId !== sessionId) {
      publish(null, null)
    }
    if (ownedRef.current?.snapshot.key === key) return

    let cancelled = false
    const controller = new AbortController()
    setFallbackReason(null)
    // The render holds GPU work an export evacuation must be able to end.
    const pending =
      resourceRegistryRef.current?.register({
        id: `original-reference-snapshot-render-${++resourceIdRef.current}`,
        owner: 'preview',
        kind: 'gpu-pipeline',
        dispose: () => {
          cancelled = true
          controller.abort()
        },
      }) ?? null
    const settle = () => {
      void pending?.dispose().catch(warnCleanupFailure)
    }

    void renderOriginalReferenceSnapshot({
      image,
      key,
      maxPixels: getOriginalReferenceSnapshotMaxPixels({
        displaySourcePixels: image.width * image.height,
        webKitClass,
        pthread,
        previewGpuBudgetMaxPixels: snapshotMaxPixels,
      }),
      signal: controller.signal,
    })
      .then((next) => {
        if (!cancelled) {
          publish(next, sessionId)
          return
        }
        // A result nobody will publish is released, unless it is the URL
        // already owned.
        if (ownedRef.current?.snapshot.objectUrl === next.objectUrl) return
        try {
          releaseOnce(next)()
        } catch (error) {
          warnCleanupFailure(error)
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) setFallbackReason(fallbackReasonOf(error))
      })
      .finally(settle)

    return () => {
      cancelled = true
      controller.abort()
      settle()
    }
  }, [
    image,
    key,
    pthread,
    publish,
    resourceRegistryRef,
    sessionId,
    snapshotMaxPixels,
    webKitClass,
  ])

  useEffect(
    () => () => {
      const owned = ownedRef.current
      ownedRef.current = null
      if (owned) retire(owned)
    },
    [],
  )

  return {
    originalReferenceSnapshot: snapshot,
    originalReferenceFallbackReason: fallbackReason,
    dualGpuAllowed,
    requestOriginalReferenceFallback,
  }
}
