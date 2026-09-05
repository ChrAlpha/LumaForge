import type {
  ProcessingParams,
  RawRenderExposure,
  SupportedExportColorGraphDescriptor,
} from '@lumaforge/luma-color-runtime'
import type {
  PolicyChoice,
  RenderEnvironment,
  RenderManifest,
} from '@lumaforge/render-engine/manifest'

import type { ExportOutputResult } from '~/lib/export/output-sink'
import { materializeOutputBlob } from '~/lib/export/output-sink'

import type { ExportResult } from '../../model/export-result'
import type { StyleAsset } from '../../model/session'
import {
  buildFullResExportManifest,
  lutIdentityForStyle,
  sha256OfBlob,
} from './export-manifest'

export type BuildExportManifestInput = {
  result: ExportResult
  sourceFile: Blob & { name: string }
  graph: SupportedExportColorGraphDescriptor
  params: ProcessingParams
  rawRenderExposure: RawRenderExposure
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
async function resolveOutputSha256(
  output: ExportOutputResult,
): Promise<string> {
  if (output.sha256) return output.sha256
  if (output.kind === 'file-backed') {
    throw new Error(
      'The export output hash was not recorded, so the manifest cannot be sealed without reopening the file.',
    )
  }
  return sha256OfBlob(await materializeOutputBlob(output))
}

/**
 * Hash the source RAW (streaming) and seal the manifest around the delivered
 * JPEG. Throws when the active custom LUT cannot be identified; callers treat
 * that as "manifest unavailable" rather than failing the export.
 */
export async function buildManifestForExportResult(
  input: BuildExportManifestInput,
): Promise<RenderManifest> {
  const lut = lutIdentityForStyle(input.style)
  if (input.style?.kind === 'custom' && !lut.identity) {
    throw new Error(lut.reason ?? 'The LUT could not be identified.')
  }
  const [sourceSha256, outputSha256] = await Promise.all([
    sha256OfBlob(input.sourceFile),
    resolveOutputSha256(input.result.output),
  ])
  return buildFullResExportManifest({
    graph: input.graph,
    params: input.params,
    rawRenderExposure: input.rawRenderExposure,
    source: {
      sha256: sourceSha256,
      byte_size: input.sourceFile.size,
      filename: input.sourceFile.name,
      decoded_dimensions: {
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
