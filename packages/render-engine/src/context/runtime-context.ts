// LumaRenderContext.
//
// A context-object injection surface that no engine function accepts. Engine
// calls take explicit parameters instead (sinks, capability vectors, runtime
// factories, abort signals), so every type here is deprecated and kept only so
// existing imports keep compiling. The engine still never embeds OPFS, fs,
// localStorage, fetch, or capability detection.

import type { LumaJpegRuntime } from '@lumaforge/luma-jpeg-runtime'
import type { LumaRawRuntime } from '@lumaforge/luma-raw-runtime'

import type { ExportCheckpointManifest } from '../manifest/export-checkpoint'
import type { RenderManifest } from '../manifest/render-manifest'
import type { CapabilityVector } from '../policy/capability-input'

// ---------------------------------------------------------------------------
// Output sink — chunked, atomic, self-hashing
// ---------------------------------------------------------------------------

/**
 * @deprecated Part of the `LumaRenderContext` surface, which no engine
 * function accepts.
 */
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
 * @deprecated Part of the `LumaRenderContext` surface, which no engine
 * function accepts. Export sinks return `ExportOutputResult` from
 * `@lumaforge/render-engine/export`, which carries the delivered `sha256`
 * when the producer hashed it.
 */
export type OutputSinkResult = {
  readonly sha256: string
  readonly byteSize: number
} & (
  | { readonly kind: 'blob'; readonly blob: Blob }
  | { readonly kind: 'file-handle'; readonly handle: unknown }
  | { readonly kind: 'file-path'; readonly path: string }
)

/**
 * @deprecated Part of the `LumaRenderContext` surface, which no engine
 * function accepts.
 */
export interface OutputSinkHandle {
  writeChunk: (chunk: Uint8Array) => Promise<void>
  close: () => Promise<OutputSinkResult>
  abort: () => Promise<void>
}

/**
 * @deprecated Part of the `LumaRenderContext` surface, which no engine
 * function accepts. Pass a `JpegRowSink` to
 * `runFullResolutionJpegExport` instead.
 */
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
 *
 * @deprecated Part of the `LumaRenderContext` surface, which no engine
 * function accepts.
 */
export interface ManifestStore {
  writeFinal: (name: string, manifest: RenderManifest) => Promise<void>
  read: (name: string) => Promise<RenderManifest | null>
}

/**
 * Persistence of the in-progress `ExportCheckpointManifest` journal.
 * `put()` overwrites the existing journal at the same name atomically.
 *
 * @deprecated Part of the `LumaRenderContext` surface, which no engine
 * function accepts. No engine function reads or writes the checkpoint
 * journal; an interrupted export reruns from the start.
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

/**
 * @deprecated Part of the `LumaRenderContext` surface, which no engine
 * function accepts.
 */
export interface ProfileFetchOptions {
  readonly maxBytes?: number
  readonly signal?: AbortSignal
}

/**
 * @deprecated Part of the `LumaRenderContext` surface, which no engine
 * function accepts.
 */
export interface ProfileFetcher {
  fetchBytes: (url: string, options: ProfileFetchOptions) => Promise<Uint8Array>
  fetchJson: <T>(url: string, options: ProfileFetchOptions) => Promise<T>
}

/**
 * @deprecated Part of the `LumaRenderContext` surface, which no engine
 * function accepts.
 */
export interface ProfileCache {
  get: (key: string) => Promise<Uint8Array | undefined>
  set: (key: string, value: Uint8Array) => Promise<void>
}

// ---------------------------------------------------------------------------
// Render events
// ---------------------------------------------------------------------------

/**
 * @deprecated Part of the `LumaRenderContext` surface, which no engine
 * function accepts. Export progress is reported
 * through `runFullResolutionJpegExport`'s `onProgress` callback.
 */
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
 * A context object bundling runtimes, capability, sinks, stores and
 * callbacks for engine calls.
 *
 * @deprecated No engine function accepts a `LumaRenderContext`, and nothing
 * reads the stores or callbacks it declares. Engine calls take explicit
 * parameters: `runFullResolutionJpegExport` takes its `jpegSink` and
 * `signal`, and the policy functions take a `CapabilityVector`. The type is
 * unchanged and still exported from `@lumaforge/render-engine`.
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
