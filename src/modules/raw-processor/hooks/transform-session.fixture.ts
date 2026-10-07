import type { ExportGeometry } from '@lumaforge/render-engine/export'
import { useCallback, useMemo, useRef, useState } from 'react'

import { NEUTRAL_TRANSFORM } from '~/lib/transform/transform-types'

import type { ImageSession } from '../model/session'
import {
  createImageSession,
  createTransformState,
} from '../model/session-factory'
import { useRawPreviewTransform } from './useRawPreviewTransform'
import type { UseRawWorkflowReturn } from './useRawWorkflow.types'

let fixtureRequests = 0

/**
 * Drive `port` through what the preview does for one edit: a non-neutral
 * intent, a frame captured for it, and the newest request on that frame
 * answered with `geometry`. The session accepts it when the export engine
 * can plan it on `frame`.
 */
export function acceptTransformGeometry(
  port: UseRawWorkflowReturn['transform'],
  geometry: ExportGeometry,
  frame = { width: 800, height: 600 },
) {
  const sourceId = port?.state?.sourceId
  if (!port || !sourceId) throw new Error('expected a Transform source')
  const requestId = ++fixtureRequests
  const captureKey = `fixture-frame-${requestId}`
  port.dispatch({
    type: 'edit',
    sourceId,
    intent: { manual: { ...NEUTRAL_TRANSFORM, rotate: requestId } },
  })
  port.dispatch({ type: 'capture', sourceId, captureKey })
  port.dispatch({
    type: 'request',
    sourceId,
    captureKey,
    requestId,
    geometry,
  })
  port.dispatch({
    type: 'rendered',
    sourceId,
    captureKey,
    requestId,
    geometry,
    frame,
  })
}

function fixtureSession(id: string): ImageSession {
  return {
    ...createImageSession(new File(['raw'], `${id}.nef`)),
    id,
    transform: createTransformState(id),
  }
}

/**
 * The workflow's Transform ports over one session per source id, as
 * `useRawWorkflow` publishes them. `onCommit` hears every move of the
 * geometry the export reproduces, synchronously, with the source it moved
 * for; events that leave it where it is are not commits.
 */
export function useTransformSessionFixture(
  sourceId: string,
  onCommit?: (sourceId: string, geometry: ExportGeometry | null) => void,
) {
  const [sessions, setSessions] = useState<Record<string, ImageSession>>({})
  const fresh = useMemo(() => fixtureSession(sourceId), [sourceId])
  const session = sessions[sourceId] ?? fresh
  const sessionRef = useRef<ImageSession | null>(session)
  sessionRef.current = session
  const onCommitRef = useRef(onCommit)
  onCommitRef.current = onCommit
  const moved = useRef(false)
  const invalidateExportGraph = useCallback(() => {
    moved.current = true
  }, [])
  // The producer writes the session ref before it publishes, so the ref
  // already holds what the update produces.
  const setSession = useCallback(() => {
    const next = sessionRef.current
    if (!next) return
    if (moved.current) {
      moved.current = false
      onCommitRef.current?.(next.id, next.exportGeometry ?? null)
    }
    setSessions((previous) => ({ ...previous, [next.id]: next }))
  }, [])
  const ports = useRawPreviewTransform({
    session,
    sessionRef,
    setSession,
    invalidateExportGraph,
  })
  return { ...ports, geometry: session.exportGeometry ?? null }
}
