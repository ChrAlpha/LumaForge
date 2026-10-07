import type { ExportGeometry } from '@lumaforge/render-engine/export'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { useCallback, useMemo } from 'react'

import type { ImageSession } from '../model/session'
import { createTransformState } from '../model/session-factory'
import { clearExportResultState } from '../services/export/export-state'
import type { TransformEvent } from '../services/transform/transform-state'
import {
  heldTransformGeometry,
  reduceTransformState,
} from '../services/transform/transform-state'
import type { UseRawWorkflowReturn } from './useRawWorkflow.types'

type UseRawPreviewTransformInput = {
  session: ImageSession | null
  sessionRef: MutableRefObject<ImageSession | null>
  setSession: Dispatch<SetStateAction<ImageSession | null>>
  invalidateExportGraph: () => void
}

function sameGeometry(a: ExportGeometry | null, b: ExportGeometry | null) {
  if (!a || !b) return a === b
  return (
    a.constrainCrop === b.constrainCrop &&
    a.matrix.length === b.matrix.length &&
    a.matrix.every((value, index) => value === b.matrix[index])
  )
}

/**
 * The session's Transform: its intent and accepted answers, and the geometry
 * the export reproduces, which is only ever the geometry that state holds.
 * Moving that geometry discards the export made without it; an event that
 * leaves it where it is keeps any delivered export.
 */
export function useRawPreviewTransform({
  session,
  sessionRef,
  setSession,
  invalidateExportGraph,
}: UseRawPreviewTransformInput): {
  previewTransform: NonNullable<UseRawWorkflowReturn['previewTransform']>
  transform: NonNullable<UseRawWorkflowReturn['transform']>
} {
  const sourceId = session?.id ?? null
  // A session built before it carried a Transform starts neutral.
  const neutral = useMemo(
    () => (sourceId ? createTransformState(sourceId) : null),
    [sourceId],
  )
  const dispatch = useCallback(
    (event: TransformEvent) => {
      const current = sessionRef.current
      if (!current || current.id !== event.sourceId) return
      const previous = current.transform ?? createTransformState(current.id)
      const transform = reduceTransformState(previous, event)
      if (transform === previous) return

      const geometry = heldTransformGeometry(transform)
      const moved = !sameGeometry(geometry, current.exportGeometry ?? null)
      if (moved) invalidateExportGraph()
      const update = (value: ImageSession | null) =>
        value?.id === current.id
          ? moved
            ? {
                ...clearExportResultState(value),
                transform,
                exportGeometry: geometry,
              }
            : { ...value, transform }
          : value
      sessionRef.current = update(sessionRef.current)
      setSession(update)
    },
    [invalidateExportGraph, sessionRef, setSession],
  )

  return {
    previewTransform: {
      sourceId,
      active: Boolean(session?.exportGeometry),
      geometry: session?.exportGeometry ?? null,
    },
    transform: {
      state: session?.transform ?? neutral,
      dispatch,
    },
  }
}
