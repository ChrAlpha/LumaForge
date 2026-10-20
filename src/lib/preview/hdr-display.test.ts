import { afterEach, describe, expect, it, vi } from 'vitest'

import { isHdrDisplay, subscribeHdrDisplay } from './hdr-display'

function stubDisplay(matches: boolean) {
  const listeners = new Set<() => void>()
  const query = {
    matches,
    addEventListener: (_: string, listener: () => void) =>
      listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) =>
      listeners.delete(listener),
  }
  const matchMedia = vi.fn(() => query)
  vi.stubGlobal('matchMedia', matchMedia)
  return { query, listeners, matchMedia }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('hdr display', () => {
  it('reads the dynamic-range media feature', () => {
    const display = stubDisplay(true)
    expect(isHdrDisplay()).toBe(true)
    expect(display.matchMedia).toHaveBeenCalledWith('(dynamic-range: high)')
    display.query.matches = false
    expect(isHdrDisplay()).toBe(false)
  })

  it('tells a subscriber when the display changes, until it leaves', () => {
    const display = stubDisplay(false)
    const onChange = vi.fn()
    const unsubscribe = subscribeHdrDisplay(onChange)
    for (const listener of display.listeners) listener()
    expect(onChange).toHaveBeenCalledOnce()
    unsubscribe()
    expect(display.listeners.size).toBe(0)
  })

  it('answers SDR where the browser has no media queries', () => {
    vi.stubGlobal('matchMedia', undefined)
    expect(isHdrDisplay()).toBe(false)
    expect(() => subscribeHdrDisplay(vi.fn())()).not.toThrow()
  })
})
