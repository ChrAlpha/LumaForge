import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import process from 'node:process'

import { LmfgError } from '../protocol/errors'
import { fileExists, writeFileAtomic } from '../workspace/atomic-fs'

export const DEFAULT_LUT_MAX_BYTES = 64 * 1024 * 1024
export const DEFAULT_LUT_TIMEOUT_MS = 120_000
const SHA256_RE = /^[0-9a-f]{64}$/

export type FetchLutInput = {
  url: string
  expectedSha256: string
  destination: string
  allowNetwork: boolean
  maxBytes?: number
  timeoutMs?: number
  fetchImpl?: typeof fetch
  signal?: AbortSignal
}

export type FetchLutResult = {
  path: string
  url: string
  sha256: string
  byte_size: number
  cached: boolean
}

export function isNetworkAllowed(
  flag: boolean | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    Boolean(flag) ||
    env.LMFG_ALLOW_NETWORK === '1' ||
    env.LMFG_ALLOW_NETWORK === 'true'
  )
}

function sha256Of(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function isTimeout(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'TimeoutError' || error.name === 'AbortError')
  )
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])
const MAX_REDIRECTS = 5
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

/**
 * LUT downloads must use https; plain http is tolerated only for loopback
 * hosts (local mirrors and tests). Redirect targets go through the same gate.
 */
function assertAllowedTransport(url: URL): void {
  if (url.protocol === 'https:') return
  if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)) return
  throw new LmfgError('args.invalid', {
    message:
      url.protocol === 'http:'
        ? `LUT URLs must use https (plain http is only allowed for loopback hosts), got ${url.href}`
        : `LUT URLs must use https, got ${url.protocol}`,
  })
}

function combineSignals(signals: AbortSignal[]): AbortSignal {
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(signals)
  const controller = new AbortController()
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason)
      break
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), {
      once: true,
    })
  }
  return controller.signal
}

function parseHttpUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new LmfgError('args.invalid', {
      message: `Invalid LUT URL: ${value}`,
    })
  }
  assertAllowedTransport(url)
  return url
}

async function readBodyWithLimit(
  response: Response,
  maxBytes: number,
  url: URL,
  timeoutMs: number,
): Promise<Uint8Array> {
  const reader = response.body?.getReader()
  if (!reader) {
    throw new LmfgError('fetch.failed', {
      message: `${url.href} returned an empty body.`,
    })
  }
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        throw new LmfgError('fetch.failed', {
          message: `${url.href} exceeds the ${maxBytes} byte LUT limit.`,
          details: { max_bytes: maxBytes },
        })
      }
      chunks.push(value)
    }
  } catch (error) {
    if (error instanceof LmfgError) throw error
    throw new LmfgError('fetch.failed', {
      message: isTimeout(error)
        ? `Fetching ${url.href} timed out after ${timeoutMs} ms.`
        : `Failed to read ${url.href}: ${error instanceof Error ? error.message : String(error)}`,
      retryable: true,
      cause: error,
    })
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

/**
 * Download a `.cube` LUT into `destination`, verifying its SHA-256. A
 * destination that already carries the expected bytes is returned as a cache
 * hit without touching the network. Network access is denied unless
 * `allowNetwork` is true (exit code 5); transport failures, size limits and
 * hash mismatches map to exit code 6.
 */
async function fetchWithGuardedRedirects(
  fetchImpl: typeof fetch,
  url: URL,
  signal: AbortSignal,
): Promise<Response> {
  let current = url
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await fetchImpl(current, { signal, redirect: 'manual' })
    if (!REDIRECT_STATUSES.has(response.status)) return response
    const location = response.headers.get('location')
    if (!location) {
      throw new LmfgError('fetch.failed', {
        message: `${current.href} redirected without a Location header.`,
        details: { status: response.status },
      })
    }
    let next: URL
    try {
      next = new URL(location, current)
    } catch {
      throw new LmfgError('fetch.failed', {
        message: `${current.href} redirected to an invalid URL: ${location}`,
      })
    }
    try {
      assertAllowedTransport(next)
    } catch (error) {
      throw new LmfgError('fetch.failed', {
        message: `${current.href} redirected to a disallowed transport: ${next.href}`,
        details: {
          status: response.status,
          reason: error instanceof Error ? error.message : String(error),
        },
      })
    }
    current = next
  }
  throw new LmfgError('fetch.failed', {
    message: `${url.href} exceeded ${MAX_REDIRECTS} redirects.`,
  })
}

export async function fetchLutFile(
  input: FetchLutInput,
): Promise<FetchLutResult> {
  const expected = input.expectedSha256.trim().toLowerCase()
  if (!SHA256_RE.test(expected)) {
    throw new LmfgError('args.invalid', {
      message: '--sha256 must be 64 lowercase hex characters.',
    })
  }
  const url = parseHttpUrl(input.url)
  const maxBytes = input.maxBytes ?? DEFAULT_LUT_MAX_BYTES
  const timeoutMs = input.timeoutMs ?? DEFAULT_LUT_TIMEOUT_MS

  if (await fileExists(input.destination)) {
    const existing = await readFile(input.destination)
    const bytes = new Uint8Array(
      existing.buffer,
      existing.byteOffset,
      existing.byteLength,
    )
    if (sha256Of(bytes) === expected) {
      return {
        path: input.destination,
        url: url.href,
        sha256: expected,
        byte_size: bytes.byteLength,
        cached: true,
      }
    }
  }

  if (!input.allowNetwork) {
    throw new LmfgError('network.not_allowed', {
      message:
        'Network access is disabled for this command; pass --allow-network or set LMFG_ALLOW_NETWORK=1.',
      suggestedNextActions: [
        `lmfg lut fetch --url ${url.href} --sha256 ${expected} --allow-network`,
      ],
    })
  }

  const fetchImpl = input.fetchImpl ?? globalThis.fetch
  let response: Response
  try {
    const signal = combineSignals([
      AbortSignal.timeout(timeoutMs),
      ...(input.signal ? [input.signal] : []),
    ])
    response = await fetchWithGuardedRedirects(fetchImpl, url, signal)
  } catch (error) {
    throw new LmfgError('fetch.failed', {
      message: isTimeout(error)
        ? `Fetching ${url.href} timed out after ${timeoutMs} ms.`
        : `Failed to fetch ${url.href}: ${error instanceof Error ? error.message : String(error)}`,
      retryable: true,
      cause: error,
    })
  }
  if (!response.ok) {
    const retryable =
      response.status === 408 ||
      response.status === 429 ||
      response.status >= 500
    throw new LmfgError('fetch.failed', {
      message:
        `${url.href} responded ${response.status} ${response.statusText}`.trim(),
      retryable,
      details: { status: response.status },
    })
  }
  const contentLength = Number.parseInt(
    response.headers.get('content-length') ?? '',
    10,
  )
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new LmfgError('fetch.failed', {
      message: `${url.href} declares ${contentLength} bytes, above the ${maxBytes} byte LUT limit.`,
      details: { content_length: contentLength, max_bytes: maxBytes },
    })
  }

  const bytes = await readBodyWithLimit(response, maxBytes, url, timeoutMs)
  const actual = sha256Of(bytes)
  if (actual !== expected) {
    throw new LmfgError('hash.mismatch', {
      message: `SHA-256 mismatch for ${url.href}: expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}….`,
      details: {
        expected_sha256: expected,
        actual_sha256: actual,
        byte_size: bytes.byteLength,
      },
    })
  }
  await writeFileAtomic(input.destination, bytes)
  return {
    path: input.destination,
    url: url.href,
    sha256: actual,
    byte_size: bytes.byteLength,
    cached: false,
  }
}
