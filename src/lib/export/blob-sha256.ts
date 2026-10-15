import { createStreamingSha256 } from '@lumaforge/render-engine/manifest'

/**
 * Streaming SHA-256 of a Blob or File on the calling thread, chunk by chunk,
 * so the whole payload is never held in memory at once. A RAW source is tens
 * of megabytes: off a worker, use `sha256OfBlobOffThread`.
 */
export async function sha256OfBlob(blob: Blob): Promise<string> {
  const hasher = createStreamingSha256()
  const reader = blob.stream().getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      hasher.update(value)
    }
  } finally {
    reader.releaseLock()
  }
  return hasher.digestHex()
}
