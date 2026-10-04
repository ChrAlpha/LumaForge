// LumaRenderContext.
//
// The single injection surface. Consumers (app, future CLI) construct one
// and pass it to every engine call. The engine never embeds OPFS, fs,
// localStorage, fetch, or capability detection — those concerns live
// outside via the injected interfaces below.

import type { LumaJpegRuntime } from '@lumaforge/luma-jpeg-runtime'
import type { LumaRawRuntime } from '@lumaforge/luma-raw-runtime'

import type { ExportCheckpointManifest } from '../manifest/export-checkpoint'
import type { RenderManifest } from '../manifest/render-manifest'
import type { CapabilityVector } from '../policy/capability-input'

// ---------------------------------------------------------------------------
// Output sink — chunked, atomic, self-hashing
// ---------------------------------------------------------------------------

export interface OutputSinkMeta {
  readonly format: 'jpeg'
  readonly expectedByteSize?: number
  readonly width: number
  readonly height: number
}

/**
 * Result of `OutputSinkHandle.close()`.
 *
 * Every variant carries the SHA-256 of the bytes written through this sink,
 * computed BY THE SINK **incrementally** during writes — the sink updates
 * a streaming SHA-256 state per `writeChunk` and finalizes the digest on
 * `close()`. Sinks MUST NOT accumulate the full output in memory; doing so
 * would defeat the OPFS / Node-streaming purpose for large full-resolution
 * exports. See the `streaming-sha256` helper.
 *
 * The engine reads `sha256` + `byteSize` from this result to populate the
 * final `RenderManifest.output` identity without re-reading output bytes.
 */
export type OutputSinkResult = {
  readonly sha256: string
  readonly byteSize: number
} & (
  | { readonly kind: 'blob'; readonly blob: Blob }
  | { readonly kind: 'file-handle'; readonly handle: unknown }
  | { readonly kind: 'file-path'; readonly path: string }
)

export interface OutputSinkHandle {
  writeChunk: (chunk: Uint8Array) => Promise<void>
  close: () => Promise<OutputSinkResult>
  abort: () => Promise<void>
}

export interface OutputSink {
  open: (name: string, meta: OutputSinkMeta) => Promise<OutputSinkHandle>
}

// ---------------------------------------------------------------------------
// Manifest + checkpoint stores (atomic persistence)
// ---------------------------------------------------------------------------

/**
 * Persistence of the final `RenderManifest`. Writes MUST be atomic — temp
 * + rename, or OPFS equivalent — so a manifest file is either fully
 * present or fully absent under crash.
 */
export interface ManifestStore {
  writeFinal: (name: string, manifest: RenderManifest) => Promise<void>
  read: (name: string) => Promise<RenderManifest | null>
}

/**
 * Persistence of the in-progress `ExportCheckpointManifest` journal.
 * `put()` overwrites the existing journal at the same name atomically.
 * `list()` supports session-start recovery.
 */
export interface CheckpointStore {
  put: (name: string, manifest: ExportCheckpointManifest) => Promise<void>
  read: (name: string) => Promise<ExportCheckpointManifest | null>
  delete: (name: string) => Promise<void>
  list: () => Promise<readonly string[]>
}

// ---------------------------------------------------------------------------
// Profile fetcher + cache
// ---------------------------------------------------------------------------

export interface ProfileFetchOptions {
  readonly maxBytes?: number
  readonly signal?: AbortSignal
}

export interface ProfileFetcher {
  fetchBytes: (url: string, options: ProfileFetchOptions) => Promise<Uint8Array>
  fetchJson: <T>(url: string, options: ProfileFetchOptions) => Promise<T>
}

export interface ProfileCache {
  get: (key: string) => Promise<Uint8Array | undefined>
  set: (key: string, value: Uint8Array) => Promise<void>
}

// ---------------------------------------------------------------------------
// Render events
// ---------------------------------------------------------------------------

export type RenderEvent =
  | {
      readonly kind: 'strip-completed'
      readonly strip: number
      readonly totalStrips: number
    }
  | { readonly kind: 'preview-frame-ready'; readonly sourceId: string }
  | { readonly kind: 'manifest-written'; readonly manifestSha256: string }
  | { readonly kind: 'render-failed'; readonly reason: string }

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/**
 * `LumaRenderContext` is the single injection surface. The engine receives
 * one and uses ONLY the interfaces it declares — no OPFS, no fs, no
 * localStorage, no fetch, no capability detection embedded inside the
 * engine package.
 *
 * Camera calibration (DCP) is **applied by the consumer** via
 * `LumaRawDecodeSession.applyCalibration()` BEFORE invoking the engine.
 * The engine receives an already-calibrated session and a
 * `CalibrationIdentity` (returned by the orchestrator's
 * `applySelectedCameraProfile`, never assembled by the caller) to write
 * into the manifest.
 */
export interface LumaRenderContext {
  readonly rawRuntime: LumaRawRuntime
  readonly jpegRuntime: LumaJpegRuntime

  readonly capability: CapabilityVector
  readonly observeRenderEvent?: (event: RenderEvent) => void

  readonly outputSink: OutputSink
  readonly manifestStore: ManifestStore
  readonly checkpointStore: CheckpointStore
  readonly profileFetcher?: ProfileFetcher
  readonly profileCache?: ProfileCache

  readonly signal?: AbortSignal
}
