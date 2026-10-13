import { act, cleanup, renderHook } from '@testing-library/react'
import { Provider } from 'jotai'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { jotaiStore } from '~/lib/jotai'

import type { ImageSession } from '../model/session'
import { createImageSession } from '../model/session-factory'
import {
  getCurrentSession,
  setCurrentSession,
  useCurrentSession,
} from './session.atoms'

const LOOK = { id: 'look' } as unknown as NonNullable<
  ImageSession['activeStyle']
>

function ProductionStore({ children }: { children: ReactNode }) {
  return <Provider store={jotaiStore}>{children}</Provider>
}

describe('the current session store binding', () => {
  beforeEach(() => {
    setCurrentSession(null)
  })

  afterEach(() => {
    // Unmount before the reset write, so the store change reaches no hook.
    cleanup()
    setCurrentSession(null)
  })

  it.each([
    ['without a Provider', undefined],
    ['under the root providers', ProductionStore],
  ])(
    'shows an imperative write in the same tick and renders it %s',
    (_, wrapper) => {
      const { result } = renderHook(() => useCurrentSession(), { wrapper })
      const created = createImageSession(new File(['raw'], 'frame.ARW'))

      act(() => {
        setCurrentSession(created)
        expect(getCurrentSession()).toBe(created)
      })

      expect(result.current[0]).toBe(created)
    },
  )

  it('applies an update on top of a write made earlier in the same tick', () => {
    const { result } = renderHook(() => useCurrentSession())
    const outside = createImageSession(new File(['raw'], 'outside.ARW'))

    act(() => {
      setCurrentSession(outside)
      result.current[1]((prev) =>
        prev ? { ...prev, activeStyle: LOOK } : prev,
      )
      expect(getCurrentSession()).toMatchObject({
        id: outside.id,
        activeStyle: LOOK,
      })
    })
    expect(result.current[0]).toBe(getCurrentSession())

    act(() => {
      setCurrentSession(null)
    })
    expect(result.current[0]).toBeNull()
  })
})
