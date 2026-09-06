import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Slider } from '~/components/ui/slider'

import { SCRUB_LOCK_SLOP_PX } from './slider-scrub-model'
import { useSliderScrub } from './useSliderScrub'

function Harness(props: {
  value: number
  onChange: (v: number) => void
  onScrubChange?: (s: boolean) => void
  onReset?: () => void
  onGainChange?: (g: string) => void
  disabled?: boolean
}) {
  const scrub = useSliderScrub({
    value: props.value,
    min: -100,
    max: 100,
    step: 1,
    disabled: props.disabled,
    onChange: props.onChange,
    onScrubChange: props.onScrubChange,
    onReset: props.onReset,
    onGainChange: props.onGainChange,
  })
  return (
    <div
      data-testid="row"
      data-scrubbing={scrub.scrubbing || undefined}
      {...scrub.bind}
    >
      <Slider
        thumbAriaLabel="Contrast"
        value={[props.value]}
        min={-100}
        max={100}
        step={1}
      />
    </div>
  )
}

function mockTrackRect(el: HTMLElement) {
  const track = el.querySelector('[data-slot="slider-track"]') as HTMLElement
  track.getBoundingClientRect = () =>
    ({
      left: 100,
      width: 200,
      top: 40,
      height: 20,
      right: 300,
      bottom: 60,
      x: 100,
      y: 40,
      toJSON: () => ({}),
    }) as DOMRect
}

const touch = (x: number, y: number) => ({
  pointerType: 'touch',
  pointerId: 7,
  isPrimary: true,
  button: 0,
  clientX: x,
  clientY: y,
})
const mouse = (x: number, y: number, extra: Record<string, unknown> = {}) => ({
  pointerType: 'mouse',
  pointerId: 1,
  isPrimary: true,
  button: 0,
  clientX: x,
  clientY: y,
  ...extra,
})

class PointerEventPolyfill extends MouseEvent {
  pointerType: string
  pointerId: number
  isPrimary: boolean
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init)
    this.pointerType = init.pointerType ?? ''
    this.pointerId = init.pointerId ?? 0
    this.isPrimary = init.isPrimary ?? true
  }
}

describe('useSliderScrub', () => {
  beforeEach(() => {
    // jsdom 26 ships no PointerEvent; without it RTL dispatches a bare Event
    // that carries no coordinates or pointerType.
    if (typeof window.PointerEvent === 'undefined') {
      vi.stubGlobal('PointerEvent', PointerEventPolyfill)
    }
    vi.stubGlobal(
      'ResizeObserver',
      vi.fn().mockImplementation(() => ({
        observe: vi.fn(),
        unobserve: vi.fn(),
        disconnect: vi.fn(),
      })),
    )
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('mouse: jumps on pointerdown, tracks moves, and reports one scrub lifecycle', () => {
    const onChange = vi.fn()
    const onScrubChange = vi.fn()
    render(
      <Harness value={0} onChange={onChange} onScrubChange={onScrubChange} />,
    )
    const row = screen.getByTestId('row')
    mockTrackRect(row)

    fireEvent.pointerDown(row, mouse(250, 50))
    expect(onScrubChange).toHaveBeenCalledTimes(1)
    expect(onScrubChange).toHaveBeenLastCalledWith(true)
    expect(onChange).toHaveBeenLastCalledWith(50)
    expect(row).toHaveAttribute('data-scrubbing')

    fireEvent.pointerMove(row, mouse(260, 50))
    expect(onChange).toHaveBeenLastCalledWith(60)

    fireEvent.pointerMove(row, mouse(270, 50, { shiftKey: true }))
    expect(onChange).toHaveBeenLastCalledWith(61)

    fireEvent.pointerUp(row, mouse(270, 50))
    expect(onScrubChange).toHaveBeenCalledTimes(2)
    expect(onScrubChange).toHaveBeenLastCalledWith(false)
    expect(row).not.toHaveAttribute('data-scrubbing')
  })

  it('touch: a mostly vertical move abandons the gesture without changing the value', () => {
    const onChange = vi.fn()
    const onScrubChange = vi.fn()
    render(
      <Harness value={20} onChange={onChange} onScrubChange={onScrubChange} />,
    )
    const row = screen.getByTestId('row')
    mockTrackRect(row)

    fireEvent.pointerDown(row, touch(200, 50))
    expect(onScrubChange).not.toHaveBeenCalled()
    fireEvent.pointerMove(row, touch(201, 50 + SCRUB_LOCK_SLOP_PX + 6))
    fireEvent.pointerMove(row, touch(240, 120))
    fireEvent.pointerUp(row, touch(240, 120))
    expect(onChange).not.toHaveBeenCalled()
    expect(onScrubChange).not.toHaveBeenCalled()
  })

  it('touch: a tap sets the value at the tap point without a scrub lifecycle', () => {
    const onChange = vi.fn()
    const onScrubChange = vi.fn()
    render(
      <Harness value={20} onChange={onChange} onScrubChange={onScrubChange} />,
    )
    const row = screen.getByTestId('row')
    mockTrackRect(row)

    fireEvent.pointerDown(row, touch(150, 50))
    fireEvent.pointerUp(row, touch(150, 50))
    expect(onChange).toHaveBeenCalledWith(-50)
    expect(onScrubChange).not.toHaveBeenCalled()
  })

  it('touch: horizontal travel locks, scrubs, and reports gain bands', () => {
    const onChange = vi.fn()
    const onScrubChange = vi.fn()
    const onGainChange = vi.fn()
    render(
      <Harness
        value={0}
        onChange={onChange}
        onScrubChange={onScrubChange}
        onGainChange={onGainChange}
      />,
    )
    const row = screen.getByTestId('row')
    mockTrackRect(row)

    fireEvent.pointerDown(row, touch(200, 50))
    fireEvent.pointerMove(row, touch(210, 50))
    expect(onScrubChange).toHaveBeenCalledTimes(1)
    expect(onScrubChange).toHaveBeenLastCalledWith(true)
    expect(onChange).toHaveBeenLastCalledWith(10)

    fireEvent.pointerMove(row, touch(210, 150))
    fireEvent.pointerMove(row, touch(250, 150))
    expect(onGainChange).toHaveBeenLastCalledWith('quarter')
    expect(onChange).toHaveBeenLastCalledWith(20)

    fireEvent.pointerUp(row, touch(250, 150))
    expect(onScrubChange).toHaveBeenLastCalledWith(false)
    expect(onGainChange).toHaveBeenLastCalledWith('full')
  })

  it('pointercancel ends an active scrub', () => {
    const onScrubChange = vi.fn()
    render(
      <Harness value={0} onChange={vi.fn()} onScrubChange={onScrubChange} />,
    )
    const row = screen.getByTestId('row')
    mockTrackRect(row)
    fireEvent.pointerDown(row, mouse(220, 50))
    fireEvent.pointerCancel(row, mouse(220, 50))
    expect(onScrubChange).toHaveBeenLastCalledWith(false)
  })

  it('double click resets the field', () => {
    const onReset = vi.fn()
    render(<Harness value={12} onChange={vi.fn()} onReset={onReset} />)
    fireEvent.doubleClick(screen.getByTestId('row'))
    expect(onReset).toHaveBeenCalledTimes(1)
  })

  it('ignores every pointer while disabled', () => {
    const onChange = vi.fn()
    const onScrubChange = vi.fn()
    render(
      <Harness
        value={0}
        disabled
        onChange={onChange}
        onScrubChange={onScrubChange}
      />,
    )
    const row = screen.getByTestId('row')
    mockTrackRect(row)
    fireEvent.pointerDown(row, mouse(250, 50))
    fireEvent.pointerUp(row, mouse(250, 50))
    expect(onChange).not.toHaveBeenCalled()
    expect(onScrubChange).not.toHaveBeenCalled()
  })
})

describe('useSliderScrub vertical scroll forwarding', () => {
  beforeEach(() => {
    if (typeof window.PointerEvent === 'undefined') {
      vi.stubGlobal('PointerEvent', PointerEventPolyfill)
    }
    vi.stubGlobal(
      'ResizeObserver',
      vi.fn().mockImplementation(() => ({
        observe: vi.fn(),
        unobserve: vi.fn(),
        disconnect: vi.fn(),
      })),
    )
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function renderInScroller(onChange = vi.fn()) {
    const { container } = render(
      <div
        data-testid="scroller"
        style={{ overflowY: 'auto', height: '100px' }}
      >
        <Harness value={0} onChange={onChange} />
      </div>,
    )
    const scroller = screen.getByTestId('scroller')
    Object.defineProperty(scroller, 'scrollHeight', {
      configurable: true,
      value: 400,
    })
    Object.defineProperty(scroller, 'clientHeight', {
      configurable: true,
      value: 100,
    })
    let scrollTop = 40
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (v: number) => {
        scrollTop = v
      },
    })
    const row = screen.getByTestId('row')
    mockTrackRect(row)
    void container
    return { scroller, row, onChange }
  }

  it('drives the surrounding scroll container when a touch drag goes vertical', () => {
    const { scroller, row, onChange } = renderInScroller()
    fireEvent.pointerDown(row, touch(200, 50))
    fireEvent.pointerMove(row, touch(201, 90))
    fireEvent.pointerMove(row, touch(201, 110))
    expect(scroller.scrollTop).toBe(40 - (110 - 90))
    fireEvent.pointerUp(row, touch(201, 110))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('leaves the scroll container alone once the scrub locks horizontally', () => {
    const { scroller, row, onChange } = renderInScroller()
    fireEvent.pointerDown(row, touch(200, 50))
    fireEvent.pointerMove(row, touch(212, 50))
    fireEvent.pointerMove(row, touch(212, 140))
    expect(scroller.scrollTop).toBe(40)
    expect(onChange).toHaveBeenLastCalledWith(12)
    fireEvent.pointerUp(row, touch(212, 140))
  })
})
