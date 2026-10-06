import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { useCallback } from 'react'

import type { ImageSession } from '../../../model/session'
import type { ProcessingStatus } from '../../../model/workflow'
import {
  clearExportResultState,
  hasActiveExport,
} from '../../../services/export/export-state'

export type SetImageSession = Dispatch<SetStateAction<ImageSession | null>>

type UseExportGraphInvalidationInput = {
  exportGraphVersionRef: MutableRefObject<number>
  previewCopyCanvasRef: MutableRefObject<HTMLCanvasElement | null>
  exportAbortControllerRef: MutableRefObject<AbortController | null>
  sessionRef: MutableRefObject<ImageSession | null>
  abortExportWork: () => void
  queueExportResultResourceDisposal: () => void
  setSession: SetImageSession
  setStatus: (status: ProcessingStatus) => void
  setProgress: (progress: number) => void
}

export function useExportGraphInvalidation({
  exportGraphVersionRef,
  previewCopyCanvasRef,
  exportAbortControllerRef,
  sessionRef,
  abortExportWork,
  queueExportResultResourceDisposal,
  setSession,
  setStatus,
  setProgress,
}: UseExportGraphInvalidationInput) {
  const invalidateExportGraph = useCallback(() => {
    exportGraphVersionRef.current += 1
    previewCopyCanvasRef.current = null
    const exportWasActive = hasActiveExport(
      exportAbortControllerRef.current,
      sessionRef.current,
    )

    abortExportWork()
    queueExportResultResourceDisposal()
    setSession(clearExportResultState)

    if (exportWasActive) {
      setStatus('ready')
      setProgress(0)
    }
  }, [
    abortExportWork,
    exportAbortControllerRef,
    exportGraphVersionRef,
    previewCopyCanvasRef,
    queueExportResultResourceDisposal,
    sessionRef,
    setProgress,
    setSession,
    setStatus,
  ])

  return { invalidateExportGraph }
}
