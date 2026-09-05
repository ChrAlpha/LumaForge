// `createRenderManifest` — the single place that assembles and seals a
// `RenderManifest` v1 from render-time facts. Shared by the CLI and the
// browser app so both write identical, cross-verifiable manifests.

import type { SupportedExportColorGraphDescriptor } from '@lumaforge/luma-color-runtime'

import { sealRenderManifest } from './canonicalize'
import { colorGraphIdentity } from './color-graph-descriptor'
import type {
  CalibrationIdentity,
  LutIdentity,
  PolicyChoice,
  RenderEnvironment,
  RenderManifest,
  RenderManifestKind,
  RenderParams,
  SourceRawIdentity,
} from './render-manifest'

export type CreateRenderManifestInput = {
  readonly kind: RenderManifestKind
  readonly source_raw: SourceRawIdentity
  readonly calibration?: CalibrationIdentity | null
  readonly lut: LutIdentity | null
  readonly graph: SupportedExportColorGraphDescriptor
  readonly render_params: RenderParams
  readonly policy: PolicyChoice
  readonly environment: RenderEnvironment
  readonly output: {
    readonly width: number
    readonly height: number
    /** JPEG quality as an integer percentage (1–100). */
    readonly quality: number
    readonly filename: string
    readonly sha256: string
  }
  readonly parent_manifest_sha256: string | null
  /** ISO 8601 UTC; defaults to now. */
  readonly produced_at?: string
}

export function createRenderManifest(
  input: CreateRenderManifestInput,
): RenderManifest {
  return sealRenderManifest({
    manifest_version: 1,
    kind: input.kind,
    produced_at: input.produced_at ?? new Date().toISOString(),
    parent_manifest_sha256: input.parent_manifest_sha256,
    source_raw: input.source_raw,
    calibration: input.calibration ?? null,
    lut: input.lut,
    color_graph: colorGraphIdentity(input.graph),
    render_params: input.render_params,
    policy: input.policy,
    environment: input.environment,
    output: {
      format: 'jpeg',
      dimensions: { width: input.output.width, height: input.output.height },
      color_space: 'srgb',
      quality: input.output.quality,
      filename: input.output.filename,
      sha256: input.output.sha256,
    },
  })
}
