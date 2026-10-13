import { useCallback } from 'react'

import type { ImageSession } from '../model/session'
import type { TransformEvent } from '../services/transform/transform-state'
import { transitionSessionTransform } from '../services/transform/transform-state'
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

/**
 * The session's Transform: its intent and accepted answers, and a dispatch
 * that applies one event to the session the store holds when it lands.
 */
export function useRawPreviewTransform({
  session,
  getSession,
  setSession,
  invalidateExportGraph,
}: UseRawPreviewTransformInput): {
  transform: NonNullable<UseRawWorkflowReturn['transform']>
} {
  // Each event reduces the session the store holds when it lands, so it never
  // acts on a source or Transform a newer write replaced. Invalidation runs
  // before the write; it touches only export state, which the transition
  // does not read, so the write reduces to the same Transform.
  const dispatch = useCallback(
    (event: TransformEvent) => {
      const live = getSession()
      if (!live || live.id !== event.sourceId) return
      const planned = transitionSessionTransform(live, event)
      if (!planned) return
      if (planned.invalidated) invalidateExportGraph()
      setSession((current) =>
        current?.id === event.sourceId
          ? (transitionSessionTransform(current, event)?.session ?? current)
          : current,
      )
    },
    [getSession, invalidateExportGraph, setSession],
  )

  return {
    transform: {
      state: session?.transform ?? null,
      dispatch,
    },
  }
}
