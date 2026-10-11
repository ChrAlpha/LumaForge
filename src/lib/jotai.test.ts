import { act, renderHook } from '@testing-library/react'
import { atom } from 'jotai'
import { describe, expect, it } from 'vitest'

import { createAtomHooks, jotaiStore } from '~/lib/jotai'

describe('createAtomHooks', () => {
  it('binds every hook and accessor to the production store', () => {
    const [baseAtom, useState, useValue, useSet, get, set] = createAtomHooks(
      atom(1),
    )

    set(2)
    expect(get()).toBe(2)
    expect(jotaiStore.get(baseAtom)).toBe(2)

    const { result } = renderHook(() => ({
      state: useState(),
      value: useValue(),
      setValue: useSet(),
    }))
    expect(result.current.value).toBe(2)
    expect(result.current.state[0]).toBe(2)

    act(() => result.current.setValue(3))
    expect(jotaiStore.get(baseAtom)).toBe(3)
    expect(result.current.value).toBe(3)

    act(() => jotaiStore.set(baseAtom, 4))
    expect(result.current.state[0]).toBe(4)
    expect(get()).toBe(4)
  })
})
