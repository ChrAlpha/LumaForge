// CapabilityVector — INPUT type only.
//
// The engine accepts a CapabilityVector. It does NOT detect capabilities;
// detection lives in `src/lib/runtime/capability-vector.ts` (browser) or
// is supplied as a static default by the consumer (Node / CLI).
//
// This type intentionally mirrors `src/lib/runtime/capability-vector.ts`
// shape so a browser-detected value passes straight through.

export interface CapabilityVector {
  readonly coi: boolean
  readonly pthread: boolean
  readonly deviceMemoryGB: number | null
  readonly hwConcurrency: number
  readonly webKitClass:
    | 'chromium'
    | 'webkit-desktop-safari'
    | 'webkit-mobile'
    | 'unknown'
  readonly deviceFormFactor: 'desktop' | 'mobile' | 'unknown'
  readonly maybeOpfsSupported: boolean
}

/**
 * A safe default capability vector for Node consumers. Conservative shape
 * (no COI, no pthread, modest concurrency) so policy decisions degrade
 * cleanly rather than over-promise on a CLI process.
 */
export const NODE_DEFAULT_CAPABILITY: CapabilityVector = {
  coi: false,
  pthread: false,
  deviceMemoryGB: null,
  hwConcurrency: 1,
  webKitClass: 'unknown',
  deviceFormFactor: 'desktop',
  maybeOpfsSupported: false,
}
