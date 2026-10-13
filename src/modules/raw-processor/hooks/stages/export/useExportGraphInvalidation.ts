import type { MutableRefObject } from 'react'
import { useCallback } from 'react'

import type { ImageSession } from '../../../model/session'
import type { ProcessingStatus } from '../../../model/workflow'
import {
  clearExportResultState,
  hasActiveExport,
} from '../../../services/export/export-state'
import type { SetImageSession } from '../../../state/session.atoms'

type UseExportGraphInvalidationInput = {
  exportGraphVersionRef: MutableRefObject<number>
  exportAbortControllerRef: MutableRefObject<AbortController | null>
  /** Reads the session from the store when called. */
  getSession: () => ImageSession | null
  abortExportWork: () => void
  queueExportResultResourceDisposal: () => void
  setSession: SetImageSession
  setStatus: (status: ProcessingStatus) => void
  setProgress: (progress: number) => void
}

export function useExportGraphInvalidation({
  exportGraphVersionRef,
  exportAbortControllerRef,
  getSession,
  abortExportWork,
  queueExportResultResourceDisposal,
  setSession,
  setStatus,
  setProgress,
}: UseExportGraphInvalidationInput) {
  const invalidateExportGraph = useCallback(() => {
    exportGraphVersionRef.current += 1
    // The session the store holds now, so an export a write in the same tick
    // started or settled, before any rerender, decides whether to settle.
    const exportWasActive = hasActiveExport(
      exportAbortControllerRef.current,
      getSession(),
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
    getSession,
    queueExportResultResourceDisposal,
    setProgress,
    setSession,
    setStatus,
  ])

  return { invalidateExportGraph }
}
