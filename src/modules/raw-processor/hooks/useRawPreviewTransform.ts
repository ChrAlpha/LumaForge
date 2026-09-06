import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { useCallback } from 'react'

import type { ImageSession } from '../model/session'
import { clearExportResultState } from '../services/export/export-state'
import type { UseRawWorkflowReturn } from './useRawWorkflow.types'

type UseRawPreviewTransformInput = {
  session: ImageSession | null
  sessionRef: MutableRefObject<ImageSession | null>
  setSession: Dispatch<SetStateAction<ImageSession | null>>
  invalidateExportGraph: () => void
}

export function useRawPreviewTransform({
  session,
  sessionRef,
  setSession,
  invalidateExportGraph,
}: UseRawPreviewTransformInput): NonNullable<
  UseRawWorkflowReturn['previewTransform']
> {
  const sourceId = session?.id ?? null
  const setActive = useCallback(
    (active: boolean) => {
      if (!sourceId || sessionRef.current?.id !== sourceId) return

      invalidateExportGraph()
      const update = (previous: ImageSession | null) =>
        previous?.id === sourceId
          ? {
              ...clearExportResultState(previous),
              previewTransformActive: active,
            }
          : previous
      sessionRef.current = update(sessionRef.current)
      setSession(update)
    },
    [invalidateExportGraph, sessionRef, setSession, sourceId],
  )

  return {
    sourceId,
    active: Boolean(session?.previewTransformActive),
    setActive,
  }
}
