import { createStreamingSha256 } from '@lumaforge/render-engine/manifest'

function readBlobWithFileReader(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener('load', () => {
      resolve(reader.result as ArrayBuffer)
    })
    reader.addEventListener('error', () => {
      reject(reader.error ?? new Error('Blob read failed.'))
    })
    reader.readAsArrayBuffer(blob)
  })
}

async function readBlobBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === 'function') {
    return new Uint8Array(await blob.arrayBuffer())
  }
  // DOM shims (jsdom) expose FileReader but no Blob.arrayBuffer().
  return new Uint8Array(await readBlobWithFileReader(blob))
}

async function* streamChunks(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return
      if (value) yield value
    }
  } finally {
    reader.releaseLock()
  }
}

async function blobChunks(blob: Blob): Promise<AsyncIterable<Uint8Array>> {
  if (typeof blob.stream === 'function') {
    return streamChunks(blob.stream())
  }
  const bytes = await readBlobBytes(blob)
  return (async function* single() {
    yield bytes
  })()
}

/**
 * Streaming SHA-256 of a Blob or File on the calling thread, chunk by chunk,
 * so the whole payload is never held in memory at once. A RAW source is tens
 * of megabytes: off a worker, use `sha256OfBlobOffThread`.
 */
export async function sha256OfBlob(blob: Blob): Promise<string> {
  const hasher = createStreamingSha256()
  for await (const chunk of await blobChunks(blob)) {
    hasher.update(chunk)
  }
  return hasher.digestHex()
}
