import { act, renderHook } from '@testing-library/react'
import { atom, createStore, useAtomValue } from 'jotai'
import { describe, expect, it, vi } from 'vitest'

import { NEUTRAL_TRANSFORM } from '~/lib/transform/transform-types'

import type { ImageSession } from '../model/session'
import { clearExportResultState } from '../services/export/export-state'
import type { TransformEvent } from '../services/transform/transform-state'
import { createTestSession } from '../test-support/builders'
import { useRawPreviewTransform } from './useRawPreviewTransform'

const rotate = (sourceId: string, degrees: number): TransformEvent => ({
  type: 'edit',
  sourceId,
  intent: { manual: { ...NEUTRAL_TRANSFORM, rotate: degrees } },
})

/**
 * The hook over a store whose writes the next read sees in the same tick,
 * before any rerender, as the workflow's session store does. Invalidation
 * records the session the store held when it ran, then clears the export
 * the way the workflow's does.
 */
function setup(initial: ImageSession | null = createTestSession()) {
  const store = createStore()
  const sessionAtom = atom<ImageSession | null>(initial)
  const getSession = () => store.get(sessionAtom)
  const setSession = (
    update: (session: ImageSession | null) => ImageSession | null,
  ) => store.set(sessionAtom, update)
  const invalidatedOn: Array<ImageSession | null> = []
  const invalidateExportGraph = vi.fn(() => {
    invalidatedOn.push(getSession())
    setSession(clearExportResultState)
  })
  const hook = renderHook(() =>
    useRawPreviewTransform({
      session: useAtomValue(sessionAtom, { store }),
      getSession,
      setSession,
      invalidateExportGraph,
    }),
  )
  return {
    ...hook,
    getSession,
    setSession,
    invalidateExportGraph,
    invalidatedOn,
  }
}

describe('useRawPreviewTransform', () => {
  it("publishes the stored session's Transform, and none without a source", () => {
    const session = createTestSession()
    expect(setup(session).result.current.transform.state).toBe(
      session.transform,
    )

    const empty = setup(null)
    act(() =>
      empty.result.current.transform.dispatch({
        type: 'reset',
        sourceId: 'none',
      }),
    )
    expect(empty.result.current.transform.state).toBeNull()
    expect(empty.getSession()).toBeNull()
    expect(empty.invalidateExportGraph).not.toHaveBeenCalled()
  })

  it('invalidates the export graph before it writes, and only for an event that discards the export', () => {
    const harness = setup(
      createTestSession({ exportState: { status: 'exporting' } }),
    )
    const before = harness.getSession()

    act(() => harness.result.current.transform.dispatch(rotate('session-1', 5)))

    // Invalidation still sees the running export, so it can settle it.
    expect(harness.invalidatedOn).toHaveLength(1)
    expect(harness.invalidatedOn[0]).toBe(before)
    const edited = harness.getSession()!
    expect(edited.exportState.status).toBe('idle')
    expect(edited.transform.intent.manual.rotate).toBe(5)
    expect(harness.result.current.transform.state).toBe(edited.transform)

    // The same intent again moves nothing, so nothing is written.
    act(() => harness.result.current.transform.dispatch(rotate('session-1', 5)))
    expect(harness.invalidateExportGraph).toHaveBeenCalledOnce()
    expect(harness.getSession()).toBe(edited)
  })

  it('applies an event to the session the store holds when it lands, keeping the writes around it', () => {
    const harness = setup()
    const replacement = createTestSession({ id: 'session-2' })

    act(() => {
      // Writes the rendered session does not show yet.
      harness.setSession(() => replacement)
      harness.setSession(
        (previous) =>
          previous && {
            ...previous,
            viewState: { ...previous.viewState, mode: 'processed' },
          },
      )
      harness.result.current.transform.dispatch(rotate('session-2', 4))
      harness.setSession(
        (previous) =>
          previous && {
            ...previous,
            viewState: { ...previous.viewState, compareSplit: 0.25 },
          },
      )
      expect(harness.getSession()?.transform.intent.manual.rotate).toBe(4)
    })

    expect(harness.getSession()).toMatchObject({
      id: 'session-2',
      viewState: { mode: 'processed', compareSplit: 0.25 },
    })
    expect(harness.result.current.transform.state).toBe(
      harness.getSession()?.transform,
    )
  })

  it('changes nothing for an event addressed to a source the store replaced', () => {
    const harness = setup()
    const { dispatch } = harness.result.current.transform
    const replacement = createTestSession({
      id: 'session-2',
      exportState: { status: 'ready' },
    })

    act(() => {
      harness.setSession(() => replacement)
      // Late events still addressed to the first source.
      dispatch(rotate('session-1', 4))
      dispatch({ type: 'reset', sourceId: 'session-1' })
    })

    expect(harness.getSession()).toBe(replacement)
    expect(harness.result.current.transform.state).toBe(replacement.transform)
    expect(harness.invalidateExportGraph).not.toHaveBeenCalled()
  })
})
