// The portable export output contract: an in-memory Blob, Node bytes, or a
// file-backed output that is opened lazily on delivery. Engine sinks, the
// browser export worker, and the CLI all produce this shape; storage-bound
// file-backed implementations (OPFS) live with their environment.

import type { JpegGainMapLayout } from './gain-map-container'
import type { JpegExportMetadata } from './jpeg-metadata'

/**
 * Set on a gain-map export: the stored bytes are the metadata-free primary
 * followed by the gain map, and delivery inserts the primary segments that
 * index it (`planJpegMetadataInjection` with this layout).
 */
type GainMapOutput = {
  gainMap?: JpegGainMapLayout
}

export type BlobOutputResult = GainMapOutput & {
  kind: 'blob'
  filename: string
  blob: Blob
  byteLength: number
  mimeType: string
  /** SHA-256 hex of the delivered bytes when the producer hashed them. */
  sha256?: string
}

export type FileBackedOutputResult = GainMapOutput & {
  kind: 'file-backed'
  exportId: string
  filename: string
  byteLength: number
  mimeType: string
  openBlob: () => Promise<Blob>
  cleanup?: () => Promise<void>
  /**
   * SHA-256 hex of the bytes `openBlob()` delivers (metadata included),
   * recorded by the producer at publish time so the file never has to be
   * reopened to identify the output.
   */
  sha256?: string
  /**
   * Metadata the producer assumed when recording `sha256`; delivery must
   * inject exactly this so the recorded hash stays truthful.
   */
  deliveryMetadata?: JpegExportMetadata | null
}

export type BytesOutputResult = GainMapOutput & {
  kind: 'bytes'
  filename: string
  bytes: Uint8Array
  byteLength: number
  mimeType: string
  /** SHA-256 hex of the delivered bytes when the producer hashed them. */
  sha256?: string
}

export type ExportOutputResult =
  | BlobOutputResult
  | FileBackedOutputResult
  | BytesOutputResult

export function createBlobOutputResult(input: {
  filename: string
  blob: Blob
  sha256?: string
  gainMap?: JpegGainMapLayout
}): BlobOutputResult {
  return {
    kind: 'blob',
    filename: input.filename,
    blob: input.blob,
    byteLength: input.blob.size,
    mimeType: input.blob.type || 'image/jpeg',
    ...(input.sha256 ? { sha256: input.sha256 } : {}),
    ...(input.gainMap ? { gainMap: input.gainMap } : {}),
  }
}

export function createBytesOutputResult(input: {
  filename: string
  bytes: Uint8Array
  mimeType?: string
  gainMap?: JpegGainMapLayout
}): BytesOutputResult {
  return {
    kind: 'bytes',
    filename: input.filename,
    bytes: input.bytes,
    byteLength: input.bytes.byteLength,
    mimeType: input.mimeType ?? 'image/jpeg',
    ...(input.gainMap ? { gainMap: input.gainMap } : {}),
  }
}

/**
 * The delivered Blob. A file-backed output is opened here, at handoff, and
 * never cleaned up: its owner decides when the file goes away.
 */
export async function materializeOutputBlob(
  result: ExportOutputResult,
): Promise<Blob> {
  if (result.kind === 'blob') return result.blob
  if (result.kind === 'bytes') {
    return new Blob([result.bytes as BlobPart], { type: result.mimeType })
  }
  return result.openBlob()
}
