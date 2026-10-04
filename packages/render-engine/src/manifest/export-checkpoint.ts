// ExportCheckpointManifest — the mid-render export journal.
//
// Composes the shared `RenderIdentity` without being a subtype of
// `RenderManifest`. v1 supports safe-retry only: on interrupt, resume
// restarts from a verified RenderIdentity rather than reusing partial
// output bytes. row-resume is deferred.

import type { RenderIdentity } from './render-manifest'

/** How the source RAW bytes can be reacquired after a reload/crash. */
export type SourceReacquisitionMode =
  | 'current-session-file'
  | 'persisted-file-handle'
  | 'user-reselect-required'
  | 'opfs-source-copy'

export interface OutputIntent {
  readonly format: 'jpeg'
  readonly dimensions: { readonly width: number; readonly height: number }
  readonly color_space: 'srgb'
  readonly quality: number
  /** Basename only. */
  readonly filename: string
}

export interface ResumeFingerprint {
  readonly name: string
  readonly size: number
  /** Milliseconds since epoch. */
  readonly last_modified: number
  /** First 1 MiB SHA-256 — resume validation only, not content identity. */
  readonly hash_prefix_hex: string
}

/** Native JPEG resume state surfaced by the JPEG row writer. */
export type JpegResumeState = 'restart-required' | 'resumable'

export interface ExportInProgress {
  /** Strip indices already written. Telemetry/observability only in v1. */
  readonly completed_strips: readonly number[]
  readonly jpeg_state: JpegResumeState
}

export interface ExportCheckpointManifest extends RenderIdentity {
  readonly checkpoint_version: 1
  readonly kind: 'export-in-progress'
  readonly export_id: string
  /** ISO 8601 UTC. */
  readonly started_at: string
  /** ISO 8601 UTC. Refreshed on every put(). */
  readonly last_checkpointed_at: string

  /** v1 supports safe-retry only. row-resume modernization is a future spec. */
  readonly recovery_mode: 'safe-retry'

  /** How to reacquire source bytes after a reload/crash. */
  readonly source_reacquisition: SourceReacquisitionMode

  /** Intended output — dimensions/format known up-front; sha256 only on completion. */
  readonly output_intended: OutputIntent

  /** Fast resume validation token. NOT content identity (see `source-content-id.ts`). */
  readonly resume_fingerprint: ResumeFingerprint

  readonly in_progress: ExportInProgress
}
