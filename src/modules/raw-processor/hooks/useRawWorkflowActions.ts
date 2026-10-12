import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { useCallback, useEffect, useRef } from 'react'

import type { PreviewView } from '~/lib/preview/preview-view'
import type { PipelineStats } from '~/lib/webgpu/raw-processing-pipeline'

import type { ProcessingStatus } from '../model/workflow'
import {
  areSamePipelineStats,
  differsOnlyInTiming,
} from '../services/preview/pipeline-stats'

function enqueuePostCommitTask(task: () => void) {
  setTimeout(task, 0)
}

/**
 * A preview render reports fresh timings on every frame. The pipeline facts
 * (sizes, formats, the LUT path) publish at once; a change in timings alone
 * reaches the stats readers at most this often, because only a readout
 * shows the timings.
 */
export const PIPELINE_TIMING_PUBLISH_MS = 250

type UseRawWorkflowActionsInput = {
  viewRef: MutableRefObject<PreviewView>
  isMountedRef: MutableRefObject<boolean>
  status: ProcessingStatus
  setError: (error: string | null) => void
  setStatus: (status: ProcessingStatus) => void
  setStats: Dispatch<SetStateAction<PipelineStats | null>>
  /** The stats as the store holds them now. */
  getStats: () => PipelineStats | null
  postCommitTask?: (task: () => void) => void
}

export function useRawWorkflowActions({
  viewRef,
  isMountedRef,
  status,
  setError,
  setStatus,
  setStats,
  getStats,
  postCommitTask = enqueuePostCommitTask,
}: UseRawWorkflowActionsInput) {
  // The view as last rendered, read at call time. The color intent has no
  // port here: readers take it from the store, so a view port can never hand
  // out or carry color.
  const getCurrentView = useCallback(
    (): PreviewView => viewRef.current,
    [viewRef],
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

  const timingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingTimingRef = useRef<PipelineStats | null>(null)

  const updateStats = useCallback(
    (newStats: PipelineStats) => {
      // Preview renders report freshly allocated stats; keep the current value
      // when nothing changed so stats subscribers are not notified again.
      const publish = (next: PipelineStats) =>
        setStats((current) =>
          current && areSamePipelineStats(current, next) ? current : next,
        )
      const current = getStats()
      if (current && differsOnlyInTiming(current, newStats)) {
        pendingTimingRef.current = newStats
        if (timingTimerRef.current !== null) return
        timingTimerRef.current = setTimeout(() => {
          timingTimerRef.current = null
          const pending = pendingTimingRef.current
          pendingTimingRef.current = null
          // A reset or a new pipeline since then outdates these timings.
          const latest = getStats()
          if (pending && latest && differsOnlyInTiming(latest, pending)) {
            publish(pending)
          }
        }, PIPELINE_TIMING_PUBLISH_MS)
        return
      }
      if (timingTimerRef.current !== null) {
        clearTimeout(timingTimerRef.current)
        timingTimerRef.current = null
      }
      pendingTimingRef.current = null
      publish(newStats)
    },
    [getStats, setStats],
  )

  useEffect(
    () => () => {
      if (timingTimerRef.current !== null) clearTimeout(timingTimerRef.current)
      timingTimerRef.current = null
    },
    [],
  )

  return {
    getCurrentView,
    scheduleToast,
    dismissError,
    updateStats,
  }
}
