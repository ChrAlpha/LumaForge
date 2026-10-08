import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { useCallback } from 'react'

import type { PreviewView } from '~/lib/preview/preview-view'
import type { PipelineStats } from '~/lib/webgpu/raw-processing-pipeline'

import type { ProcessingStatus } from '../model/workflow'

function enqueuePostCommitTask(task: () => void) {
  setTimeout(task, 0)
}

type PipelineSize = PipelineStats['inputSize']

function isSamePipelineSize(a: PipelineSize, b: PipelineSize) {
  return a.width === b.width && a.height === b.height
}

// Every stats field must be listed, so a new field cannot be silently ignored.
const PIPELINE_STATS_FIELD_EQUALITY: {
  [Key in keyof PipelineStats]: (
    a: PipelineStats[Key],
    b: PipelineStats[Key],
  ) => boolean
} = {
  uploadTime: Object.is,
  lutUploadTime: Object.is,
  processTime: Object.is,
  totalTime: Object.is,
  inputSize: isSamePipelineSize,
  previewSize: isSamePipelineSize,
  inputFormat: Object.is,
  transformPath: Object.is,
  lutRole: Object.is,
  lutInputTransfer: Object.is,
  lutOutputTransfer: Object.is,
  lutSize: Object.is,
}

const PIPELINE_STATS_FIELDS = Object.keys(
  PIPELINE_STATS_FIELD_EQUALITY,
) as Array<keyof PipelineStats>

function isSamePipelineStatsField<Key extends keyof PipelineStats>(
  key: Key,
  a: PipelineStats,
  b: PipelineStats,
) {
  return PIPELINE_STATS_FIELD_EQUALITY[key](a[key], b[key])
}

function areSamePipelineStats(a: PipelineStats, b: PipelineStats) {
  return PIPELINE_STATS_FIELDS.every((key) =>
    isSamePipelineStatsField(key, a, b),
  )
}

type UseRawWorkflowActionsInput = {
  viewRef: MutableRefObject<PreviewView>
  isMountedRef: MutableRefObject<boolean>
  status: ProcessingStatus
  setError: (error: string | null) => void
  setStatus: (status: ProcessingStatus) => void
  setStats: Dispatch<SetStateAction<PipelineStats | null>>
  postCommitTask?: (task: () => void) => void
}

export function useRawWorkflowActions({
  viewRef,
  isMountedRef,
  status,
  setError,
  setStatus,
  setStats,
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

  const updateStats = useCallback(
    (newStats: PipelineStats) => {
      // Preview renders report freshly allocated stats; keep the current value
      // when nothing changed so stats subscribers are not notified again.
      setStats((current) =>
        current && areSamePipelineStats(current, newStats) ? current : newStats,
      )
    },
    [setStats],
  )

  return {
    getCurrentView,
    scheduleToast,
    dismissError,
    updateStats,
  }
}
