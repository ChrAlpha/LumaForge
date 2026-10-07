// Source content identity.
//
// `source_raw.sha256` is the **full-file streaming SHA-256** of the RAW
// source bytes. This is content identity, not a resume token. Two files
// with identical `{name, size, lastModified}` but different bytes MUST
// produce different sha256 — the fixture test enforces this.
//
// Implementation:
//   - Use `crypto.subtle.digest('SHA-256', bytes)` when available (modern
//     browsers and Node 18+).
//   - Fall back to the pure-JS streaming SHA-256 (`./streaming-sha256.ts`)
//     when WebCrypto is missing.
//
// Inputs:
//   - Bytes already in memory go through `sourceContentIdFromBytes`.
//   - A source too large to hold whole (a browser `File` or `Blob`) is fed
//     chunk by chunk to `createStreamingSha256`; nothing here reads a whole
//     Blob into memory.
//
// Cache contract:
//   - No cache here. The caller owns the lifetime of their bytes; if they
//     want a cache, they keep one keyed by their own source object or
//     open-handle identity.
//   - Metadata-keyed caching (`{name, size, lastModified}`) is EXPLICITLY
//     FORBIDDEN — metadata can collide across distinct content (file copies
//     preserve mtime; cameras reuse sequence numbers across cards).

import { createStreamingSha256 } from './streaming-sha256'

export interface SourceContentIdResult {
  readonly sha256: string
  readonly byteSize: number
}

const HEX_TABLE: ReadonlyArray<string> = Array.from({ length: 256 }, (_, i) =>
  i.toString(16).padStart(2, '0'),
)

function bytesToHex(bytes: Uint8Array): string {
  let hex = ''
  for (let i = 0; i < bytes.length; i += 1) {
    hex += HEX_TABLE[bytes[i]]
  }
  return hex
}

async function sha256OfBytes(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (subtle) {
    // `subtle.digest` hashes the bytes described by the view (not the whole
    // underlying buffer), so passing the Uint8Array directly is correct AND
    // keeps peak memory at ≈ byte_size. The earlier
    // defensive copy doubled peak to 2×byte_size without benefit; only
    // re-copy when the view is a subarray of a larger underlying buffer
    // AND we need an explicit `ArrayBuffer` to satisfy the BufferSource
    // typing across TS lib versions.
    const digest = await subtle.digest(
      'SHA-256',
      bytes as unknown as ArrayBuffer,
    )
    return bytesToHex(new Uint8Array(digest))
  }
  return createStreamingSha256().update(bytes).digestHex()
}

// ---------------------------------------------------------------------------
// Bytes (Node / universal)
// ---------------------------------------------------------------------------

/**
 * Compute the source content identity from an already-in-memory byte
 * array. Suitable for Node consumers who have read the file via
 * `fs.readFile` and for tests.
 *
 * No cache. The caller knows when the same Uint8Array is reused; if they
 * want a cache, they keep one.
 */
export async function sourceContentIdFromBytes(
  bytes: Uint8Array,
): Promise<SourceContentIdResult> {
  const sha256 = await sha256OfBytes(bytes)
  return { sha256, byteSize: bytes.byteLength }
}
