import type { CapabilityVector } from '@lumaforge/render-engine/policy'

import type { DecodedPreviewFrame } from '~/lib/preview/preview-frame'

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
  /**
   * The accepted frame the snapshot is drawn from, its only decoded
   * identity: the frame's size and exposure travel with it, so a frame
   * decoded again gets a new key however alike its pixels are.
   */
  frame: Pick<DecodedPreviewFrame, 'sessionId' | 'frameId'>
  displaySource: Extract<DisplaySource, 'quick' | 'bounded-hq'>
  policyVersion: number
}

export type SnapshotCapabilityPolicyInput = {
  displaySourcePixels: number
  webKitClass: CapabilityVector['webKitClass']
  pthread: boolean
  previewGpuBudgetMaxPixels?: number
}

// The snapshot is the technical original of one accepted frame, so the look,
// the view, and the user's color never reach its key.
export function createOriginalReferenceSnapshotKey({
  frame,
  displaySource,
  policyVersion,
}: OriginalReferenceSnapshotKeyInput): string {
  return [
    'original-reference',
    `policy:${policyVersion}`,
    `session:${frame.sessionId}`,
    `frame:${frame.frameId}`,
    `source:${displaySource}`,
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
