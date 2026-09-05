import { createWriteStream, promises as fs } from 'node:fs'
import process from 'node:process'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export function isRetryableStatus(status) {
  return status === 408 || status === 429 || status >= 500
}

function describeError(error, timeoutMs) {
  if (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  ) {
    return { message: `timed out after ${timeoutMs}ms`, retryable: true }
  }
  const message = error instanceof Error ? error.message : String(error)
  const retryable =
    error && typeof error === 'object' && 'retryable' in error
      ? Boolean(error.retryable)
      : true
  return { message, retryable }
}

/**
 * Download the first reachable URL into `destination` (atomic temp+rename).
 * Each URL is tried up to `attempts` times with exponential backoff; a
 * non-retryable HTTP status (4xx other than 408/429) moves on to the next
 * URL immediately. Throws an error listing every failed attempt.
 */
export async function downloadToFile({
  urls,
  destination,
  timeoutMs = 120_000,
  attempts = 3,
  backoffMs = 2_000,
  fetchImpl = globalThis.fetch,
  log = () => {},
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  if (!Array.isArray(urls) || urls.length === 0) {
    throw new TypeError('downloadToFile requires at least one URL')
  }
  const failures = []
  const tempPath = `${destination}.download-${process.pid}`

  for (const url of urls) {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await fetchImpl(url, {
          signal: AbortSignal.timeout(timeoutMs),
        })
        if (!response.ok) {
          const error = new Error(`${response.status} ${response.statusText}`)
          error.retryable = isRetryableStatus(response.status)
          throw error
        }
        if (!response.body) {
          throw new Error('response body is empty')
        }
        await pipeline(Readable.fromWeb(response.body), createWriteStream(tempPath))
        await fs.rename(tempPath, destination)
        return { url, attempt }
      } catch (error) {
        await fs.rm(tempPath, { force: true })
        const { message, retryable } = describeError(error, timeoutMs)
        failures.push({ url, attempt, message })
        log(`download attempt ${attempt}/${attempts} failed for ${url}: ${message}`)
        if (!retryable) break
        if (attempt < attempts) {
          await sleep(backoffMs * 2 ** (attempt - 1))
        }
      }
    }
  }

  const summary = failures
    .map((failure) => `  ${failure.url} (attempt ${failure.attempt}): ${failure.message}`)
    .join('\n')
  throw new Error(
    `Failed to download ${destination} from ${urls.length} source(s):\n${summary}`,
  )
}
