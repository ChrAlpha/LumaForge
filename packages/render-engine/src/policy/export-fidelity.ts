// ExportFidelity — the former name of the export performance preference.
// Engine functions take `PerformancePreference` from `./export-policy`, which
// accepts the same three values.

/**
 * @deprecated Use `PerformancePreference` from
 * `@lumaforge/render-engine/policy`; it accepts the same values (`'safe'`,
 * `'balanced'`, `'max'`) and is what engine functions take. The type is
 * unchanged and still exported from `@lumaforge/render-engine` and
 * `@lumaforge/render-engine/policy`.
 */
export type ExportFidelity = 'safe' | 'balanced' | 'max'
