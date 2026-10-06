import type { OnlineLUTAsset } from './catalog'
import { normalizeProfileSourceUrl } from './source-url'

export type OnlineProfileFetchErrorCode =
  | 'network'
  | 'size-limit'
  | 'invalid-json'
  | 'hash-mismatch'
  | 'unsupported-crypto'

export class OnlineProfileFetchError extends Error {
  readonly code: OnlineProfileFetchErrorCode

  constructor(
    code: OnlineProfileFetchErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'OnlineProfileFetchError'
    this.code = code
  }
}

export interface OnlineProfileCache {
  get: (cacheKey: string) => Promise<Uint8Array | null>
  set: (cacheKey: string, bytes: Uint8Array) => Promise<void>
}

function normalizeHash(hash: string | undefined): string | undefined {
  return hash?.toLowerCase()
}

function getContentLength(headers: Headers): number | undefined {
  const value = headers.get('Content-Length')
  if (!value) return undefined

  const length = Number(value)

  return Number.isFinite(length) && length >= 0 ? length : undefined
}

function assertContentLengthWithinLimit(
  headers: Headers,
  maxBytes: number,
): void {
  const contentLength = getContentLength(headers)

  if (contentLength !== undefined && contentLength > maxBytes) {
    throw new OnlineProfileFetchError(
      'size-limit',
      `Online profile response is larger than ${maxBytes} bytes.`,
    )
  }
}

function assertBytesWithinLimit(bytes: Uint8Array, maxBytes: number): void {
  if (bytes.byteLength > maxBytes) {
    throw new OnlineProfileFetchError(
      'size-limit',
      `Online profile response is larger than ${maxBytes} bytes.`,
    )
  }
}

async function fetchResponse(
  url: string,
  signal: AbortSignal | undefined,
): Promise<Response> {
  let response: Response

  try {
    response = await fetch(url, { credentials: 'omit', signal })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error
    }

    throw new OnlineProfileFetchError(
      'network',
      `Failed to fetch online profile resource: ${url}`,
      { cause: error },
    )
  }

  if (!response.ok) {
    throw new OnlineProfileFetchError(
      'network',
      `Online profile request failed for ${url} with HTTP ${response.status} ${response.statusText}.`,
    )
  }

  return response
}

export type OnlineProfileFetchProgress = (
  receivedBytes: number,
  totalBytes?: number,
) => void

async function readBytesWithLimit(
  response: Response,
  maxBytes: number,
  onProgress?: OnlineProfileFetchProgress,
): Promise<Uint8Array> {
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    assertBytesWithinLimit(bytes, maxBytes)

    return bytes
  }

  // Note: with a content-encoded response this is the compressed size while
  // the reader yields decompressed bytes; callers preferring an exact total
  // should use the catalog-declared asset size instead.
  const contentLength = getContentLength(response.headers)
  const declaredTotal = contentLength || undefined
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    totalBytes += value.byteLength
    if (totalBytes > maxBytes) {
      await reader.cancel()
      throw new OnlineProfileFetchError(
        'size-limit',
        `Online profile response is larger than ${maxBytes} bytes.`,
      )
    }

    chunks.push(value)
    onProgress?.(totalBytes, declaredTotal)
  }

  const bytes = new Uint8Array(totalBytes)
  let offset = 0

  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }

  return bytes
}

export async function fetchBytesWithLimit(
  url: string,
  options: {
    signal?: AbortSignal
    maxBytes: number
    onProgress?: OnlineProfileFetchProgress
  },
): Promise<Uint8Array> {
  const response = await fetchResponse(url, options.signal)
  assertContentLengthWithinLimit(response.headers, options.maxBytes)

  return readBytesWithLimit(response, options.maxBytes, options.onProgress)
}

export async function fetchJsonWithLimit<T>(
  url: string,
  options: { signal?: AbortSignal; maxBytes: number },
): Promise<T> {
  const bytes = await fetchBytesWithLimit(url, options)
  const json = new TextDecoder().decode(bytes)

  try {
    return JSON.parse(json) as T
  } catch {
    throw new OnlineProfileFetchError(
      'invalid-json',
      'Online profile JSON response is invalid.',
    )
  }
}

async function getSubtleCrypto(): Promise<SubtleCrypto> {
  if (globalThis.crypto?.subtle) return globalThis.crypto.subtle

  throw new OnlineProfileFetchError(
    'unsupported-crypto',
    'SubtleCrypto digest support is unavailable.',
  )
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = await getSubtleCrypto()
  const buffer = bytes.buffer
  const digestInput =
    buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === buffer.byteLength
      ? buffer
      : bytes.slice().buffer
  const digest = new Uint8Array(await subtle.digest('SHA-256', digestInput))

  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  )
}

export function createMemoryOnlineProfileCache(): OnlineProfileCache {
  const entries = new Map<string, Uint8Array>()

  return {
    async get(cacheKey) {
      const bytes = entries.get(cacheKey)

      return bytes ? new Uint8Array(bytes) : null
    },
    async set(cacheKey, bytes) {
      entries.set(cacheKey, new Uint8Array(bytes))
    },
  }
}

function cacheRequest(cacheKey: string): Request {
  return new Request(
    `https://lumaforge.local/online-profile-cache/${encodeURIComponent(cacheKey)}`,
  )
}

export function createBrowserOnlineProfileCache(
  cacheName = 'lumaforge-online-profiles',
): OnlineProfileCache {
  if (!globalThis.caches) return createMemoryOnlineProfileCache()

  return {
    async get(cacheKey) {
      const cache = await globalThis.caches.open(cacheName)
      const response = await cache.match(cacheRequest(cacheKey))
      if (!response) return null

      return new Uint8Array(await response.arrayBuffer())
    },
    async set(cacheKey, bytes) {
      const cache = await globalThis.caches.open(cacheName)

      await cache.put(
        cacheRequest(cacheKey),
        new Response(new Uint8Array(bytes), {
          headers: { 'Content-Type': 'application/octet-stream' },
        }),
      )
    },
  }
}

function normalizeCacheUrl(url: string): string {
  const normalized = new URL(normalizeProfileSourceUrl(url))
  normalized.hash = ''

  return normalized.href
}

export async function fetchCachedBytesWithLimit(
  url: string,
  options: {
    signal?: AbortSignal
    maxBytes: number
    cache?: OnlineProfileCache
    onProgress?: OnlineProfileFetchProgress
  },
): Promise<Uint8Array> {
  const cacheKey = `url:${normalizeCacheUrl(url)}`
  const cachedBytes = await options.cache?.get(cacheKey)
  if (cachedBytes) return cachedBytes

  const bytes = await fetchBytesWithLimit(url, options)

  await options.cache?.set(cacheKey, bytes)

  return bytes
}

async function readVerifiedCache(
  cache: OnlineProfileCache,
  cacheKey: string,
  expectedHash: string,
): Promise<Uint8Array | null> {
  const cachedBytes = await cache.get(cacheKey)
  if (!cachedBytes) return null

  return (await sha256Hex(cachedBytes)) === expectedHash ? cachedBytes : null
}

export interface VerifiedCubeAsset {
  bytes: Uint8Array
  /**
   * Lowercase SHA-256 of `bytes`, checked against the manifest on every
   * return, cache hits included. Callers record it instead of hashing the
   * bytes again; null only when the asset declares no hash, in which case
   * the caller must hash the bytes itself.
   */
  sha256: string | null
}

export async function fetchVerifiedCubeAsset(
  asset: OnlineLUTAsset,
  options: {
    signal?: AbortSignal
    maxBytes: number
    cache?: OnlineProfileCache
    onProgress?: OnlineProfileFetchProgress
  },
): Promise<VerifiedCubeAsset> {
  const expectedHash = normalizeHash(asset.sha256)

  if (!expectedHash) {
    return {
      bytes: await fetchBytesWithLimit(asset.url, options),
      sha256: null,
    }
  }

  const cacheKey = `sha256:${expectedHash}`
  const cachedBytes = options.cache
    ? await readVerifiedCache(options.cache, cacheKey, expectedHash)
    : null
  if (cachedBytes) return { bytes: cachedBytes, sha256: expectedHash }

  const bytes = await fetchBytesWithLimit(asset.url, options)
  const actualHash = await sha256Hex(bytes)

  if (actualHash !== expectedHash) {
    throw new OnlineProfileFetchError(
      'hash-mismatch',
      'Online profile asset hash does not match the manifest.',
    )
  }

  await options.cache?.set(cacheKey, bytes)

  return { bytes, sha256: actualHash }
}
