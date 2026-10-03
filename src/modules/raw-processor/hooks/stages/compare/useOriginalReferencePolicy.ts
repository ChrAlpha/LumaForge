import type { MutableRefObject } from 'react'
import { useCallback, useEffect, useState } from 'react'

import {
  classifyUserAgent,
  getCapabilityVectorSnapshot,
} from '~/lib/runtime/capability-vector'
import {
  derivePreviewGpuBudget,
  detectPreviewGpuCapabilitySnapshot,
} from '~/lib/runtime/preview-gpu-budget'

import type { ImageSession } from '../../../model/session'
import { supportsLayeredCompareCss } from '../../../services/compare/compare-render-mode'
import type { OriginalReferenceSnapshotCapability } from '../../useOriginalReferenceSnapshot'

type UseOriginalReferencePolicyInput = {
  sessionId: string | null
  sessionRef: MutableRefObject<ImageSession | null>
  viewMode: 'processed' | 'original' | 'compare'
  previewSuspended: boolean
  previewSourceWidth?: number | null
  previewSourceHeight?: number | null
  getCapability?: (
    input: OriginalReferenceCapabilityInput,
  ) => OriginalReferenceSnapshotCapability
  supportsCssCompare?: () => boolean
}

type OriginalReferenceCapabilityInput = {
  previewSourceWidth?: number | null
  previewSourceHeight?: number | null
}

function getOriginalReferenceSnapshotCapability({
  previewSourceWidth,
  previewSourceHeight,
}: OriginalReferenceCapabilityInput): OriginalReferenceSnapshotCapability {
  const capability = getCapabilityVectorSnapshot()
  if (capability) {
    const gpuCapability =
      previewSourceWidth && previewSourceHeight
        ? detectPreviewGpuCapabilitySnapshot()
        : null
    const previewGpuBudget = gpuCapability
      ? derivePreviewGpuBudget({
          capability,
          gpu: gpuCapability,
          sourceWidth: previewSourceWidth ?? 0,
          sourceHeight: previewSourceHeight ?? 0,
        })
      : undefined

    return {
      webKitClass: capability.webKitClass,
      pthread: capability.pthread,
      previewGpuBudget,
    }
  }

  const nav = globalThis.navigator
  const touch =
    typeof nav?.maxTouchPoints === 'number' ? nav.maxTouchPoints > 0 : false

  return {
    webKitClass: classifyUserAgent(nav?.userAgent ?? '', touch),
    pthread:
      Boolean(globalThis.crossOriginIsolated) &&
      typeof SharedArrayBuffer !== 'undefined',
  }
}

function allowDualGpuCompare(capability: OriginalReferenceSnapshotCapability) {
  if (capability.previewGpuBudget) {
    return capability.previewGpuBudget.dualGpuAllowed
  }

  return capability.webKitClass === 'chromium' && capability.pthread
}

export function useOriginalReferencePolicy({
  sessionId,
  sessionRef,
  viewMode,
  previewSuspended,
  previewSourceWidth = null,
  previewSourceHeight = null,
  getCapability = getOriginalReferenceSnapshotCapability,
  supportsCssCompare = supportsLayeredCompareCss,
}: UseOriginalReferencePolicyInput) {
  const [fallbackRequestSessionId, setFallbackRequestSessionId] = useState<
    string | null
  >(null)
  const originalReferenceCapability = getCapability({
    previewSourceWidth,
    previewSourceHeight,
  })
  const dualGpuAllowed = allowDualGpuCompare(originalReferenceCapability)
  const cssCompareSupported = supportsCssCompare()
  const originalReferenceFallbackRequested =
    Boolean(sessionId) && fallbackRequestSessionId === sessionId

  useEffect(() => {
    if (viewMode !== 'compare' || previewSuspended) {
      setFallbackRequestSessionId(null)
    }
  }, [previewSuspended, viewMode])

  const requestOriginalReferenceFallback = useCallback(() => {
    setFallbackRequestSessionId(sessionRef.current?.id ?? null)
  }, [sessionRef])

  const shouldPrepareOriginalReferenceSnapshot =
    viewMode === 'compare' &&
    !previewSuspended &&
    cssCompareSupported &&
    (!dualGpuAllowed || originalReferenceFallbackRequested)

  return {
    originalReferenceCapability,
    dualGpuAllowed,
    supportsCssCompare: cssCompareSupported,
    shouldPrepareOriginalReferenceSnapshot,
    requestOriginalReferenceFallback,
  }
}
