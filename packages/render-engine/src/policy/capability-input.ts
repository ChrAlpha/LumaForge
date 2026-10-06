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
 * A conservative capability vector (no COI, no pthread, one thread) once
 * meant as the Node default.
 *
 * @deprecated No engine function falls back to this vector. Pass a
 * `CapabilityVector` that describes the actual host to `deriveExportPolicy`,
 * `deriveInteractivePolicy` and `deriveRuntimeResourceBudget`. The value is
 * unchanged and still exported from `@lumaforge/render-engine` and
 * `@lumaforge/render-engine/policy`.
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
