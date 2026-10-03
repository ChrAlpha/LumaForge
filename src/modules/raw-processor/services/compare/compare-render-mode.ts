import type { ProcessingParams } from '@lumaforge/luma-color-runtime'

export type CompareRenderMode =
  | { kind: 'off' }
  | { kind: 'dual-gpu' }
  | {
      kind: 'embedded-fallback'
      reason: 'original-gpu-pending'
    }
  | {
      kind: 'jpeg-fallback'
      reason: 'dual-gpu-unavailable' | 'original-gpu-failed'
    }
  | {
      kind: 'processed-only'
      reason:
        | 'not-compare'
        | 'css-clip-unavailable'
        | 'jpeg-fallback-unavailable'
    }

export type SelectCompareRenderModeInput = {
  requestedViewMode: ProcessingParams['viewMode']
  supportsCssClip: boolean
  dualGpuAllowed: boolean
  originalGpuReady: boolean
  retainedCompareFrameReady?: boolean
  originalGpuFailed?: boolean
  embeddedPreviewReady?: boolean
  jpegSnapshotReady: boolean
}

export function supportsLayeredCompareCss(): boolean {
  if (typeof CSS === 'undefined' || typeof CSS.supports !== 'function') {
    return true
  }

  return (
    CSS.supports('clip-path', 'inset(0 50% 0 0)') ||
    CSS.supports('-webkit-clip-path', 'inset(0 50% 0 0)')
  )
}

export function selectCompareRenderMode({
  requestedViewMode,
  supportsCssClip,
  dualGpuAllowed,
  originalGpuReady,
  retainedCompareFrameReady = false,
  originalGpuFailed = false,
  embeddedPreviewReady = false,
  jpegSnapshotReady,
}: SelectCompareRenderModeInput): CompareRenderMode {
  if (requestedViewMode !== 'compare') return { kind: 'off' }
  if (!supportsCssClip) {
    return { kind: 'processed-only', reason: 'css-clip-unavailable' }
  }
  if (dualGpuAllowed && (originalGpuReady || retainedCompareFrameReady)) {
    return { kind: 'dual-gpu' }
  }
  if (jpegSnapshotReady) {
    return {
      kind: 'jpeg-fallback',
      reason: originalGpuFailed
        ? 'original-gpu-failed'
        : 'dual-gpu-unavailable',
    }
  }
  if (embeddedPreviewReady) {
    return { kind: 'embedded-fallback', reason: 'original-gpu-pending' }
  }

  return { kind: 'processed-only', reason: 'jpeg-fallback-unavailable' }
}
