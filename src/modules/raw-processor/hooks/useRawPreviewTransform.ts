import type { ExportGeometry } from '@lumaforge/render-engine/export'
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
  /** The session the store holds now, including writes not yet rendered. */
  getSession: () => ImageSession | null
  /**
   * Writes the session through `update`, which receives the latest session
   * and runs before this returns, as the workflow's session store does.
   */
  setSession: (
    update: (session: ImageSession | null) => ImageSession | null,
  ) => void
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
 * `session` after a Transform event, and whether the event discards what was
 * exported for the Transform before it. Null when the event changes nothing.
 */
function transitionTransform(
  session: ImageSession,
  event: TransformEvent,
): { session: ImageSession; invalidated: boolean } | null {
  const previous = session.transform ?? createTransformState(session.id)
  const reduced = reduceTransformState(previous, event)
  if (reduced === previous) return null

  const asked = !sameIntent(reduced.intent, previous.intent)
  // An event that asks for the same Transform keeps the intent object, so an
  // export admitted for that intent stays current; only a real edit or reset
  // makes a new one.
  const transform = asked ? reduced : { ...reduced, intent: previous.intent }
  const geometry = heldTransformGeometry(transform)
  const moved = !sameGeometry(geometry, session.exportGeometry ?? null)
  const invalidated = moved || asked
  return {
    invalidated,
    session: {
      ...(invalidated ? clearExportResultState(session) : session),
      transform,
      ...(moved ? { exportGeometry: geometry } : {}),
    },
  }
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
  getSession,
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
  // Each event reduces the session the store holds when it lands, so it never
  // acts on a source or Transform a newer write replaced. Invalidation runs
  // before the write; it touches only export state, which the transition
  // does not read, so the write reduces to the same Transform.
  const dispatch = useCallback(
    (event: TransformEvent) => {
      const live = getSession()
      if (!live || live.id !== event.sourceId) return
      const planned = transitionTransform(live, event)
      if (!planned) return
      if (planned.invalidated) invalidateExportGraph()
      setSession((current) =>
        current?.id === event.sourceId
          ? (transitionTransform(current, event)?.session ?? current)
          : current,
      )
    },
    [getSession, invalidateExportGraph, setSession],
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
