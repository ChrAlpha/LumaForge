import { act, cleanup, renderHook } from '@testing-library/react'
import { Provider } from 'jotai'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { jotaiStore } from '~/lib/jotai'

import type { ImageSession } from '../model/session'
import { createImageSession } from '../model/session-factory'
import {
  currentSessionAtom,
  getCurrentSession,
  setCurrentSession,
} from '../state/session.atoms'
import { useImageSession } from './useImageSession'

function rawFile(name = 'frame.ARW'): File {
  return new File(['raw'], name)
}

const LOOK = { id: 'look' } as unknown as NonNullable<
  ImageSession['activeStyle']
>

function ProductionStore({ children }: { children: ReactNode }) {
  return <Provider store={jotaiStore}>{children}</Provider>
}

describe('useImageSession store binding', () => {
  beforeEach(() => {
    setCurrentSession(null)
  })

  afterEach(() => {
    // Unmount before the reset write, so the store change reaches no hook.
    cleanup()
    setCurrentSession(null)
  })

  it('writes the production store even without a Provider', () => {
    const { result } = renderHook(() => useImageSession())
    let created: ImageSession | null = null

    act(() => {
      created = result.current.replaceFile(rawFile())
      // Visible to an imperative read in the same tick, before any rerender.
      expect(getCurrentSession()).toBe(created)
      expect(jotaiStore.get(currentSessionAtom)).toBe(created)
    })

    expect(result.current.session).toBe(created)
  })

  it('observes the session the root providers mount', () => {
    const { result } = renderHook(() => useImageSession(), {
      wrapper: ProductionStore,
    })
    let created: ImageSession | null = null

    act(() => {
      created = result.current.replaceFile(rawFile())
    })

    expect(getCurrentSession()).toBe(created)
    expect(result.current.session).toBe(created)
  })

  it('renders an imperative write and its functional update', () => {
    const { result } = renderHook(() => useImageSession())
    let created: ImageSession | null = null

    act(() => {
      created = result.current.replaceFile(rawFile())
      setCurrentSession((prev) =>
        prev ? { ...prev, activeStyle: LOOK } : prev,
      )
      // The updater saw the session written a statement earlier.
      expect(getCurrentSession()).toMatchObject({
        id: created.id,
        activeStyle: LOOK,
      })
    })

    expect(result.current.session).toBe(getCurrentSession())
    expect(result.current.session?.activeStyle).toBe(LOOK)
  })

  it('applies a hook update on top of an imperative write in the same tick', () => {
    const { result } = renderHook(() => useImageSession())
    const { setSession, resetSession } = result.current
    const outside = createImageSession(rawFile('outside.ARW'))

    act(() => {
      setCurrentSession(outside)
      setSession((prev) => (prev ? { ...prev, activeStyle: LOOK } : prev))
    })

    expect(getCurrentSession()).toMatchObject({
      id: outside.id,
      activeStyle: LOOK,
    })
    expect(result.current.session).toBe(getCurrentSession())

    act(() => {
      resetSession()
      expect(getCurrentSession()).toBeNull()
    })
    expect(result.current.session).toBeNull()
  })
})
