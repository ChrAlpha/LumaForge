import type { RenderManifest } from '@lumaforge/render-engine/manifest'

import type { ExportOutputResult } from '~/lib/export/output-sink'

export type ExportCopyCapability =
  | { mode: 'full-resolution'; label: 'Copy full-resolution image' }
  | { mode: 'hq-preview'; label: 'Copy HQ preview image' }
  | {
      mode: 'preview-size'
      label: 'Copy preview-size image'
      reason: string
    }
  | { mode: 'unavailable'; reason: string }

export type ExportResultKind = 'full-resolution' | 'hq-preview'

export type ExportShareCapability =
  | { available: true }
  | { available: false; reason: string }

export type ExportResult = {
  kind?: ExportResultKind
  output: ExportOutputResult
  filename: string
  width: number
  height: number
  size: number
  createdAt: number
  copyCapability: ExportCopyCapability
  /** Sealed render manifest; attached after a full-resolution export completes. */
  manifest?: RenderManifest
}

export function createExportResult({
  output,
  kind = 'full-resolution',
  filename = output.filename,
  width,
  height,
  now = () => Date.now(),
  copyCapability,
  manifest,
}: {
  output: ExportOutputResult
  kind?: ExportResultKind
  filename?: string
  width: number
  height: number
  now?: () => number
  copyCapability: ExportCopyCapability
  manifest?: RenderManifest
}): ExportResult {
  const createdAt = now()

  return {
    kind,
    output,
    filename,
    width,
    height,
    size: output.byteLength,
    createdAt,
    copyCapability,
    ...(manifest ? { manifest } : {}),
  }
}
