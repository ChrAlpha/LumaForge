// RenderManifest v1 — see docs/specs/2026-06-13-render-engine-extraction-design.md
//   §6.1 RenderIdentity / RenderManifest composition
//   §6.2 SourceRawIdentity / LutIdentity / CalibrationIdentity / ColorGraphIdentity / OutputIdentity
//   §6.3 RenderParams / PolicyChoice / RenderEnvironment
//   §6.4 Canonicalization + self-hash (implemented in `./canonicalize.ts`)

// ---------------------------------------------------------------------------
// §6.2 — identity sub-types
// ---------------------------------------------------------------------------

export interface SourceRawIdentity {
  /** Full-file streaming SHA-256 of the source bytes (see §6.6). */
  readonly sha256: string
  readonly byte_size: number
  /** Basename only, no directory. */
  readonly filename: string
  readonly decoded_dimensions: {
    readonly width: number
    readonly height: number
  }
}

export interface LutColorContract {
  readonly gamut: string
  readonly transfer: string
  readonly range: 'full' | 'legal'
  readonly role?: string
}

export interface LutCatalogIdentity {
  readonly kind: 'catalog'
  readonly catalog_id: string
  readonly entry: string
  readonly version: string
  readonly sha256: string
  readonly input_contract: LutColorContract
  readonly output_contract: LutColorContract
}

export interface LutLocalFileIdentity {
  readonly kind: 'local-file'
  /** Basename only — non-sensitive resolver hint. Path resolution is consumer-owned. */
  readonly filename: string
  readonly sha256: string
  readonly input_contract: LutColorContract
  readonly output_contract: LutColorContract
}

export type LutIdentity = LutCatalogIdentity | LutLocalFileIdentity

/**
 * Camera-calibration identity (DCP).
 *
 * Captures the inputs to DCP interpolation (sidecar params + white neutral)
 * so the resulting xyzToCamera matrix is reproducible without storing the
 * matrix bytes themselves.
 *
 * `dcp_params_sha256` IS the runtime content identity. No separate DCP
 * binary is applied at runtime; the sidecar (matrices m1/m2, illuminants,
 * schema_version, toneCurve) is the only thing that enters the solver, and
 * xyzToCamera is deterministic given (dcp_params, white_neutral) and the
 * recorded `environment.luma_color_runtime` semver.
 *
 * The sha256 is over the raw sidecar bytes as delivered by the catalog. The
 * fetcher surfaces the sha256 to the orchestrator; the orchestrator threads
 * it through to the identity. The engine writes the value RETURNED by the
 * orchestrator — never one separately assembled by the caller.
 *
 * Today only catalog-sourced calibration is modeled. The discriminant
 * leaves the door open for user-uploaded DCPs as a future kind.
 */
export interface CalibrationIdentity {
  readonly kind: 'catalog'
  readonly catalog_id: string
  readonly profile_id: string
  readonly schema_version: string
  readonly dcp_params_sha256: string
  readonly white_neutral: readonly [number, number, number]
  /** DCP interpolation parameter; 0 for single-illuminant profiles. */
  readonly alpha: number
  /** `false` ↔ `camera_profile.interpolation_capped` was emitted. */
  readonly converged: boolean
}

export interface ColorGraphIdentity {
  /** SHA-256 of the canonical descriptor. */
  readonly fingerprint: string
  /**
   * Serialized `resolveExportColorGraph` output. Treated as opaque at P2.
   *
   * Spec §14 Q4: P3 (when the export engine migration lands) MUST freeze a
   * `descriptor_version` field on this structure so future descriptor-shape
   * changes don't invalidate canonical hashes silently. Until then,
   * downstream readers should treat the descriptor as opaque bytes and rely
   * on `fingerprint` for equality comparison.
   */
  readonly descriptor: unknown
}

export interface OutputIdentity {
  readonly format: 'jpeg'
  readonly dimensions: { readonly width: number; readonly height: number }
  readonly color_space: 'srgb'
  readonly quality: number
  readonly filename: string
  readonly sha256: string
}

// ---------------------------------------------------------------------------
// §6.3 — params / policy / environment
// ---------------------------------------------------------------------------

export interface ToneCurveParams {
  readonly highlights?: number
  readonly shadows?: number
  readonly whites?: number
  readonly blacks?: number
  readonly contrast?: number
}

export interface ColorBalanceParams {
  readonly temp_k?: number
  readonly tint?: number
  /** LumaForge user temperature slider (-100..100); complements `temp_k`. */
  readonly temperature?: number
}

export interface SaturationParams {
  readonly saturation?: number
  readonly vibrance?: number
}

export type RawRenderExposureSource =
  | 'dng-baseline'
  | 'image-statistics'
  | 'identity'
  | 'user'

export interface SelectiveColorBandShift {
  readonly hue: number
  readonly saturation: number
  readonly lightness: number
}

export interface RenderParams {
  readonly exposure_ev: number
  readonly tone_curve?: ToneCurveParams
  readonly color_balance?: ColorBalanceParams
  readonly saturation?: SaturationParams
  /** Per-band HSL shifts keyed by band id (red, orange, yellow, green, aqua, blue, purple, magenta). */
  readonly selective_color?: Readonly<Record<string, SelectiveColorBandShift>>
  readonly intensity?: number
  /** Resolved raw-render exposure (EV) applied before user params. */
  readonly raw_render_exposure_ev?: number
  readonly raw_render_exposure_source?: RawRenderExposureSource
}

export type RenderPolicyKind =
  | 'preview-quick'
  | 'preview-bounded-hq'
  | 'candidate'
  | 'export-full'

export interface PolicyChoice {
  readonly kind: RenderPolicyKind
  readonly row_slice: number
  readonly concurrency: number
  /** Decode budget (pixels) used for preview/candidate renders; absent for exports. */
  readonly max_pixels?: number
}

export interface NativeArtifactEnvironment {
  readonly build_id: string
  readonly variant: 'desktop' | 'low-memory'
}

export interface RenderEnvironment {
  readonly render_engine: string
  readonly luma_color_runtime: string
  readonly luma_raw_runtime: string
  readonly luma_jpeg_runtime: string
  readonly native_artifacts: NativeArtifactEnvironment
}

// ---------------------------------------------------------------------------
// §6.1 — identity composition
// ---------------------------------------------------------------------------

/**
 * Identity block — what is known when a render STARTS. Shared between the
 * final `RenderManifest` and the mid-render `ExportCheckpointManifest` via
 * composition, not subtype. See §7 for the journal lifecycle.
 */
export interface RenderIdentity {
  readonly source_raw: SourceRawIdentity
  readonly calibration: CalibrationIdentity | null
  readonly lut: LutIdentity | null
  readonly color_graph: ColorGraphIdentity
  readonly render_params: RenderParams
  readonly policy: PolicyChoice
  readonly environment: RenderEnvironment
}

export type RenderManifestKind = 'preview' | 'candidate' | 'export'

/**
 * Final, post-render manifest — written ONCE after output bytes exist and
 * `OutputSink.close()` returns the output sha256. See §6.4 for the
 * canonicalization + self-hash contract.
 */
export interface RenderManifest extends RenderIdentity {
  readonly manifest_version: 1
  readonly kind: RenderManifestKind
  /** ISO 8601 UTC; render completion timestamp. */
  readonly produced_at: string
  /** For agent-loop chaining. `null` when this is the root of a chain. */
  readonly parent_manifest_sha256: string | null
  readonly output: OutputIdentity
  /** Canonical SHA-256 of this manifest with `manifest_sha256` excluded. */
  readonly manifest_sha256: string
}
