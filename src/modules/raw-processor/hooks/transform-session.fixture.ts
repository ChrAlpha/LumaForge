import type { ExportGeometry } from '@lumaforge/render-engine/export'
import { atom, createStore, useAtomValue } from 'jotai'
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
 * `useRawWorkflow` publishes them. The sessions live in a store whose writes
 * the next event reads in the same tick, before any rerender, as the
 * workflow's session store does. `onCommit` hears every move of the geometry
 * the export reproduces, synchronously, with the source it moved for; events
 * that leave it where it is are not commits.
 */
export function useTransformSessionFixture(
  sourceId: string,
  onCommit?: (sourceId: string, geometry: ExportGeometry | null) => void,
) {
  const [{ store, sessionsAtom }] = useState(() => ({
    store: createStore(),
    sessionsAtom: atom<Record<string, ImageSession>>({}),
  }))
  const sessions = useAtomValue(sessionsAtom, { store })
  const fresh = useMemo(() => fixtureSession(sourceId), [sourceId])
  const session = sessions[sourceId] ?? fresh
  // The source the ports address: the one this render shows.
  const currentRef = useRef({ sourceId, fresh })
  currentRef.current = { sourceId, fresh }
  const onCommitRef = useRef(onCommit)
  onCommitRef.current = onCommit
  // The geometry each source last published. The producer replaces it only
  // when it moves; an edit invalidates the export without moving it.
  const published = useRef<Record<string, ExportGeometry | null>>({})
  const invalidateExportGraph = useCallback(() => {}, [])
  const getSession = useCallback(() => {
    const current = currentRef.current
    return store.get(sessionsAtom)[current.sourceId] ?? current.fresh
  }, [sessionsAtom, store])
  const setSession = useCallback(
    (update: (session: ImageSession | null) => ImageSession | null) => {
      const previous = getSession()
      const next = update(previous)
      if (!next || next === previous) return
      store.set(sessionsAtom, (all) => ({ ...all, [next.id]: next }))
      const geometry = next.exportGeometry ?? null
      if ((published.current[next.id] ?? null) !== geometry) {
        published.current[next.id] = geometry
        onCommitRef.current?.(next.id, geometry)
      }
    },
    [getSession, sessionsAtom, store],
  )
  const ports = useRawPreviewTransform({
    session,
    getSession,
    setSession,
    invalidateExportGraph,
  })
  return { ...ports, geometry: session.exportGeometry ?? null }
}
