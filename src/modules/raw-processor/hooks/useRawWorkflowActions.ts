import type { ProcessingParams } from '@lumaforge/luma-color-runtime'
import type { MutableRefObject } from 'react'
import { useCallback } from 'react'

import type { PipelineStats } from '~/lib/webgpu/raw-processing-pipeline'

import type { ProcessingStatus } from '../model/workflow'

function enqueuePostCommitTask(task: () => void) {
  setTimeout(task, 0)
}

type UseRawWorkflowActionsInput = {
  paramsRef: MutableRefObject<ProcessingParams>
  isMountedRef: MutableRefObject<boolean>
  status: ProcessingStatus
  setError: (error: string | null) => void
  setStatus: (status: ProcessingStatus) => void
  setStats: (stats: PipelineStats | null) => void
  postCommitTask?: (task: () => void) => void
}

export function useRawWorkflowActions({
  paramsRef,
  isMountedRef,
  status,
  setError,
  setStatus,
  setStats,
  postCommitTask = enqueuePostCommitTask,
}: UseRawWorkflowActionsInput) {
  const getCurrentProcessingParams = useCallback(
    () => paramsRef.current,
    [paramsRef],
  )

  const scheduleToast = useCallback(
    (notify: () => void) => {
      // Sonner uses flushSync internally; move RAW-workspace toasts out of the
      // current commit so dev-only tooling does not crash on the same render pass.
      postCommitTask(() => {
        if (!isMountedRef.current) {
          return
        }

        notify()
      })
    },
    [isMountedRef, postCommitTask],
  )

  const dismissError = useCallback(() => {
    setError(null)
    if (status === 'error') {
      setStatus('idle')
    }
  }, [setError, status, setStatus])

  const updateStats = useCallback(
    (newStats: PipelineStats) => {
      setStats(newStats)
    },
    [setStats],
  )

  return {
    getCurrentProcessingParams,
    scheduleToast,
    dismissError,
    updateStats,
  }
}
