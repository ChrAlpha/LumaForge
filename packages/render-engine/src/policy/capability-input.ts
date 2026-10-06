// CapabilityVector — INPUT type only. The engine owns this shape and never
// detects capabilities: the browser host detects a vector and Node / CLI
// consumers supply a static default. Hosts import this type rather than
// declaring their own copy.

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
