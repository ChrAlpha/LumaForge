// CapabilityVector — INPUT type only. The engine owns this shape, never
// detects capabilities, and ships no default vector: every caller passes one
// that describes its actual host. Hosts import this type rather than
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
