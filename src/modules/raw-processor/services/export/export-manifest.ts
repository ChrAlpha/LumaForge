import type { SupportedExportColorGraphDescriptor } from '@lumaforge/luma-color-runtime'
import type { ExportOutputResult } from '@lumaforge/render-engine/export'
import { materializeOutputBlob } from '@lumaforge/render-engine/export'
import type {
  LutIdentity,
  PolicyChoice,
  RenderEnvironment,
  RenderManifest,
} from '@lumaforge/render-engine/manifest'
import {
  createRenderManifest,
  lutIdentityFromProfile,
  projectManifestRenderParams,
} from '@lumaforge/render-engine/manifest'

import { sha256OfBlobOffThread } from '~/lib/export/blob-sha256-client'

import type {
  ExportManifestUnavailableReason,
  ExportResult,
} from '../../model/export-result'
import type { StyleAsset } from '../../model/session'
import { EXPORT_JPEG_QUALITY } from './export-system'

/** Build-time runtime versions for the memory profile the export ran with. */
export function resolveExportEnvironment(
  memoryProfile: 'desktop' | 'low-memory',
): RenderEnvironment {
  return APP_RENDER_ENVIRONMENTS[memoryProfile]
}

/**
 * Why a result's manifest cannot be sealed. File-backed output is never
 * reopened here: the export worker hashes the bytes as it writes them, and
 * results without that hash cannot be sealed.
 */
export class ExportManifestUnavailableError extends Error {
  constructor(
    readonly reason: ExportManifestUnavailableReason,
    message: string,
  ) {
    super(message)
    this.name = 'ExportManifestUnavailableError'
  }
}

/**
 * LUT identity for the active style: requires the .cube SHA-256 recorded at
 * load time and a confirmed color contract. Null for no look or a built-in
 * one; a custom LUT without either cannot be identified, and says why.
 */
function lutIdentityForStyle(style: StyleAsset | null | undefined): {
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

async function resolveOutputSha256(
  output: ExportOutputResult,
): Promise<string> {
  if (output.sha256) return output.sha256
  if (output.kind === 'file-backed') {
    throw new ExportManifestUnavailableError(
      'output-unhashed',
      'The export output hash was not recorded, so the manifest cannot be sealed without reopening the file.',
    )
  }
  return sha256OfBlobOffThread(await materializeOutputBlob(output))
}

export type BuildExportManifestInput = {
  /**
   * The result to seal. Its identity is the request it answers: the color
   * intent, RAW render exposure and geometry the manifest records come from
   * there, never from state read while sealing.
   */
  result: ExportResult
  /** The source file the identity names, read again only to hash it. */
  sourceFile: File
  graph: SupportedExportColorGraphDescriptor
  /** Decoded frame of the source RAW; differs from the output under geometry. */
  sourceDimensions: { width: number; height: number }
  style: StyleAsset | null | undefined
  policy: PolicyChoice
  environment: RenderEnvironment
  now?: () => Date
}

/**
 * Hash the source RAW (streaming, on a worker) and seal the manifest around
 * the delivered JPEG. The render params go through the engine's projection,
 * which records user color the way the color graph reads it and the look
 * strength exactly as given. Throws an `ExportManifestUnavailableError` when
 * the request, the source, the output hash or the active custom LUT cannot
 * be vouched for; callers treat that as "manifest unavailable" rather than
 * failing the export.
 */
export async function buildManifestForExportResult(
  input: BuildExportManifestInput,
): Promise<RenderManifest> {
  const { result } = input
  const { identity } = result
  if (!identity?.rawRenderExposure) {
    throw new ExportManifestUnavailableError(
      'internal',
      'The export result does not record the request it answers.',
    )
  }
  const { source, colorIntent, geometry } = identity
  if (
    input.sourceFile.name !== source.name ||
    input.sourceFile.size !== source.size ||
    input.sourceFile.lastModified !== source.lastModified
  ) {
    throw new ExportManifestUnavailableError(
      'internal',
      'The source file is not the one the export result was rendered from.',
    )
  }
  const lut = lutIdentityForStyle(input.style)
  if (input.style?.kind === 'custom' && !lut.identity) {
    throw new ExportManifestUnavailableError(
      lut.reason ?? 'internal',
      'The LUT could not be identified for the manifest.',
    )
  }
  const [sourceSha256, outputSha256] = await Promise.all([
    sha256OfBlobOffThread(input.sourceFile),
    resolveOutputSha256(result.output),
  ])
  const output = { width: result.width, height: result.height }
  return createRenderManifest({
    kind: 'export',
    source_raw: {
      sha256: sourceSha256,
      byte_size: input.sourceFile.size,
      filename: input.sourceFile.name,
      // The source's own decoded frame. Under geometry the delivered output
      // is a different size, and calling that the source's dimensions would
      // make the manifest describe a RAW file that does not exist.
      decoded_dimensions: input.sourceDimensions,
    },
    lut: lut.identity,
    graph: input.graph,
    render_params: projectManifestRenderParams({
      userColor: colorIntent,
      intensity: colorIntent.intensity,
      rawRenderExposure: identity.rawRenderExposure,
      ...(geometry
        ? {
            geometry: {
              matrix: geometry.matrix,
              constrain_crop: geometry.constrainCrop,
              output,
            },
          }
        : {}),
    }),
    policy: input.policy,
    environment: input.environment,
    output: {
      ...output,
      quality: Math.round(EXPORT_JPEG_QUALITY * 100),
      filename: result.filename,
      sha256: outputSha256,
    },
    parent_manifest_sha256: null,
    produced_at: input.now?.().toISOString(),
  })
}

/** How sealing a result's manifest ended. */
type ExportManifestSeal =
  | { status: 'ready'; manifest: RenderManifest }
  | { status: 'unavailable'; reason: ExportManifestUnavailableReason }

/**
 * The result with its sealing outcome attached. Everything else, the output
 * and the identity included, is the result's own: sealing a manifest late
 * never renames the request the result answers.
 */
export function sealExportResultManifest(
  result: ExportResult,
  seal: ExportManifestSeal,
): ExportResult {
  if (seal.status === 'ready') {
    return {
      ...result,
      manifest: seal.manifest,
      manifestState: { status: 'ready' },
    }
  }
  const { manifest: _unsealed, ...unsealed } = result
  return {
    ...unsealed,
    manifestState: { status: 'unavailable', reason: seal.reason },
  }
}
