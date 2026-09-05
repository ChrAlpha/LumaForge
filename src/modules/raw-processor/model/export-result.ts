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

export type ExportManifestUnavailableReason =
  | 'lut-unconfirmed'
  | 'lut-unhashed'
  | 'output-unhashed'
  | 'internal'

/** Lifecycle of the sealed manifest for a full-resolution result. */
export type ExportManifestState =
  | { status: 'sealing' }
  | { status: 'ready' }
  | { status: 'unavailable'; reason: ExportManifestUnavailableReason }

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
  /** Absent for results that never seal a manifest (HQ preview exports). */
  manifestState?: ExportManifestState
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
  manifestState,
}: {
  output: ExportOutputResult
  kind?: ExportResultKind
  filename?: string
  width: number
  height: number
  now?: () => number
  copyCapability: ExportCopyCapability
  manifest?: RenderManifest
  manifestState?: ExportManifestState
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
    ...(manifestState ? { manifestState } : {}),
  }
}
