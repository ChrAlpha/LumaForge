import type { PerformancePreference } from '../policy/export-policy'

export function normalizeExportConcurrency(
  requested: number | undefined,
  preference: PerformancePreference,
) {
  const defaultValue =
    preference === 'safe' ? 1 : preference === 'balanced' ? 2 : 3
  const raw = requested ?? defaultValue

  if (!Number.isFinite(raw) || raw <= 0) {
    throw new Error('FULL_RES_EXPORT_INVALID_CONCURRENCY')
  }

  return Math.min(3, Math.max(1, Math.floor(raw)))
}

export async function runOrderedConcurrent<T, R extends { index: number }>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  commit: (result: R) => Promise<void>,
  options: { onError?: (error: unknown) => void } = {},
) {
  if (items.length === 0) {
    return
  }

  const limit = Math.min(
    items.length,
    Math.max(1, Number.isFinite(concurrency) ? Math.floor(concurrency) : 1),
  )
  const results = new Map<number, R>()

  let active = 0
  let nextStart = 0
  let nextCommit = 0
  let commitRunning = false
  let firstError: unknown

  await new Promise<void>((resolve, reject) => {
    function fail(error: unknown) {
      if (firstError !== undefined) {
        return
      }

      firstError = error
      options.onError?.(error)
    }

    function finishIfSettled() {
      if (nextCommit >= items.length) {
        resolve()
        return
      }

      if (firstError !== undefined && active === 0 && !commitRunning) {
        reject(firstError)
      }
    }

    function startMore() {
      if (firstError !== undefined) {
        finishIfSettled()
        return
      }

      while (nextStart < items.length && active + results.size < limit) {
        const index = nextStart
        nextStart += 1
        active += 1

        void worker(items[index]!, index)
          .then((result) => {
            if (firstError !== undefined) {
              return
            }

            results.set(index, result)
            void drainCommits()
          })
          .catch((error: unknown) => {
            fail(error)
          })
          .finally(() => {
            active -= 1
            startMore()
            finishIfSettled()
          })
      }

      finishIfSettled()
    }

    async function drainCommits() {
      if (commitRunning || firstError !== undefined) {
        finishIfSettled()
        return
      }

      commitRunning = true
      try {
        while (results.has(nextCommit)) {
          if (firstError !== undefined) {
            break
          }

          const result = results.get(nextCommit)!
          await commit(result)
          results.delete(nextCommit)
          nextCommit += 1
          startMore()
        }
      } catch (error) {
        fail(error)
      } finally {
        commitRunning = false
        finishIfSettled()
      }
    }

    startMore()
  })
}
