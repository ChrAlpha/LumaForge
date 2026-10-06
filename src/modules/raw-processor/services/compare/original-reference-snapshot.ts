import type { CapabilityVector } from '@lumaforge/render-engine/policy'

import type { DisplaySource } from '../../model/session'

export type OriginalReferenceSnapshot = {
  key: string
  objectUrl: string
  width: number
  height: number
  source: Extract<DisplaySource, 'quick' | 'bounded-hq'>
  mimeType: 'image/jpeg'
  estimatedBytes: number
}

export type OriginalReferenceSnapshotKeyInput = {
  sessionId: string
  displaySource: Extract<DisplaySource, 'quick' | 'bounded-hq'>
  imageVersion: number
  width: number
  height: number
  renderExposureEv: number
  policyVersion: number
  ignored?: Record<string, unknown>
}

export type SnapshotCapabilityPolicyInput = {
  displaySourcePixels: number
  webKitClass: CapabilityVector['webKitClass']
  pthread: boolean
  previewGpuBudgetMaxPixels?: number
}

export function createOriginalReferenceSnapshotKey({
  sessionId,
  displaySource,
  imageVersion,
  width,
  height,
  renderExposureEv,
  policyVersion,
}: OriginalReferenceSnapshotKeyInput): string {
  return [
    'original-reference',
    `policy:${policyVersion}`,
    `session:${sessionId}`,
    `source:${displaySource}`,
    `version:${imageVersion}`,
    `size:${width}x${height}`,
    `renderExposure:${Number.isFinite(renderExposureEv) ? renderExposureEv : 0}`,
  ].join('|')
}

export function getOriginalReferenceSnapshotMaxPixels({
  displaySourcePixels,
  webKitClass,
  pthread,
  previewGpuBudgetMaxPixels,
}: SnapshotCapabilityPolicyInput): number {
  if (
    typeof previewGpuBudgetMaxPixels === 'number' &&
    Number.isFinite(previewGpuBudgetMaxPixels) &&
    previewGpuBudgetMaxPixels > 0
  ) {
    return Math.max(
      1,
      Math.min(displaySourcePixels, Math.floor(previewGpuBudgetMaxPixels)),
    )
  }

  const policyCap =
    webKitClass === 'webkit-mobile' || !pthread
      ? 2_500_000
      : webKitClass === 'webkit-desktop-safari'
        ? 4_000_000
        : 8_000_000

  return Math.max(1, Math.min(displaySourcePixels, policyCap))
}

// Revokes the snapshot URL on every call. Releasing each snapshot once is the
// job of its lifecycle owner, so nothing here remembers released URLs.
export function releaseOriginalReferenceSnapshot(
  snapshot: OriginalReferenceSnapshot | null | undefined,
  {
    revokeObjectURL,
  }: {
    revokeObjectURL?: (url: string) => void
  } = {},
): void {
  if (!snapshot) return
  const revoke =
    revokeObjectURL ??
    (typeof URL.revokeObjectURL === 'function'
      ? URL.revokeObjectURL.bind(URL)
      : undefined)
  revoke?.(snapshot.objectUrl)
}
