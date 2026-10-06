// ExportCheckpointManifest — the mid-render export journal.
//
// Composes the shared `RenderIdentity` without being a subtype of
// `RenderManifest`. Every type here is deprecated: no engine function reads
// or writes this journal, and an interrupted export reruns from the start
// rather than resuming from partial output bytes. The types stay exported so
// existing imports compile.

import type { RenderIdentity } from './render-manifest'

/**
 * How the source RAW bytes can be reacquired after a reload/crash.
 *
 * @deprecated Part of the deprecated `ExportCheckpointManifest`.
 */
export type SourceReacquisitionMode =
  | 'current-session-file'
  | 'persisted-file-handle'
  | 'user-reselect-required'
  | 'opfs-source-copy'

/** @deprecated Part of the deprecated `ExportCheckpointManifest`. */
export interface OutputIntent {
  readonly format: 'jpeg'
  readonly dimensions: { readonly width: number; readonly height: number }
  readonly color_space: 'srgb'
  readonly quality: number
  /** Basename only. */
  readonly filename: string
}

/** @deprecated Part of the deprecated `ExportCheckpointManifest`. */
export interface ResumeFingerprint {
  readonly name: string
  readonly size: number
  /** Milliseconds since epoch. */
  readonly last_modified: number
  /** First 1 MiB SHA-256 — resume validation only, not content identity. */
  readonly hash_prefix_hex: string
}

/**
 * JPEG resume state recorded in the journal.
 *
 * @deprecated Part of the deprecated `ExportCheckpointManifest`.
 */
export type JpegResumeState = 'restart-required' | 'resumable'

/** @deprecated Part of the deprecated `ExportCheckpointManifest`. */
export interface ExportInProgress {
  /** Strip indices already written. Telemetry/observability only in v1. */
  readonly completed_strips: readonly number[]
  readonly jpeg_state: JpegResumeState
}

/**
 * In-progress export journal.
 *
 * @deprecated No engine function reads or writes this journal; an
 * interrupted export reruns from the start. It stays exported only so
 * existing imports compile. A manifest's source identity is
 * `source_raw.sha256`, the SHA-256 of the full file; `resume_fingerprint`
 * never stands in for it.
 */
export interface ExportCheckpointManifest extends RenderIdentity {
  readonly checkpoint_version: 1
  readonly kind: 'export-in-progress'
  readonly export_id: string
  /** ISO 8601 UTC. */
  readonly started_at: string
  /** ISO 8601 UTC. Refreshed on every put(). */
  readonly last_checkpointed_at: string

  /** safe-retry is the only recovery mode this journal defines. */
  readonly recovery_mode: 'safe-retry'

  /** How to reacquire source bytes after a reload/crash. */
  readonly source_reacquisition: SourceReacquisitionMode

  /** Intended output — dimensions/format known up-front; sha256 only on completion. */
  readonly output_intended: OutputIntent

  /** Fast resume validation token. NOT content identity (see `source-content-id.ts`). */
  readonly resume_fingerprint: ResumeFingerprint

  readonly in_progress: ExportInProgress
}
