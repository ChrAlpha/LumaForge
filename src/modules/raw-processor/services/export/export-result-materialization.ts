import type { JpegExportMetadata } from '@lumaforge/render-engine/export'
import { preserveJpegMetadata } from '@lumaforge/render-engine/export'

import type { ExportOutputResult } from '~/lib/export/output-sink'
import { createBlobOutputResult } from '~/lib/export/output-sink'

import type {
  ExportCopyCapability,
  ExportManifestState,
  ExportResultKind,
} from '../../model/export-result'
import { createExportResult } from '../../model/export-result'

export type CompletedExportJobResult = {
  filename: string
  output?: ExportOutputResult
  blob?: Blob
}

function withLazyJpegMetadata(input: {
  output: ExportOutputResult
  metadata: unknown
  width: number
  height: number
}): ExportOutputResult {
  if (input.output.kind !== 'file-backed') {
    return input.output
  }

  const output = input.output
  // A producer that recorded the output hash also fixed the metadata it
  // hashed with; injecting anything else would falsify that identity.
  const metadata =
    output.deliveryMetadata !== undefined
      ? output.deliveryMetadata
      : (input.metadata as JpegExportMetadata | null | undefined)
  return {
    ...output,
    async openBlob() {
      return preserveJpegMetadata({
        jpeg: await output.openBlob(),
        metadata,
        width: input.width,
        height: input.height,
      })
    },
  }
}

export function createCompletedExportResult({
  jobResult,
  kind,
  metadata,
  width,
  height,
  copyCapability,
  now,
  manifestState,
}: {
  jobResult: CompletedExportJobResult
  kind?: ExportResultKind
  metadata: unknown
  width: number
  height: number
  copyCapability: ExportCopyCapability
  now?: () => number
  manifestState?: ExportManifestState
}) {
  const output =
    jobResult.output ??
    (jobResult.blob
      ? createBlobOutputResult({
          filename: jobResult.filename,
          blob: jobResult.blob,
        })
      : undefined)

  if (!output) {
    throw new Error('EXPORT_OUTPUT_MISSING')
  }

  return createExportResult({
    output: withLazyJpegMetadata({
      output,
      metadata,
      width,
      height,
    }),
    kind,
    manifestState,
    filename: jobResult.filename,
    width,
    height,
    now,
    copyCapability,
  })
}
