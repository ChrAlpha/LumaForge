import type { ExportGeometry } from '@lumaforge/render-engine/export'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { useCallback, useMemo } from 'react'

import type { ImageSession, TransformIntent } from '../model/session'
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

function sameIntent(a: TransformIntent, b: TransformIntent) {
  return (
    a.upright === b.upright &&
    a.constrainCrop === b.constrainCrop &&
    (Object.keys(a.manual) as Array<keyof TransformIntent['manual']>).every(
      (key) => a.manual[key] === b.manual[key],
    )
  )
}

/**
 * The session's Transform: its intent and accepted answers, and the geometry
 * the export reproduces, which is only ever the geometry that state holds.
 * Moving that geometry, or asking for another Transform, discards any export
 * made or running for the previous one at once, even while the held geometry
 * waits for the new answer. Events that ask for nothing new and leave the
 * geometry where it is, such as a request or a new frame answering the same
 * geometry, keep any delivered export.
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
      const reduced = reduceTransformState(previous, event)
      if (reduced === previous) return

      const asked = !sameIntent(reduced.intent, previous.intent)
      // An event that asks for the same Transform keeps the intent object,
      // so an export admitted for that intent stays current; only a real
      // edit or reset makes a new one.
      const transform = asked
        ? reduced
        : { ...reduced, intent: previous.intent }
      const geometry = heldTransformGeometry(transform)
      const moved = !sameGeometry(geometry, current.exportGeometry ?? null)
      const invalidated = moved || asked
      if (invalidated) invalidateExportGraph()
      const update = (value: ImageSession | null) =>
        value?.id === current.id
          ? {
              ...(invalidated ? clearExportResultState(value) : value),
              transform,
              ...(moved ? { exportGeometry: geometry } : {}),
            }
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
