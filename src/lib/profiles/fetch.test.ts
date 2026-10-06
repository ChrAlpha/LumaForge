import { afterEach, describe, expect, it, vi } from 'vitest'

import type { OnlineLUTAsset } from './catalog'
import {
  createMemoryOnlineProfileCache,
  fetchBytesWithLimit,
  fetchCachedBytesWithLimit,
  fetchJsonWithLimit,
  fetchVerifiedCubeAsset,
  OnlineProfileFetchError,
  sha256Hex,
} from './fetch'

const cubeBytes = new TextEncoder().encode('LUT_3D_SIZE 2\n')
const cubeHash =
  '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f'
const otherHash =
  '202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f'

function response(body: BodyInit, init?: ResponseInit): Response {
  return new Response(body, init)
}

function digestBuffer(hex: string): ArrayBuffer {
  return Uint8Array.from(hex.match(/../g) ?? [], (byte) =>
    Number.parseInt(byte, 16),
  ).buffer
}

function stubDigestForCubeBytes(): void {
  vi.stubGlobal('crypto', {
    subtle: {
      digest: vi.fn(async (_algorithm: string, bytes: ArrayBuffer) => {
        const text = new TextDecoder().decode(bytes)

        return digestBuffer(text === 'LUT_3D_SIZE 2\n' ? cubeHash : otherHash)
      }),
    },
  })
}

function cubeAsset(sha256 = cubeHash): OnlineLUTAsset {
  return {
    url: 'https://profiles.example.com/blobs/cube.cube',
    sha256,
    bytes: cubeBytes.byteLength,
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchJsonWithLimit', () => {
  it('passes the abort signal through to fetch', async () => {
    const controller = new AbortController()
    const fetch = vi.fn(async () => response('{"ok":true}'))
    vi.stubGlobal('fetch', fetch)

    await expect(
      fetchJsonWithLimit('https://profiles.example.com/catalog.json', {
        signal: controller.signal,
        maxBytes: 32,
      }),
    ).resolves.toEqual({ ok: true })

    expect(fetch).toHaveBeenCalledWith(
      'https://profiles.example.com/catalog.json',
      { credentials: 'omit', signal: controller.signal },
    )
  })

  it('rejects non-2xx responses with a typed network issue', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        response('nope', { status: 503, statusText: 'Service Unavailable' }),
      ),
    )

    await expect(
      fetchJsonWithLimit('https://profiles.example.com/catalog.json', {
        maxBytes: 32,
      }),
    ).rejects.toMatchObject({
      code: 'network',
      message:
        'Online profile request failed for https://profiles.example.com/catalog.json with HTTP 503 Service Unavailable.',
      name: 'OnlineProfileFetchError',
    })
  })

  it('preserves the caught fetch error as the network error cause', async () => {
    const cause = new Error('CORS blocked')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw cause
      }),
    )

    await expect(
      fetchJsonWithLimit('https://profiles.example.com/catalog.json', {
        maxBytes: 32,
      }),
    ).rejects.toMatchObject({
      cause,
      code: 'network',
      message:
        'Failed to fetch online profile resource: https://profiles.example.com/catalog.json',
    })
  })

  it('rejects Content-Length over max before reading the body', async () => {
    const arrayBuffer = vi.fn()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'Content-Length': '33' }),
        arrayBuffer,
      })),
    )

    await expect(
      fetchJsonWithLimit('https://profiles.example.com/catalog.json', {
        maxBytes: 32,
      }),
    ).rejects.toMatchObject({ code: 'size-limit' })
    expect(arrayBuffer).not.toHaveBeenCalled()
  })

  it('rejects bodies over max after reading', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response('{"too":"large"}')),
    )

    await expect(
      fetchJsonWithLimit('https://profiles.example.com/catalog.json', {
        maxBytes: 4,
      }),
    ).rejects.toMatchObject({ code: 'size-limit' })
  })

  it('rejects invalid JSON with a typed invalid-json issue', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response('not json')),
    )

    await expect(
      fetchJsonWithLimit('https://profiles.example.com/catalog.json', {
        maxBytes: 32,
      }),
    ).rejects.toMatchObject({ code: 'invalid-json' })
  })
})

describe('fetchBytesWithLimit', () => {
  it('rejects oversized CUBE responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(cubeBytes)),
    )

    await expect(
      fetchBytesWithLimit('https://profiles.example.com/blobs/cube.cube', {
        maxBytes: 4,
      }),
    ).rejects.toMatchObject({ code: 'size-limit' })
  })

  it('stops reading a streaming response as soon as chunks exceed the size limit', async () => {
    let pullCount = 0
    let canceled = false
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pullCount += 1

          if (pullCount === 1) {
            controller.enqueue(new Uint8Array([1, 2]))
            return
          }

          if (pullCount === 2) {
            controller.enqueue(new Uint8Array([3, 4, 5]))
            return
          }

          controller.enqueue(new Uint8Array([6]))
        },
        cancel() {
          canceled = true
        },
      },
      {
        highWaterMark: 0,
      },
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(stream)),
    )

    await expect(
      fetchBytesWithLimit('https://profiles.example.com/blobs/cube.cube', {
        maxBytes: 4,
      }),
    ).rejects.toMatchObject({ code: 'size-limit' })
    expect(pullCount).toBe(2)
    expect(canceled).toBe(true)
  })
})

describe('fetchCachedBytesWithLimit', () => {
  it('caches direct URL bytes on miss', async () => {
    const fetch = vi.fn(async () => response(cubeBytes))
    vi.stubGlobal('fetch', fetch)
    const cache = createMemoryOnlineProfileCache()

    const bytes = await fetchCachedBytesWithLimit(
      'https://profiles.example.com/blobs/../blobs/cube.cube',
      { maxBytes: 1024, cache },
    )

    expect([...bytes]).toEqual([...cubeBytes])
    expect(fetch).toHaveBeenCalledWith(
      'https://profiles.example.com/blobs/../blobs/cube.cube',
      { credentials: 'omit', signal: undefined },
    )
    expect([
      ...(await cache.get('url:https://profiles.example.com/blobs/cube.cube'))!,
    ]).toEqual([...cubeBytes])
  })

  it('returns URL-keyed cache hits without network fetch', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const cache = createMemoryOnlineProfileCache()
    await cache.set(
      'url:https://profiles.example.com/blobs/cube.cube',
      cubeBytes,
    )

    const bytes = await fetchCachedBytesWithLimit(
      'https://profiles.example.com/blobs/cube.cube',
      { maxBytes: 1024, cache },
    )

    expect([...bytes]).toEqual([...cubeBytes])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects relative direct URLs before fetching', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)

    await expect(
      fetchCachedBytesWithLimit('/relative.cube', {
        maxBytes: 1024,
        cache: createMemoryOnlineProfileCache(),
      }),
    ).rejects.toMatchObject({ code: 'invalid-url' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('shares cache identity for URL fragments', async () => {
    const fetch = vi.fn(async () => response(cubeBytes))
    vi.stubGlobal('fetch', fetch)
    const cache = createMemoryOnlineProfileCache()

    const first = await fetchCachedBytesWithLimit(
      'https://example.com/a.cube#one',
      { maxBytes: 1024, cache },
    )
    const second = await fetchCachedBytesWithLimit(
      'https://example.com/a.cube#two',
      { maxBytes: 1024, cache },
    )

    expect([...first]).toEqual([...cubeBytes])
    expect([...second]).toEqual([...cubeBytes])
    expect(fetch).toHaveBeenCalledTimes(1)
    expect([...(await cache.get('url:https://example.com/a.cube'))!]).toEqual([
      ...cubeBytes,
    ])
  })
})

describe('sha256Hex', () => {
  it('returns lowercase hex', async () => {
    vi.stubGlobal('crypto', {
      subtle: {
        digest: vi.fn(async () => digestBuffer('ABCDef')),
      },
    })

    await expect(sha256Hex(new Uint8Array([1, 2, 3]))).resolves.toBe('abcdef')
  })
})

describe('fetchVerifiedCubeAsset', () => {
  function digestMock() {
    return vi.mocked(globalThis.crypto.subtle.digest)
  }

  it('returns the verified bytes with their hash, hashing them once', async () => {
    stubDigestForCubeBytes()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(cubeBytes)),
    )

    const verified = await fetchVerifiedCubeAsset(cubeAsset(), {
      maxBytes: 1024,
    })

    expect([...verified.bytes]).toEqual([...cubeBytes])
    expect(verified.sha256).toBe(cubeHash)
    expect(digestMock()).toHaveBeenCalledTimes(1)
  })

  it('returns a lowercase hash and cache key for an uppercase manifest hash', async () => {
    stubDigestForCubeBytes()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(cubeBytes)),
    )
    const cache = createMemoryOnlineProfileCache()

    const verified = await fetchVerifiedCubeAsset(
      cubeAsset(cubeHash.toUpperCase()),
      { maxBytes: 1024, cache },
    )

    expect(verified.sha256).toBe(cubeHash)
    expect(await cache.get(`sha256:${cubeHash}`)).not.toBeNull()
  })

  it('rejects hash mismatches and does not cache bytes', async () => {
    stubDigestForCubeBytes()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(cubeBytes)),
    )
    const cache = createMemoryOnlineProfileCache()
    const set = vi.spyOn(cache, 'set')

    const promise = fetchVerifiedCubeAsset(cubeAsset(otherHash), {
      maxBytes: 1024,
      cache,
    })

    await expect(promise).rejects.toBeInstanceOf(OnlineProfileFetchError)
    await expect(promise).rejects.toMatchObject({ code: 'hash-mismatch' })
    expect(set).not.toHaveBeenCalled()
  })

  it('verifies cache hits without a second network call', async () => {
    stubDigestForCubeBytes()
    const fetch = vi.fn(async () => response(cubeBytes))
    vi.stubGlobal('fetch', fetch)
    const cache = createMemoryOnlineProfileCache()

    const fetched = await fetchVerifiedCubeAsset(cubeAsset(), {
      maxBytes: 1024,
      cache,
    })
    digestMock().mockClear()
    const cached = await fetchVerifiedCubeAsset(cubeAsset(), {
      maxBytes: 1024,
      cache,
    })

    expect([...fetched.bytes]).toEqual([...cubeBytes])
    expect(fetched.sha256).toBe(cubeHash)
    expect([...cached.bytes]).toEqual([...cubeBytes])
    expect(cached.sha256).toBe(cubeHash)
    expect(fetch).toHaveBeenCalledTimes(1)
    // A cache hit is still hashed: cached bytes are never trusted as-is.
    expect(digestMock()).toHaveBeenCalledTimes(1)
    expect([...(await cache.get(`sha256:${cubeHash}`))!]).toEqual([
      ...cubeBytes,
    ])
  })

  it('refetches and overwrites cache entries whose hash no longer matches', async () => {
    stubDigestForCubeBytes()
    const fetch = vi.fn(async () => response(cubeBytes))
    vi.stubGlobal('fetch', fetch)
    const cache = createMemoryOnlineProfileCache()
    await cache.set(`sha256:${cubeHash}`, new TextEncoder().encode('stale'))

    const verified = await fetchVerifiedCubeAsset(cubeAsset(), {
      maxBytes: 1024,
      cache,
    })

    expect([...verified.bytes]).toEqual([...cubeBytes])
    expect(verified.sha256).toBe(cubeHash)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect([...(await cache.get(`sha256:${cubeHash}`))!]).toEqual([
      ...cubeBytes,
    ])
  })

  it('forwards download progress and passes aborts through untouched', async () => {
    stubDigestForCubeBytes()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(cubeBytes)),
    )
    const events: number[] = []

    await fetchVerifiedCubeAsset(cubeAsset(), {
      maxBytes: 1024,
      onProgress: (received) => events.push(received),
    })

    expect(events.at(-1)).toBe(cubeBytes.byteLength)

    const abort = new DOMException('Aborted', 'AbortError')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw abort
      }),
    )

    await expect(
      fetchVerifiedCubeAsset(cubeAsset(), { maxBytes: 1024 }),
    ).rejects.toBe(abort)
  })
})

describe('fetchBytesWithLimit progress', () => {
  it('reports cumulative received bytes with the content-length total', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(10))
        controller.enqueue(new Uint8Array(5))
        controller.close()
      },
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        response(stream, { headers: { 'content-length': '15' } }),
      ),
    )
    const events: Array<{ received: number; total?: number }> = []

    await fetchBytesWithLimit('https://profiles.example.com/a.cube', {
      maxBytes: 100,
      onProgress: (received, total) => events.push({ received, total }),
    })

    expect(events).toEqual([
      { received: 10, total: 15 },
      { received: 15, total: 15 },
    ])
  })

  it('omits the total when content-length is absent', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(4))
        controller.close()
      },
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(stream)),
    )
    const events: Array<{ received: number; total?: number }> = []

    await fetchBytesWithLimit('https://profiles.example.com/a.cube', {
      maxBytes: 100,
      onProgress: (received, total) => events.push({ received, total }),
    })

    expect(events).toEqual([{ received: 4, total: undefined }])
  })
})
