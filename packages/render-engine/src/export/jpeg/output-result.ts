// Legacy ExportOutputResult shape (browser-flavored Blob or OPFS
// file-handle). Lives in the engine so the moved `wasm-row-sink` +
// `full-res-export` engine code can produce it without crossing back into
// `src/lib/export/output-sink.ts`. `src/lib/export/output-sink.ts` re-
// exports these types for backwards compatibility with app-side
// consumers (the OPFS impls stay there, they're env-bound).
//
// NOTE: This is not the context's `OutputSinkResult` (which carries
// `{sha256, byteSize}` for incremental hashing). Moving from
// `ExportOutputResult` to `OutputSinkResult` is an unfinished adapter
// refactor.

export type BlobOutputResult = {
  kind: 'blob'
  filename: string
  blob: Blob
  byteLength: number
  mimeType: string
}

export type FileBackedOutputResult = {
  kind: 'file-backed'
  exportId: string
  filename: string
  byteLength: number
  mimeType: string
  openBlob: () => Promise<Blob>
  cleanup?: () => Promise<void>
}

export type BytesOutputResult = {
  kind: 'bytes'
  filename: string
  bytes: Uint8Array
  byteLength: number
  mimeType: string
}

export type ExportOutputResult =
  | BlobOutputResult
  | FileBackedOutputResult
  | BytesOutputResult

export function createBlobOutputResult(input: {
  filename: string
  blob: Blob
}): BlobOutputResult {
  return {
    kind: 'blob',
    filename: input.filename,
    blob: input.blob,
    byteLength: input.blob.size,
    mimeType: input.blob.type || 'image/jpeg',
  }
}

export function createBytesOutputResult(input: {
  filename: string
  bytes: Uint8Array
  mimeType?: string
}): BytesOutputResult {
  return {
    kind: 'bytes',
    filename: input.filename,
    bytes: input.bytes,
    byteLength: input.bytes.byteLength,
    mimeType: input.mimeType ?? 'image/jpeg',
  }
}
