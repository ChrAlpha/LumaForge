import { act, fireEvent, render, screen } from '@testing-library/react'
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'

import {
  getLensHintPlacement,
  LENS_HINT_STORAGE_KEY,
  MobileCompareLens,
} from './MobileCompareLens'
import { LONG_PRESS_MS } from './useMobilePreviewGestures'

function renderLens(
  overrides: Partial<React.ComponentProps<typeof MobileCompareLens>> = {},
) {
  const props = {
    splitOn: false,
    disabled: false,
    onToggle: vi.fn(),
    onPeekStart: vi.fn(),
    onPeekEnd: vi.fn(),
    ...overrides,
  }
  const utils = render(<MobileCompareLens {...props} />)
  return {
    ...utils,
    props,
    lens: screen.getByRole('button', { name: 'Split compare' }),
  }
}

function tap(el: HTMLElement) {
  fireEvent.pointerDown(el, { clientX: 10, clientY: 10 })
  fireEvent.pointerUp(el, { clientX: 10, clientY: 10 })
  fireEvent.click(el)
}

beforeAll(() => {
  // jsdom has no PointerEvent; a MouseEvent carries the coordinates.
  window.PointerEvent ??= MouseEvent as typeof PointerEvent
})

describe('mobileCompareLens', () => {
  beforeEach(() => {
    // Most cases are not about the first-run hint.
    localStorage.setItem(LENS_HINT_STORAGE_KEY, '1')
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    localStorage.clear()
  })

  it('toggles the split on tap and reflects it as a pressed state', () => {
    const { lens, props, rerender } = renderLens()
    expect(lens).toHaveAttribute('data-mobile-compare-lens')
    expect(lens).toHaveAttribute('data-state', 'off')
    expect(lens).toHaveAttribute('aria-pressed', 'false')
    expect(lens).toHaveClass('size-11')

    tap(lens)
    expect(props.onToggle).toHaveBeenCalledOnce()
    expect(props.onPeekStart).not.toHaveBeenCalled()

    rerender(<MobileCompareLens {...props} splitOn />)
    expect(lens).toHaveAttribute('data-state', 'on')
    expect(lens).toHaveAttribute('aria-pressed', 'true')
    const circle = lens.firstElementChild!
    expect(circle).toHaveClass(
      'bg-[oklch(0.96_0.006_255/0.9)]',
      'text-lf-surface',
    )
  })

  it('toggles from the keyboard', () => {
    const { lens, props } = renderLens()
    fireEvent.keyDown(lens, { key: 'Enter' })
    fireEvent.click(lens)
    expect(props.onToggle).toHaveBeenCalledOnce()
  })

  it('peeks the RAW while held and never toggles on release', () => {
    vi.useFakeTimers()
    const { lens, props } = renderLens()

    fireEvent.pointerDown(lens, { clientX: 10, clientY: 10 })
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS - 1)
    })
    expect(props.onPeekStart).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(props.onPeekStart).toHaveBeenCalledOnce()

    fireEvent.pointerUp(lens, { clientX: 10, clientY: 10 })
    fireEvent.click(lens)
    expect(props.onPeekEnd).toHaveBeenCalledOnce()
    expect(props.onToggle).not.toHaveBeenCalled()
  })

  it('ends a held peek on pointer cancel', () => {
    vi.useFakeTimers()
    const { lens, props } = renderLens()
    fireEvent.pointerDown(lens, { clientX: 10, clientY: 10 })
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS)
    })
    fireEvent.pointerCancel(lens)
    expect(props.onPeekEnd).toHaveBeenCalledOnce()
    expect(props.onToggle).not.toHaveBeenCalled()
  })

  it('keeps peeking while a held finger drifts off, and still ends on release', () => {
    vi.useFakeTimers()
    const { lens, props } = renderLens()
    fireEvent.pointerDown(lens, { clientX: 10, clientY: 10 })
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS)
    })
    fireEvent.pointerMove(lens, { clientX: 120, clientY: 90 })
    expect(props.onPeekEnd).not.toHaveBeenCalled()
    fireEvent.pointerUp(lens, { clientX: 120, clientY: 90 })
    expect(props.onPeekEnd).toHaveBeenCalledOnce()
  })

  it('treats a slide before the hold lands as neither tap nor peek', () => {
    vi.useFakeTimers()
    const { lens, props } = renderLens()
    fireEvent.pointerDown(lens, { clientX: 10, clientY: 10 })
    fireEvent.pointerMove(lens, { clientX: 40, clientY: 10 })
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS * 2)
    })
    fireEvent.pointerUp(lens, { clientX: 40, clientY: 10 })
    fireEvent.click(lens)
    expect(props.onPeekStart).not.toHaveBeenCalled()
    expect(props.onToggle).not.toHaveBeenCalled()
  })

  it('ends a peek if the lens unmounts mid-hold', () => {
    vi.useFakeTimers()
    const { lens, props, unmount } = renderLens()
    fireEvent.pointerDown(lens, { clientX: 10, clientY: 10 })
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS)
    })
    unmount()
    expect(props.onPeekEnd).toHaveBeenCalledOnce()
  })

  it('explains a Transform block on tap instead of comparing', () => {
    vi.useFakeTimers()
    const { lens, props } = renderLens({ disabled: true })
    expect(lens).toHaveAttribute('data-state', 'disabled')
    expect(lens).toHaveAttribute('aria-disabled', 'true')
    expect(lens).toBeEnabled()
    expect(lens.firstElementChild).toHaveClass('opacity-40')

    fireEvent.pointerDown(lens, { clientX: 10, clientY: 10 })
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS * 2)
    })
    expect(props.onPeekStart).not.toHaveBeenCalled()
    fireEvent.pointerUp(lens, { clientX: 10, clientY: 10 })
    fireEvent.click(lens)
    expect(props.onToggle).not.toHaveBeenCalled()

    const status = screen.getByRole('status')
    expect(status).toHaveTextContent(
      'Transform applied: compare is unavailable',
    )
    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(status).not.toHaveTextContent(/transform applied/i)
  })

  it('describes both gestures for assistive tech', () => {
    const { lens } = renderLens()
    expect(lens).toHaveAccessibleDescription(
      'Tap to split · hold to see the RAW',
    )
  })

  it('names both gestures once on first use, then remembers it', () => {
    vi.useFakeTimers()
    localStorage.clear()
    const { unmount } = renderLens()
    expect(
      document.querySelector('[data-mobile-compare-lens-hint="intro"]'),
    ).toHaveTextContent('Tap to split · hold to see the RAW')
    expect(localStorage.getItem(LENS_HINT_STORAGE_KEY)).toBe('1')
    act(() => {
      vi.advanceTimersByTime(4000)
    })
    expect(
      document.querySelector('[data-mobile-compare-lens-hint="intro"]'),
    ).toBeNull()
    unmount()

    renderLens()
    expect(
      document.querySelector('[data-mobile-compare-lens-hint="intro"]'),
    ).toBeNull()
  })

  it('drops the first-use hint on any pointer interaction', () => {
    localStorage.clear()
    renderLens()
    expect(
      document.querySelector('[data-mobile-compare-lens-hint="intro"]'),
    ).not.toBeNull()
    fireEvent.pointerDown(document.body)
    expect(
      document.querySelector('[data-mobile-compare-lens-hint="intro"]'),
    ).toBeNull()
  })

  it('survives storage that throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied')
    })
    expect(() => renderLens()).not.toThrow()
  })

  it('keeps a hint beside the lens while the photo has room, else below it', () => {
    // Unmeasured: the side, with the CSS cap doing the work.
    expect(getLensHintPlacement(0)).toBe('side')
    expect(getLensHintPlacement(393)).toBe('side')
    // 2:3 portrait in Adjust on a 393x660 phone.
    expect(getLensHintPlacement(226.7)).toBe('side')
    // 58px of lens column leaves under 150px beside it.
    expect(getLensHintPlacement(207)).toBe('below')
    expect(getLensHintPlacement(191)).toBe('below')
  })

  it('caps a side hint by the room left of the lens on the photo', () => {
    localStorage.clear()
    renderLens()
    const slot = document.querySelector('[data-mobile-compare-lens-hint-slot]')
    expect(slot).toHaveAttribute('data-mobile-compare-lens-hint-slot', 'side')
    expect(slot).toHaveClass('right-full')
    expect(
      document.querySelector('[data-mobile-compare-lens-hint="intro"]'),
    ).toHaveClass('max-w-[min(232px,calc(var(--raw-photo-width,100vw)-58px))]')
  })

  it('drops a hint below the lens, right-aligned to the circle, on a narrow photo', () => {
    const { lens } = renderLens({ disabled: true, hintPlacement: 'below' })
    tap(lens)
    const slot = document.querySelector('[data-mobile-compare-lens-hint-slot]')
    expect(slot).toHaveAttribute('data-mobile-compare-lens-hint-slot', 'below')
    expect(slot).toHaveClass('top-full', 'right-1.5')
    expect(
      document.querySelector('[data-mobile-compare-lens-hint="blocked"]'),
    ).toHaveClass('max-w-[min(232px,calc(var(--raw-photo-width,100vw)-16px))]')
  })
})
