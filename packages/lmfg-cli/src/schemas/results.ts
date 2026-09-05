import { z } from 'zod'

import { LutContractInputSchema } from './params'

const sha256 = z.string().regex(/^[0-9a-f]{64}$/)
const dims = z.object({ width: z.int().positive(), height: z.int().positive() })
const nullableString = z.string().nullable()
const nullableNumber = z.number().nullable()

export const NativeArtifactsSchema = z.object({
  build_id: z.string(),
  variant: z.enum(['desktop', 'low-memory']),
})

export const RuntimeVersionsSchema = z.object({
  luma_raw_runtime: z.string(),
  luma_color_runtime: z.string(),
  luma_jpeg_runtime: z.string(),
  render_engine: z.string(),
  native_artifacts: NativeArtifactsSchema,
})

export const VersionResultSchema = z.object({
  lmfg: z.string(),
  node: z.string(),
  platform: z.string(),
  arch: z.string(),
  runtime_versions: RuntimeVersionsSchema,
})

export const CapabilitiesResultSchema = z.object({
  render_tiers: z.object({
    cpu_wasm: z.object({
      available: z.boolean(),
      memory_profile: z.enum(['desktop', 'low-memory']),
      supports: z.array(z.string()),
      artifacts: z.object({ raw_wasm: z.boolean(), jpeg_wasm: z.boolean() }),
      reason: z.string().optional(),
    }),
    browser_bridge: z.object({
      available: z.boolean(),
      supports: z.array(z.string()),
      reason: z.string().optional(),
    }),
  }),
  active_tier: z.enum(['cpu_wasm']),
  fallback_order: z.array(z.string()),
  runtime_versions: RuntimeVersionsSchema,
  limits: z.object({
    max_candidates_per_sweep: z.int(),
    quick_preview_max_pixels: z.int(),
    bounded_hq_max_pixels: z.int(),
  }),
})

export const SchemaListResultSchema = z.object({
  schemas: z.array(z.object({ id: z.string(), description: z.string() })),
})

export const SchemaShowResultSchema = z.object({
  id: z.string(),
  description: z.string(),
  json_schema: z.record(z.string(), z.unknown()),
})

export const SessionSourceSchema = z.object({
  path: z.string(),
  filename: z.string(),
  byte_size: z.int().nonnegative(),
  sha256,
})

export const SessionRecordSchema = z.object({
  schema: z.literal('lmfg.session.v1'),
  id: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  workspace_root: z.string(),
  source: SessionSourceSchema,
  decoded_dimensions: dims.nullable(),
  counters: z.object({
    previews: z.int(),
    iterations: z.int(),
    exports: z.int(),
  }),
  status: z.enum(['initialized', 'inspected']),
})

export const SessionStatusResultSchema = SessionRecordSchema.extend({
  session_dir: z.string(),
  source_present: z.boolean(),
  iterations: z.array(
    z.object({
      id: z.string(),
      created_at: z.string(),
      kind: z.enum(['candidate', 'sweep']),
      candidate_count: z.int(),
      contact_sheet: z.boolean(),
    }),
  ),
  previews: z.array(z.string()),
  exports: z.array(
    z.object({
      name: z.string(),
      output_uri: z.string(),
      manifest_uri: z.string(),
    }),
  ),
})

export const SessionListResultSchema = z.object({
  workspace_root: z.string(),
  sessions: z.array(SessionRecordSchema),
})

export const ExposureSchema = z.object({
  ev: z.number(),
  multiplier: z.number(),
  source: z.enum(['dng-baseline', 'image-statistics', 'identity', 'user']),
})

export const InspectResultSchema = z.object({
  session_id: nullableString,
  source: SessionSourceSchema,
  metadata: z.object({
    make: nullableString,
    model: nullableString,
    lens: nullableString,
    iso: nullableNumber,
    aperture: nullableNumber,
    focal_length: nullableNumber,
    shutter: nullableNumber,
    timestamp: nullableNumber,
    orientation: nullableNumber,
    width: nullableNumber,
    height: nullableNumber,
    raw_width: nullableNumber,
    raw_height: nullableNumber,
    baseline_exposure: nullableNumber,
    support_level: z.enum(['official', 'experimental', 'unsupported']),
  }),
  decoded_dimensions: dims,
  embedded_preview: z
    .object({
      width: z.int(),
      height: z.int(),
      mime_type: z.string(),
      byte_size: z.int(),
      uri: z.string().nullable(),
    })
    .nullable(),
  export_capability: z.object({
    supported: z.boolean(),
    strategy: nullableString,
    width: z.int(),
    height: z.int(),
    reasons: z.array(z.string()),
  }),
  raw_render_exposure: ExposureSchema,
  timings_ms: z.record(z.string(), z.number()),
})

export const LutProfileOutputSchema = z.object({
  profile_id: z.string(),
  label: z.string(),
  role: z.string(),
  input_gamut: z.string(),
  input_transfer: z.string(),
  input_range: z.string(),
  output_gamut: nullableString,
  output_transfer: nullableString,
  output_range: nullableString,
})

export const LutResolutionSchema = z.object({
  kind: z.enum(['confirmed', 'recommended', 'unknown', 'unsupported-output']),
  confidence: z.enum(['metadata', 'user', 'persisted-user']).optional(),
  profile: LutProfileOutputSchema.optional(),
  recommendations: z.array(LutProfileOutputSchema).optional(),
})

const tuple3 = z.tuple([z.number(), z.number(), z.number()])

export const LutInspectResultSchema = z.object({
  path: z.string(),
  filename: z.string(),
  sha256,
  byte_size: z.int(),
  title: z.string(),
  size: z.int(),
  domain_min: tuple3,
  domain_max: tuple3,
  comments: z.array(z.string()),
  fingerprint: z.string(),
  valid: z.boolean(),
  validation_errors: z.array(z.string()),
  resolution: LutResolutionSchema,
})

export const LutContractInferResultSchema = z.object({
  path: z.string(),
  sha256,
  resolution: LutResolutionSchema,
  complete: z.boolean(),
  contract: LutContractInputSchema.nullable(),
  suggested_contracts: z.array(LutContractInputSchema),
  message: z.string(),
})

export const LutContractValidateResultSchema = z.object({
  path: z.string(),
  sha256,
  valid: z.boolean(),
  issues: z.array(z.string()),
  contract: LutContractInputSchema.nullable(),
  profile: LutProfileOutputSchema.nullable(),
  export_supported: z.boolean(),
  export_reason: nullableString,
})

export const LutFetchResultSchema = z.object({
  path: z.string(),
  url: z.string(),
  sha256,
  byte_size: z.int(),
  cached: z.boolean(),
  inspect: LutInspectResultSchema,
  contract: LutContractInferResultSchema,
})

export const RenderOutputSchema = z.object({
  uri: z.string(),
  path: z.string(),
  width: z.int(),
  height: z.int(),
  byte_size: z.int(),
  sha256,
  quality: z.int().min(1).max(100),
})

export const PreviewResultSchema = z.object({
  session_id: z.string(),
  preview_id: z.string(),
  output: RenderOutputSchema,
  manifest_uri: z.string(),
  manifest_sha256: sha256,
  decode: z.enum(['quick', 'bounded-hq']),
  raw_render_exposure: ExposureSchema,
  color_graph_fingerprint: sha256,
  timings_ms: z.record(z.string(), z.number()),
})

export const CandidateSummarySchema = z.object({
  id: z.string(),
  index: z.int(),
  tag: nullableString,
  preview_uri: z.string(),
  manifest_uri: z.string(),
  manifest_sha256: sha256,
  metrics_uri: z.string(),
  width: z.int(),
  height: z.int(),
  byte_size: z.int(),
  sha256,
})

export const ContactSheetSummarySchema = z.object({
  uri: z.string(),
  map_uri: z.string(),
  width: z.int(),
  height: z.int(),
  cols: z.int(),
  rows: z.int(),
  tile_width: z.int(),
  tile_height: z.int(),
})

export const ResourceUsageSchema = z.object({
  /** Peak resident set size of the CLI process in bytes. */
  max_rss_bytes: z.int(),
})

export const IterationResultSchema = z.object({
  session_id: z.string(),
  iteration_id: z.string(),
  iteration_dir: z.string(),
  kind: z.enum(['candidate', 'sweep']),
  candidate_count: z.int(),
  candidates: z.array(CandidateSummarySchema),
  contact_sheet: ContactSheetSummarySchema.nullable(),
  decode: z.enum(['quick', 'bounded-hq']),
  raw_render_exposure: ExposureSchema,
  /** Worker pool size actually used (1 = inline). */
  concurrency: z.int(),
  timings_ms: z.record(z.string(), z.number()),
  resource: ResourceUsageSchema,
})

export const ExportResultSchema = z.object({
  session_id: z.string(),
  output: RenderOutputSchema,
  manifest_uri: z.string(),
  manifest_sha256: sha256,
  parent_manifest_sha256: sha256.nullable(),
  color_graph_fingerprint: sha256,
  raw_render_exposure: ExposureSchema,
  strips: z.int(),
  timings_ms: z.record(z.string(), z.number()),
  resource: ResourceUsageSchema.optional(),
})

export const ReplayResultSchema = z.object({
  session_id: nullableString,
  manifest_path: z.string(),
  kind: z.enum(['preview', 'candidate', 'export']),
  reproduced: z.boolean(),
  expected_sha256: sha256,
  actual_sha256: sha256,
  fingerprint_match: z.boolean().nullable(),
  output: RenderOutputSchema,
  manifest_uri: z.string(),
  manifest_sha256: sha256,
  parent_manifest_sha256: sha256,
  timings_ms: z.record(z.string(), z.number()),
})

export const CompareSheetResultSchema = z.object({
  session_id: z.string(),
  iteration_id: z.string(),
  contact_sheet: ContactSheetSummarySchema,
  tiles: z.array(
    z.object({
      candidate_id: z.string(),
      index: z.int(),
      x: z.int(),
      y: z.int(),
      width: z.int(),
      height: z.int(),
    }),
  ),
})

export const MetricsSchema = z.object({
  schema: z.literal('lmfg.metrics.v1'),
  width: z.int(),
  height: z.int(),
  sampled_pixels: z.int(),
  luma: z.object({
    mean: z.number(),
    p1: z.number(),
    p50: z.number(),
    p99: z.number(),
    clipped_highlight_ratio: z.number(),
    clipped_shadow_ratio: z.number(),
  }),
  chroma: z.object({ mean_saturation: z.number(), colorfulness: z.number() }),
  histogram: z.object({ bins: z.int(), luma: z.array(z.int()) }),
  approximate: z.boolean(),
})

export const MetricsResultSchema = z.object({
  session_id: z.string(),
  iteration_id: z.string(),
  candidate_id: z.string(),
  metrics_uri: z.string(),
  metrics: MetricsSchema,
})

export const METRIC_KEY_VALUES = [
  'luma.mean',
  'luma.p1',
  'luma.p50',
  'luma.p99',
  'luma.clipped_highlight_ratio',
  'luma.clipped_shadow_ratio',
  'chroma.mean_saturation',
  'chroma.colorfulness',
] as const

export const MetricKeySchema = z.enum(METRIC_KEY_VALUES)

export const ObjectiveTermSchema = z
  .strictObject({
    target: z.number().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    weight: z.number().min(0).optional(),
  })
  .describe(
    'Aim for target, or stay within [min, max]; penalty = weight × distance.',
  )

export const ObjectiveSchema = z
  .partialRecord(MetricKeySchema, ObjectiveTermSchema)
  .describe('Objective for `lmfg metrics rank`: one term per metric key.')

export const MetricDeltaSchema = z.object({
  baseline: z.number(),
  value: z.number(),
  delta: z.number(),
})

export const MetricsCompareResultSchema = z.object({
  session_id: z.string(),
  iteration_id: z.string(),
  baseline_candidate_id: z.string(),
  candidates: z.array(
    z.object({
      candidate_id: z.string(),
      tag: nullableString,
      metrics_uri: z.string(),
      deltas: z.record(MetricKeySchema, MetricDeltaSchema),
    }),
  ),
})

export const MetricsRankResultSchema = z.object({
  session_id: z.string(),
  iteration_id: z.string(),
  objective: ObjectiveSchema,
  ranking: z.array(
    z.object({
      rank: z.int(),
      candidate_id: z.string(),
      tag: nullableString,
      score: z.number(),
      terms: z.array(
        z.object({
          key: MetricKeySchema,
          value: z.number(),
          penalty: z.number(),
          weight: z.number(),
        }),
      ),
      preview_uri: z.string(),
      manifest_sha256: sha256,
    }),
  ),
})

export const ManifestVerifyResultSchema = z.object({
  path: z.string(),
  valid: z.boolean(),
  manifest_sha256: sha256.nullable(),
  kind: nullableString,
  issues: z.array(z.string()),
  warnings: z.array(z.string()),
  environment_match: z.boolean().nullable(),
})

export const ManifestShowResultSchema = z.object({
  path: z.string(),
  verified: z.boolean(),
  warnings: z.array(z.string()),
  manifest: z.record(z.string(), z.unknown()),
})

export const DryRunResultSchema = z.object({
  dry_run: z.literal(true),
  command: z.string(),
  plan: z.record(z.string(), z.unknown()),
})

export const ErrorEnvelopeSchema = z.object({
  schema: z.literal('lmfg.error.v1'),
  ok: z.literal(false),
  error: z.object({
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
    suggested_next_actions: z.array(z.string()),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
})

export const EventSchema = z
  .object({
    event: z.string(),
    schema: z.literal('lmfg.event.v1'),
  })
  .catchall(z.unknown())

export type RuntimeVersions = z.output<typeof RuntimeVersionsSchema>
export type VersionResult = z.output<typeof VersionResultSchema>
export type CapabilitiesResult = z.output<typeof CapabilitiesResultSchema>
export type SessionRecord = z.output<typeof SessionRecordSchema>
export type SessionStatusResult = z.output<typeof SessionStatusResultSchema>
export type InspectResult = z.output<typeof InspectResultSchema>
export type Exposure = z.output<typeof ExposureSchema>
export type LutProfileOutput = z.output<typeof LutProfileOutputSchema>
export type LutResolutionOutput = z.output<typeof LutResolutionSchema>
export type LutInspectResult = z.output<typeof LutInspectResultSchema>
export type LutContractInferResult = z.output<
  typeof LutContractInferResultSchema
>
export type LutContractValidateResult = z.output<
  typeof LutContractValidateResultSchema
>
export type LutFetchResult = z.output<typeof LutFetchResultSchema>
export type RenderOutput = z.output<typeof RenderOutputSchema>
export type PreviewResult = z.output<typeof PreviewResultSchema>
export type CandidateSummary = z.output<typeof CandidateSummarySchema>
export type ContactSheetSummary = z.output<typeof ContactSheetSummarySchema>
export type IterationResult = z.output<typeof IterationResultSchema>
export type ExportResult = z.output<typeof ExportResultSchema>
export type CompareSheetResult = z.output<typeof CompareSheetResultSchema>
export type ReplayResult = z.output<typeof ReplayResultSchema>
export type Metrics = z.output<typeof MetricsSchema>
export type MetricsResult = z.output<typeof MetricsResultSchema>
export type ManifestVerifyResult = z.output<typeof ManifestVerifyResultSchema>
export type ManifestShowResult = z.output<typeof ManifestShowResultSchema>
export type DryRunResult = z.output<typeof DryRunResultSchema>
export type MetricsCompareResult = z.output<typeof MetricsCompareResultSchema>
export type MetricsRankResult = z.output<typeof MetricsRankResultSchema>
