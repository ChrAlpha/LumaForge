import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { useAdjustRowHandlers } from './useAdjustRowHandlers'

describe('useAdjustRowHandlers', () => {
  it('keeps each field its handlers across renders and calls the latest callbacks', () => {
    const first = { onChange: vi.fn(), onScrubChange: vi.fn() }
    const { result, rerender } = renderHook(
      (latest: typeof first) => useAdjustRowHandlers<'a' | 'b'>(latest),
      { initialProps: first },
    )
    const a = result.current('a')
    expect(result.current('a')).toBe(a)
    expect(result.current('b')).not.toBe(a)

    const second = { onChange: vi.fn(), onScrubChange: vi.fn() }
    rerender(second)
    expect(result.current('a')).toBe(a)

    a.onChange(0.4)
    a.onScrubChange(true)
    expect(first.onChange).not.toHaveBeenCalled()
    expect(second.onChange).toHaveBeenCalledWith('a', 0.4)
    expect(second.onScrubChange).toHaveBeenCalledWith('a', true)
  })
})
