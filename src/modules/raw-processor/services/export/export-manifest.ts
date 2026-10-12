import type {
  ColorGraphIntent,
  RawRenderExposure,
  SupportedExportColorGraphDescriptor,
} from '@lumaforge/luma-color-runtime'
import type {
  GeometryParams,
  LutIdentity,
  PolicyChoice,
  RenderEnvironment,
  RenderManifest,
  RenderParams,
  SourceRawIdentity,
} from '@lumaforge/render-engine/manifest'
import {
  createRenderManifest,
  lutIdentityFromProfile,
  projectManifestRenderParams,
} from '@lumaforge/render-engine/manifest'

import type { ExportManifestUnavailableReason } from '../../model/export-result'
import type { StyleAsset } from '../../model/session'

export type ExportManifestMemoryProfile = 'desktop' | 'low-memory'

/** Build-time runtime versions for the memory profile the export ran with. */
export function resolveExportEnvironment(
  memoryProfile: ExportManifestMemoryProfile,
): RenderEnvironment {
  return APP_RENDER_ENVIRONMENTS[memoryProfile]
}

/**
 * Project the app's color intent onto the manifest `RenderParams`
 * through the shared render-engine projection, which records user color the
 * way the color graph reads it and the look strength exactly as given. View
 * state never reaches it; the look selection and LUT identity are recorded
 * elsewhere in the manifest.
 */
export function toManifestRenderParams(
  params: ColorGraphIntent,
  exposure: RawRenderExposure,
  geometry?: GeometryParams,
): RenderParams {
  return projectManifestRenderParams({
    userColor: params,
    intensity: params.intensity,
    rawRenderExposure: exposure,
    ...(geometry ? { geometry } : {}),
  })
}

/**
 * LUT identity for the active style: requires the .cube SHA-256 recorded at
 * load time and a confirmed color contract. Returns `null` for built-in looks
 * or when either is missing (the manifest then records `lut: null`, which the
 * caller treats as "manifest unavailable" for custom LUT exports).
 */
export function lutIdentityForStyle(style: StyleAsset | null | undefined): {
  identity: LutIdentity | null
  reason?: ExportManifestUnavailableReason
} {
  if (!style || style.kind !== 'custom') return { identity: null }
  const asset = style.lutAsset
  if (!asset?.sha256) {
    return { identity: null, reason: 'lut-unhashed' }
  }
  if (asset.profileResolution?.kind !== 'confirmed') {
    return { identity: null, reason: 'lut-unconfirmed' }
  }
  const result = lutIdentityFromProfile({
    filename: asset.sourceName ?? asset.title ?? style.name,
    sha256: asset.sha256,
    profile: asset.profileResolution.profile,
  })
  return result.identity
    ? { identity: result.identity }
    : { identity: null, reason: 'lut-unconfirmed' }
}

export type BuildFullResExportManifestInput = {
  graph: SupportedExportColorGraphDescriptor
  params: ColorGraphIntent
  rawRenderExposure: RawRenderExposure
  /** Present only when a geometry was applied at full resolution. */
  geometry?: GeometryParams
  source: SourceRawIdentity
  lut: LutIdentity | null
  output: {
    sha256: string
    width: number
    height: number
    /** JPEG quality on the 0..1 scale used by the export job. */
    quality: number
    filename: string
  }
  policy: PolicyChoice
  environment: RenderEnvironment
  producedAt?: Date
}

export function buildFullResExportManifest(
  input: BuildFullResExportManifestInput,
): RenderManifest {
  return createRenderManifest({
    kind: 'export',
    source_raw: input.source,
    lut: input.lut,
    graph: input.graph,
    render_params: toManifestRenderParams(
      input.params,
      input.rawRenderExposure,
      input.geometry,
    ),
    policy: input.policy,
    environment: input.environment,
    output: {
      width: input.output.width,
      height: input.output.height,
      quality: Math.round(input.output.quality * 100),
      filename: input.output.filename,
      sha256: input.output.sha256,
    },
    parent_manifest_sha256: null,
    produced_at: input.producedAt?.toISOString(),
  })
}
