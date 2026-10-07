import type { MutableRefObject } from 'react'
import { useCallback } from 'react'

import type { RawRuntimeHost } from '~/lib/raw/raw-runtime-host'
import type { RawRuntimeSession } from '~/lib/raw/runtime-adapter'

type UseRawRuntimeControlsInput = {
  /**
   * Cancels the load's session lease on the workflow host, which aborts its
   * native work and disposes its session exactly once.
   */
  cancelHostSession: RawRuntimeHost['cancelSession']
  // Preview restore still opens and disposes its own session through these.
  runtimeSessionRef: MutableRefObject<RawRuntimeSession | null>
  runtimeAbortControllerRef: MutableRefObject<AbortController | null>
  disposedRuntimeSessionsRef: MutableRefObject<WeakSet<RawRuntimeSession>>
  runtimeWorkSessionIdRef: MutableRefObject<string | null>
  exportAbortControllerRef: MutableRefObject<AbortController | null>
}

export function useRawRuntimeControls({
  cancelHostSession,
  runtimeSessionRef,
  runtimeAbortControllerRef,
  disposedRuntimeSessionsRef,
  runtimeWorkSessionIdRef,
  exportAbortControllerRef,
}: UseRawRuntimeControlsInput) {
  const disposeRuntimeSession = useCallback(
    (runtimeSession = runtimeSessionRef.current) => {
      if (
        !runtimeSession ||
        disposedRuntimeSessionsRef.current.has(runtimeSession)
      ) {
        return
      }

      disposedRuntimeSessionsRef.current.add(runtimeSession)
      runtimeSession.dispose()
      if (runtimeSessionRef.current === runtimeSession) {
        runtimeSessionRef.current = null
      }
    },
    [disposedRuntimeSessionsRef, runtimeSessionRef],
  )

  const abortRuntimeWork = useCallback(() => {
    runtimeWorkSessionIdRef.current = null
    cancelHostSession()
    const controller = runtimeAbortControllerRef.current
    if (controller && !controller.signal.aborted) {
      controller.abort()
    }
    runtimeAbortControllerRef.current = null
    disposeRuntimeSession()
  }, [
    cancelHostSession,
    disposeRuntimeSession,
    runtimeAbortControllerRef,
    runtimeWorkSessionIdRef,
  ])

  const abortExportWork = useCallback(() => {
    const controller = exportAbortControllerRef.current
    if (controller && !controller.signal.aborted) {
      controller.abort()
    }
    exportAbortControllerRef.current = null
  }, [exportAbortControllerRef])

  return {
    disposeRuntimeSession,
    abortRuntimeWork,
    abortExportWork,
  }
}
