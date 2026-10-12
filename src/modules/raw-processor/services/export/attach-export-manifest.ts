import type { SupportedExportColorGraphDescriptor } from '@lumaforge/luma-color-runtime'
import type { ExportOutputResult } from '@lumaforge/render-engine/export'
import { materializeOutputBlob } from '@lumaforge/render-engine/export'
import type {
  PolicyChoice,
  RenderEnvironment,
  RenderManifest,
} from '@lumaforge/render-engine/manifest'

import { sha256OfBlobOffThread } from '~/lib/export/blob-sha256-client'

import type {
  ExportManifestUnavailableReason,
  ExportResult,
} from '../../model/export-result'
import type { StyleAsset } from '../../model/session'
import {
  buildFullResExportManifest,
  lutIdentityForStyle,
} from './export-manifest'

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
  sourceDimensions?: { width: number; height: number }
  style: StyleAsset | null | undefined
  /** JPEG quality on the 0..1 scale used by the export job. */
  quality: number
  policy: PolicyChoice
  environment: RenderEnvironment
  now?: () => Date
}

/**
 * File-backed output is never reopened here: the export worker hashes the
 * bytes as it writes them, and results without that hash cannot be sealed.
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

/**
 * Hash the source RAW (streaming, on a worker) and seal the manifest around
 * the delivered JPEG. Throws when the active custom LUT cannot be identified; callers treat
 * that as "manifest unavailable" rather than failing the export.
 */
export async function buildManifestForExportResult(
  input: BuildExportManifestInput,
): Promise<RenderManifest> {
  const { identity } = input.result
  if (!identity?.rawRenderExposure) {
    throw new ExportManifestUnavailableError(
      'internal',
      'The export result does not record the request it answers.',
    )
  }
  const { source } = identity
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
    resolveOutputSha256(input.result.output),
  ])
  return buildFullResExportManifest({
    graph: input.graph,
    params: identity.colorIntent,
    rawRenderExposure: identity.rawRenderExposure,
    ...(identity.geometry
      ? {
          geometry: {
            matrix: identity.geometry.matrix,
            constrain_crop: identity.geometry.constrainCrop,
            output: { width: input.result.width, height: input.result.height },
          },
        }
      : {}),
    source: {
      sha256: sourceSha256,
      byte_size: input.sourceFile.size,
      filename: input.sourceFile.name,
      // The source's own decoded frame. Under geometry the delivered output
      // is a different size, and calling that the source's dimensions would
      // make the manifest describe a RAW file that does not exist.
      decoded_dimensions: input.sourceDimensions ?? {
        width: input.result.width,
        height: input.result.height,
      },
    },
    lut: lut.identity,
    output: {
      sha256: outputSha256,
      width: input.result.width,
      height: input.result.height,
      quality: input.quality,
      filename: input.result.filename,
    },
    policy: input.policy,
    environment: input.environment,
    producedAt: input.now?.(),
  })
}

/** How sealing a result's manifest ended. */
export type ExportManifestSeal =
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
