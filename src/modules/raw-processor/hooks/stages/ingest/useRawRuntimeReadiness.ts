import { useCallback, useEffect, useSyncExternalStore } from 'react'

import type { RawRuntimeHost } from '~/lib/raw/raw-runtime-host'

import { deriveRawRuntimeReadiness } from '../../../components/raw-runtime-readiness'

/**
 * Readiness of the workflow's own RAW host. It subscribes to the host, so an
 * idle termination or a later rewarm shows without polling, and warming here
 * starts the same runtime the workflow loads on.
 */
export function useRawRuntimeReadiness(host: RawRuntimeHost) {
  const snapshot = useSyncExternalStore(
    host.subscribe,
    host.getSnapshot,
    host.getSnapshot,
  )
  const runtimeReadinessState = deriveRawRuntimeReadiness(snapshot)

  const triggerRawRuntimePrewarm = useCallback(() => {
    if (typeof window === 'undefined') return
    if (import.meta.env.MODE === 'test') return
    void host.prewarm()
  }, [host])

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (import.meta.env.MODE === 'test') return
    let cancelled = false
    const trigger = () => {
      if (cancelled) return
      triggerRawRuntimePrewarm()
    }
    const win = window as Window & {
      requestIdleCallback?: (
        cb: () => void,
        opts?: { timeout?: number },
      ) => number
      cancelIdleCallback?: (handle: number) => void
    }
    if (typeof win.requestIdleCallback === 'function') {
      const handle = win.requestIdleCallback(trigger, { timeout: 1500 })
      return () => {
        cancelled = true
        win.cancelIdleCallback?.(handle)
      }
    }
    const handle = window.setTimeout(trigger, 200)
    return () => {
      cancelled = true
      window.clearTimeout(handle)
    }
  }, [triggerRawRuntimePrewarm])

  return { runtimeReadinessState, triggerRawRuntimePrewarm }
}
