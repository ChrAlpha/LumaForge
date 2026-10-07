import type { MutableRefObject } from 'react'
import { useCallback } from 'react'

import type { RawRuntimeHost } from '~/lib/raw/raw-runtime-host'

type UseRawRuntimeControlsInput = {
  /**
   * Cancels the session lease on the workflow host (a load's or a restore's),
   * which aborts its native work and disposes its session exactly once.
   */
  cancelHostSession: RawRuntimeHost['cancelSession']
  runtimeWorkSessionIdRef: MutableRefObject<string | null>
  exportAbortControllerRef: MutableRefObject<AbortController | null>
}

export function useRawRuntimeControls({
  cancelHostSession,
  runtimeWorkSessionIdRef,
  exportAbortControllerRef,
}: UseRawRuntimeControlsInput) {
  const abortRuntimeWork = useCallback(() => {
    runtimeWorkSessionIdRef.current = null
    cancelHostSession()
  }, [cancelHostSession, runtimeWorkSessionIdRef])

  const abortExportWork = useCallback(() => {
    const controller = exportAbortControllerRef.current
    if (controller && !controller.signal.aborted) {
      controller.abort()
    }
    exportAbortControllerRef.current = null
  }, [exportAbortControllerRef])

  return {
    abortRuntimeWork,
    abortExportWork,
  }
}
