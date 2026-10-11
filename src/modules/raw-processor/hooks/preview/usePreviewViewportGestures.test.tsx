import { act, fireEvent, render } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PreviewViewport } from '../../services/preview/preview-viewport'
import {
  DEFAULT_PREVIEW_VIEWPORT,
  normalizePreviewViewport,
} from '../../services/preview/preview-viewport'
import { usePreviewViewportGestures } from './usePreviewViewportGestures'

/** jsdom's MouseEvent stand-in for PointerEvent, carrying the pointer id. */
class TestPointerEvent extends MouseEvent {
  readonly pointerId: number

  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init)
    this.pointerId = init.pointerId ?? 0
  }
}

function rect(left: number, top: number, width: number, height: number) {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect
}

function captureAnimationFrames() {
  const callbacks = new Map<number, FrameRequestCallback>()
  let nextId = 0
  const request = vi
    .spyOn(window, 'requestAnimationFrame')
    .mockImplementation((callback) => {
      nextId += 1
      callbacks.set(nextId, callback)
      return nextId
    })
  const cancel = vi
    .spyOn(window, 'cancelAnimationFrame')
    .mockImplementation((id) => {
      callbacks.delete(id)
    })

  return {
    request,
    cancel,
    lastId: () => nextId,
    pending: () => callbacks.size,
    run: () => {
      const pending = [...callbacks.values()]
      callbacks.clear()
      for (const callback of pending) callback(performance.now())
    },
  }
}

interface HarnessProps {
  viewport: PreviewViewport
  enabled?: boolean
  onViewportChange?: (viewport: PreviewViewport) => void
}

function Harness({ viewport, enabled = true, onViewportChange }: HarnessProps) {
  const frameRef = useRef<HTMLDivElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const { isPointerPanning, isWheelInteracting, frameHandlers } =
    usePreviewViewportGestures({
      frameRef,
      trackRef,
      viewport,
      enabled,
      onViewportChange,
    })

  return (
    <div
      ref={frameRef}
      data-testid="frame"
      data-panning={isPointerPanning ? 'true' : 'false'}
      data-wheeling={isWheelInteracting ? 'true' : 'false'}
      {...frameHandlers}
    >
      <div ref={trackRef} data-testid="track" />
    </div>
  )
}

/** A 400x300 frame at (100, 50) holding a 400x300 track. */
function renderGestures(props: HarnessProps) {
  const result = render(<Harness {...props} />)
  const frame = result.getByTestId('frame')
  const track = result.getByTestId('track')
  vi.spyOn(frame, 'getBoundingClientRect').mockReturnValue(
    rect(100, 50, 400, 300),
  )
  vi.spyOn(track, 'getBoundingClientRect').mockReturnValue(
    rect(100, 50, 400, 300),
  )
  return { ...result, frame, track }
}

describe('usePreviewViewportGestures', () => {
  let frames: ReturnType<typeof captureAnimationFrames>

  beforeEach(() => {
    vi.stubGlobal('PointerEvent', TestPointerEvent)
    HTMLElement.prototype.setPointerCapture = vi.fn()
    HTMLElement.prototype.releasePointerCapture = vi.fn()
    frames = captureAnimationFrames()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('zooms the wheel around its offset from the frame center', () => {
    const onViewportChange = vi.fn()
    const { frame } = renderGestures({
      viewport: DEFAULT_PREVIEW_VIEWPORT,
      onViewportChange,
    })

    // (400, 200) in client space is (+100, 0) from the frame center.
    const notPrevented = fireEvent.wheel(frame, {
      clientX: 400,
      clientY: 200,
      deltaY: -150,
      deltaMode: 0,
    })
    expect(notPrevented).toBe(false)
    expect(onViewportChange).not.toHaveBeenCalled()
    frames.run()

    const next = onViewportChange.mock.calls[0]?.[0]
    expect(next?.zoom).toBeCloseTo(1.5)
    expect(next?.panX).toBeCloseTo(-50)
    expect(next?.panY).toBeCloseTo(0)
    expect(next?.fitMode).toBe('custom')
  })

  it('listens to the wheel without a passive listener and stops on unmount', () => {
    const add = vi.spyOn(HTMLElement.prototype, 'addEventListener')
    const remove = vi.spyOn(HTMLElement.prototype, 'removeEventListener')
    const { frame, unmount } = renderGestures({
      viewport: DEFAULT_PREVIEW_VIEWPORT,
    })

    const wheelAdds = add.mock.calls.filter(
      ([type], index) => type === 'wheel' && add.mock.contexts[index] === frame,
    )
    expect(wheelAdds).toHaveLength(1)
    expect(wheelAdds[0]?.[2]).toEqual({ passive: false })

    unmount()
    expect(remove).toHaveBeenCalledWith('wheel', wheelAdds[0]?.[1])
  })

  it('clamps a pan at the edge of the zoomed track', () => {
    const onViewportChange = vi.fn()
    const viewport = normalizePreviewViewport({
      zoom: 2,
      panX: 180,
      panY: 0,
      fitMode: 'custom',
    })
    const { frame } = renderGestures({ viewport, onViewportChange })

    fireEvent.pointerDown(frame, {
      pointerId: 1,
      button: 0,
      clientX: 300,
      clientY: 200,
    })
    fireEvent.pointerMove(frame, {
      pointerId: 1,
      clientX: 360,
      clientY: 400,
    })
    frames.run()

    expect(onViewportChange).toHaveBeenLastCalledWith({
      zoom: 2,
      panX: 200,
      panY: 150,
      fitMode: 'custom',
    })
  })

  it('does not pan the fitted photo', () => {
    const onViewportChange = vi.fn()
    const { frame } = renderGestures({
      viewport: DEFAULT_PREVIEW_VIEWPORT,
      onViewportChange,
    })

    fireEvent.pointerDown(frame, {
      pointerId: 1,
      button: 0,
      clientX: 300,
      clientY: 200,
    })
    fireEvent.pointerMove(frame, {
      pointerId: 1,
      clientX: 340,
      clientY: 200,
    })
    fireEvent.pointerUp(frame, { pointerId: 1 })

    expect(frames.request).not.toHaveBeenCalled()
    expect(onViewportChange).not.toHaveBeenCalled()
    expect(frame).toHaveAttribute('data-panning', 'false')
  })

  it('moves from one pointer to a pinch and back to a pan', () => {
    const onViewportChange = vi.fn()
    const { frame } = renderGestures({
      viewport: DEFAULT_PREVIEW_VIEWPORT,
      onViewportChange,
    })

    fireEvent.pointerDown(frame, {
      pointerId: 1,
      button: 0,
      clientX: 300,
      clientY: 200,
    })
    expect(frame).toHaveAttribute('data-panning', 'true')
    fireEvent.pointerDown(frame, {
      pointerId: 2,
      button: 0,
      clientX: 400,
      clientY: 200,
    })
    // Midpoint (350, 200) is (+50, 0) from the center; distance 100 -> 200.
    fireEvent.pointerMove(frame, {
      pointerId: 2,
      clientX: 500,
      clientY: 200,
    })
    frames.run()
    const pinched = onViewportChange.mock.calls.at(-1)?.[0]
    expect(pinched?.zoom).toBeCloseTo(2)
    expect(pinched?.panX).toBeCloseTo(-50)

    fireEvent.pointerUp(frame, { pointerId: 1 })
    expect(HTMLElement.prototype.releasePointerCapture).toHaveBeenCalledWith(1)
    expect(frame).toHaveAttribute('data-panning', 'true')

    fireEvent.pointerMove(frame, {
      pointerId: 2,
      clientX: 520,
      clientY: 190,
    })
    fireEvent.pointerUp(frame, { pointerId: 2 })

    expect(frames.cancel).toHaveBeenCalledWith(frames.lastId())
    const panned = onViewportChange.mock.calls.at(-1)?.[0]
    expect(panned?.zoom).toBeCloseTo(2)
    expect(panned?.panX).toBeCloseTo(-30)
    expect(panned?.panY).toBeCloseTo(-10)
    expect(frame).toHaveAttribute('data-panning', 'false')
  })

  it('treats a cancelled pointer as a release', () => {
    const onViewportChange = vi.fn()
    const viewport = normalizePreviewViewport({
      zoom: 2,
      panX: 0,
      panY: 0,
      fitMode: 'custom',
    })
    const { frame } = renderGestures({ viewport, onViewportChange })

    fireEvent.pointerDown(frame, {
      pointerId: 3,
      button: 0,
      clientX: 300,
      clientY: 200,
    })
    fireEvent.pointerMove(frame, {
      pointerId: 3,
      clientX: 320,
      clientY: 210,
    })
    fireEvent.pointerCancel(frame, { pointerId: 3 })

    expect(frames.pending()).toBe(0)
    expect(onViewportChange).toHaveBeenCalledTimes(1)
    expect(onViewportChange).toHaveBeenLastCalledWith({
      zoom: 2,
      panX: 20,
      panY: 10,
      fitMode: 'custom',
    })
    expect(HTMLElement.prototype.releasePointerCapture).toHaveBeenCalledWith(3)
    expect(frame).toHaveAttribute('data-panning', 'false')
  })

  it('ends a pointer whose capture is lost without a cancel', () => {
    const onViewportChange = vi.fn()
    const viewport = normalizePreviewViewport({
      zoom: 2,
      panX: 0,
      panY: 0,
      fitMode: 'custom',
    })
    const { frame } = renderGestures({ viewport, onViewportChange })

    fireEvent.pointerDown(frame, {
      pointerId: 5,
      button: 0,
      clientX: 300,
      clientY: 200,
    })
    fireEvent.pointerMove(frame, {
      pointerId: 5,
      clientX: 320,
      clientY: 210,
    })
    fireEvent.lostPointerCapture(frame, { pointerId: 5 })

    expect(frames.pending()).toBe(0)
    expect(onViewportChange).toHaveBeenCalledTimes(1)
    expect(onViewportChange).toHaveBeenLastCalledWith({
      zoom: 2,
      panX: 20,
      panY: 10,
      fitMode: 'custom',
    })
    expect(frame).toHaveAttribute('data-panning', 'false')

    fireEvent.pointerMove(frame, {
      pointerId: 5,
      clientX: 360,
      clientY: 210,
    })
    fireEvent.pointerUp(frame, { pointerId: 5 })
    expect(frames.request).toHaveBeenCalledTimes(1)
    expect(onViewportChange).toHaveBeenCalledTimes(1)
  })

  it('ends a held gesture and drops its uncommitted move when disabled', () => {
    const onViewportChange = vi.fn()
    const viewport = normalizePreviewViewport({
      zoom: 2,
      panX: 0,
      panY: 0,
      fitMode: 'custom',
    })
    const { frame, rerender } = renderGestures({ viewport, onViewportChange })

    fireEvent.pointerDown(frame, {
      pointerId: 1,
      button: 0,
      clientX: 300,
      clientY: 200,
    })
    fireEvent.pointerMove(frame, {
      pointerId: 1,
      clientX: 320,
      clientY: 200,
    })
    expect(frames.pending()).toBe(1)

    rerender(
      <Harness
        viewport={viewport}
        enabled={false}
        onViewportChange={onViewportChange}
      />,
    )

    expect(frames.pending()).toBe(0)
    expect(HTMLElement.prototype.releasePointerCapture).toHaveBeenCalledWith(1)
    expect(frame).toHaveAttribute('data-panning', 'false')
    frames.run()
    expect(onViewportChange).not.toHaveBeenCalled()

    rerender(
      <Harness
        viewport={viewport}
        enabled
        onViewportChange={onViewportChange}
      />,
    )
    fireEvent.pointerMove(frame, {
      pointerId: 1,
      clientX: 340,
      clientY: 200,
    })
    expect(frames.pending()).toBe(0)
    expect(frame).toHaveAttribute('data-panning', 'false')
  })

  it('rebuilds on the shown viewport after disable drops an uncommitted gesture', () => {
    const onViewportChange = vi.fn()
    const viewport = normalizePreviewViewport({
      zoom: 2,
      panX: 0,
      panY: 0,
      fitMode: 'custom',
    })
    const { frame, rerender } = renderGestures({ viewport, onViewportChange })

    fireEvent.pointerDown(frame, {
      pointerId: 1,
      button: 0,
      clientX: 300,
      clientY: 200,
    })
    fireEvent.pointerMove(frame, {
      pointerId: 1,
      clientX: 320,
      clientY: 200,
    })
    fireEvent.wheel(frame, { clientX: 300, clientY: 200, deltaY: -30 })
    rerender(
      <Harness
        viewport={viewport}
        enabled={false}
        onViewportChange={onViewportChange}
      />,
    )
    rerender(
      <Harness
        viewport={normalizePreviewViewport({ ...viewport })}
        enabled
        onViewportChange={onViewportChange}
      />,
    )
    frames.run()
    expect(onViewportChange).not.toHaveBeenCalled()

    fireEvent.pointerDown(frame, {
      pointerId: 2,
      button: 0,
      clientX: 300,
      clientY: 200,
    })
    fireEvent.pointerMove(frame, {
      pointerId: 2,
      clientX: 310,
      clientY: 200,
    })
    fireEvent.pointerUp(frame, { pointerId: 2 })
    expect(onViewportChange).toHaveBeenLastCalledWith({
      zoom: 2,
      panX: 10,
      panY: 0,
      fitMode: 'custom',
    })

    // The pan was delivered: the next wheel builds on it, not on the dropped
    // drag or the dropped wheel.
    fireEvent.wheel(frame, { clientX: 300, clientY: 200, deltaY: -30 })
    frames.run()
    const zoomed = onViewportChange.mock.calls[1]?.[0] as PreviewViewport
    expect(onViewportChange).toHaveBeenCalledTimes(2)
    expect(zoomed.zoom).toBeCloseTo(2 * 1.1)
    expect(zoomed.panX).toBeCloseTo(10 * 1.1)
    expect(zoomed.panY).toBeCloseTo(0)
  })

  it('keeps a delivered commit as the base when disable drops a later move', () => {
    const onViewportChange = vi.fn()
    const viewport = normalizePreviewViewport({
      zoom: 2,
      panX: 0,
      panY: 0,
      fitMode: 'custom',
    })
    const { frame, rerender } = renderGestures({ viewport, onViewportChange })

    fireEvent.wheel(frame, { clientX: 300, clientY: 200, deltaY: -30 })
    frames.run()
    expect(onViewportChange.mock.calls[0]?.[0].zoom).toBeCloseTo(2 * 1.1)

    fireEvent.wheel(frame, { clientX: 300, clientY: 200, deltaY: -30 })
    rerender(
      <Harness
        viewport={viewport}
        enabled={false}
        onViewportChange={onViewportChange}
      />,
    )
    rerender(
      <Harness
        viewport={viewport}
        enabled
        onViewportChange={onViewportChange}
      />,
    )
    frames.run()
    expect(onViewportChange).toHaveBeenCalledTimes(1)

    // The parent has not rendered the delivered zoom yet; it stays the base.
    fireEvent.wheel(frame, { clientX: 300, clientY: 200, deltaY: -30 })
    frames.run()
    expect(onViewportChange).toHaveBeenCalledTimes(2)
    expect(onViewportChange.mock.calls[1]?.[0].zoom).toBeCloseTo(2 * 1.1 ** 2)
  })

  it('still releases a gesture that outlives its interaction', () => {
    const onViewportChange = vi.fn()
    const viewport = normalizePreviewViewport({
      zoom: 2,
      panX: 0,
      panY: 0,
      fitMode: 'custom',
    })
    const { frame, rerender } = renderGestures({ viewport, onViewportChange })

    fireEvent.pointerDown(frame, {
      pointerId: 1,
      button: 0,
      clientX: 300,
      clientY: 200,
    })
    rerender(
      <Harness
        viewport={viewport}
        enabled={false}
        onViewportChange={onViewportChange}
      />,
    )
    expect(HTMLElement.prototype.releasePointerCapture).toHaveBeenCalledWith(1)
    expect(frame).toHaveAttribute('data-panning', 'false')
    fireEvent.pointerMove(frame, {
      pointerId: 1,
      clientX: 340,
      clientY: 200,
    })
    expect(frames.request).not.toHaveBeenCalled()

    fireEvent.pointerUp(frame, { pointerId: 1 })
    expect(frame).toHaveAttribute('data-panning', 'false')
    expect(onViewportChange).not.toHaveBeenCalled()

    const notPrevented = fireEvent.wheel(frame, {
      clientX: 300,
      clientY: 200,
      deltaY: -150,
    })
    fireEvent.doubleClick(frame)
    expect(notPrevented).toBe(true)
    expect(onViewportChange).not.toHaveBeenCalled()
  })

  it('batches wheel events into one frame and idles the wheel transform', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const onViewportChange = vi.fn()
    const { frame } = renderGestures({
      viewport: DEFAULT_PREVIEW_VIEWPORT,
      onViewportChange,
    })

    for (let index = 0; index < 3; index += 1) {
      fireEvent.wheel(frame, { clientX: 300, clientY: 200, deltaY: -30 })
    }

    expect(frames.request).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(1)
    expect(frame).toHaveAttribute('data-wheeling', 'true')
    frames.run()
    expect(onViewportChange).toHaveBeenCalledTimes(1)
    expect(onViewportChange.mock.calls[0]?.[0].zoom).toBeCloseTo(1.1 ** 3)

    act(() => vi.advanceTimersByTime(179))
    expect(frame).toHaveAttribute('data-wheeling', 'true')
    act(() => vi.advanceTimersByTime(1))
    expect(frame).toHaveAttribute('data-wheeling', 'false')
  })

  it('keeps zoomed wheel accumulation across renders of an equal viewport', () => {
    const onViewportChange = vi.fn()
    const zoomed = { zoom: 2, panX: 0, panY: 0, fitMode: 'custom' } as const
    const { frame, rerender } = renderGestures({
      viewport: normalizePreviewViewport(zoomed),
      onViewportChange,
    })

    fireEvent.wheel(frame, { clientX: 300, clientY: 200, deltaY: -30 })
    // The parent normalizes again on every render: same value, new object.
    rerender(
      <Harness
        viewport={normalizePreviewViewport(zoomed)}
        onViewportChange={onViewportChange}
      />,
    )
    fireEvent.wheel(frame, { clientX: 300, clientY: 200, deltaY: -30 })
    frames.run()

    expect(frames.request).toHaveBeenCalledTimes(1)
    expect(onViewportChange).toHaveBeenCalledTimes(1)
    expect(onViewportChange.mock.calls[0]?.[0].zoom).toBeCloseTo(2 * 1.1 ** 2)
  })

  it('keeps accumulating when a committed viewport echoes back late', () => {
    const onViewportChange = vi.fn()
    const viewport = normalizePreviewViewport({
      zoom: 2,
      panX: 0,
      panY: 0,
      fitMode: 'custom',
    })
    const { frame, rerender } = renderGestures({ viewport, onViewportChange })

    fireEvent.wheel(frame, { clientX: 300, clientY: 200, deltaY: -30 })
    frames.run()
    const committed = onViewportChange.mock.calls[0]?.[0] as PreviewViewport
    fireEvent.wheel(frame, { clientX: 300, clientY: 200, deltaY: -30 })
    rerender(
      <Harness
        viewport={normalizePreviewViewport({ ...committed })}
        onViewportChange={onViewportChange}
      />,
    )
    fireEvent.wheel(frame, { clientX: 300, clientY: 200, deltaY: -30 })
    frames.run()

    expect(onViewportChange).toHaveBeenCalledTimes(2)
    expect(onViewportChange.mock.calls[1]?.[0].zoom).toBeCloseTo(2 * 1.1 ** 3)
  })

  it('lets a genuine external viewport change supersede an in-flight wheel', () => {
    const onViewportChange = vi.fn()
    const { frame, rerender } = renderGestures({
      viewport: normalizePreviewViewport({
        zoom: 2,
        panX: 0,
        panY: 0,
        fitMode: 'custom',
      }),
      onViewportChange,
    })

    fireEvent.wheel(frame, { clientX: 300, clientY: 200, deltaY: -30 })
    expect(frames.pending()).toBe(1)
    rerender(
      <Harness
        viewport={normalizePreviewViewport({
          zoom: 4,
          panX: 0,
          panY: 0,
          fitMode: 'custom',
        })}
        onViewportChange={onViewportChange}
      />,
    )
    expect(frames.pending()).toBe(0)
    frames.run()
    expect(onViewportChange).not.toHaveBeenCalled()

    fireEvent.wheel(frame, { clientX: 300, clientY: 200, deltaY: -30 })
    frames.run()
    expect(onViewportChange).toHaveBeenCalledTimes(1)
    expect(onViewportChange.mock.calls[0]?.[0].zoom).toBeCloseTo(4.4)
  })

  it('rebases a held pinch on a genuine external viewport change', () => {
    const onViewportChange = vi.fn()
    const { frame, rerender } = renderGestures({
      viewport: DEFAULT_PREVIEW_VIEWPORT,
      onViewportChange,
    })

    // Pointers at (+50, 0) and (+150, 0) from the center: distance 100.
    fireEvent.pointerDown(frame, {
      pointerId: 1,
      button: 0,
      clientX: 350,
      clientY: 200,
    })
    fireEvent.pointerDown(frame, {
      pointerId: 2,
      button: 0,
      clientX: 450,
      clientY: 200,
    })
    rerender(
      <Harness
        viewport={normalizePreviewViewport({
          zoom: 2,
          panX: 0,
          panY: 0,
          fitMode: 'custom',
        })}
        onViewportChange={onViewportChange}
      />,
    )
    fireEvent.pointerMove(frame, {
      pointerId: 2,
      clientX: 550,
      clientY: 200,
    })
    frames.run()

    // The pinch doubles the external zoom, not the fitted one it began at.
    expect(onViewportChange.mock.calls.at(-1)?.[0].zoom).toBeCloseTo(4)
  })

  it('resets zoom and pan on double click and forgets active pointers', () => {
    const onViewportChange = vi.fn()
    const viewport = normalizePreviewViewport({
      zoom: 3,
      panX: 100,
      panY: -40,
      fitMode: 'custom',
    })
    const { frame } = renderGestures({ viewport, onViewportChange })

    fireEvent.pointerDown(frame, {
      pointerId: 1,
      button: 0,
      clientX: 300,
      clientY: 200,
    })
    fireEvent.wheel(frame, { clientX: 300, clientY: 200, deltaY: -30 })
    expect(frames.pending()).toBe(1)
    fireEvent.doubleClick(frame)

    expect(HTMLElement.prototype.releasePointerCapture).toHaveBeenCalledWith(1)
    expect(onViewportChange).toHaveBeenCalledTimes(1)
    expect(onViewportChange).toHaveBeenCalledWith(DEFAULT_PREVIEW_VIEWPORT)
    expect(frame).toHaveAttribute('data-panning', 'false')
    // The reset supersedes the wheel commit that was still waiting.
    expect(frames.pending()).toBe(0)
    frames.run()
    expect(onViewportChange).toHaveBeenCalledTimes(1)
    fireEvent.pointerMove(frame, { pointerId: 1, clientX: 340, clientY: 200 })
    expect(frames.request).toHaveBeenCalledTimes(1)
  })

  it('drops pending commits, timers, and captures on unmount', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const onViewportChange = vi.fn()
    const viewport = normalizePreviewViewport({
      zoom: 2,
      panX: 0,
      panY: 0,
      fitMode: 'custom',
    })
    const { frame, unmount } = renderGestures({ viewport, onViewportChange })

    fireEvent.pointerDown(frame, {
      pointerId: 1,
      button: 0,
      clientX: 300,
      clientY: 200,
    })
    fireEvent.pointerDown(frame, {
      pointerId: 2,
      button: 0,
      clientX: 400,
      clientY: 200,
    })
    fireEvent.pointerMove(frame, {
      pointerId: 2,
      clientX: 450,
      clientY: 200,
    })
    fireEvent.wheel(frame, { clientX: 300, clientY: 200, deltaY: -30 })
    expect(frames.pending()).toBe(1)
    expect(vi.getTimerCount()).toBe(1)

    unmount()

    expect(frames.pending()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    expect(HTMLElement.prototype.releasePointerCapture).toHaveBeenCalledWith(1)
    expect(HTMLElement.prototype.releasePointerCapture).toHaveBeenCalledWith(2)
    expect(onViewportChange).not.toHaveBeenCalled()
  })

  it('commits only zoom and pan, and leaves split and color to their owners', () => {
    const onViewportChange = vi.fn()
    const { frame, track, rerender } = renderGestures({
      viewport: DEFAULT_PREVIEW_VIEWPORT,
      onViewportChange,
    })
    fireEvent.wheel(frame, { clientX: 300, clientY: 200, deltaY: -150 })
    frames.run()
    const zoomed = onViewportChange.mock.calls[0]?.[0] as PreviewViewport
    expect(Object.keys(zoomed).sort()).toEqual([
      'fitMode',
      'panX',
      'panY',
      'zoom',
    ])

    // A pan on the zoomed photo commits through the same channel.
    rerender(<Harness viewport={zoomed} onViewportChange={onViewportChange} />)
    fireEvent.pointerDown(frame, {
      pointerId: 1,
      button: 0,
      clientX: 300,
      clientY: 200,
    })
    fireEvent.pointerMove(frame, { pointerId: 1, clientX: 320, clientY: 210 })
    frames.run()
    fireEvent.pointerUp(frame, { pointerId: 1 })
    for (const [next] of onViewportChange.mock.calls) {
      expect(Object.keys(next).sort()).toEqual([
        'fitMode',
        'panX',
        'panY',
        'zoom',
      ])
    }
    expect(onViewportChange.mock.calls.length).toBeGreaterThan(1)

    // The stage split and colour are drawn by their owners: the gestures
    // write neither onto the frame nor the track.
    for (const element of [frame, track]) {
      expect(element.style.getPropertyValue('--raw-compare-split')).toBe('')
      expect(element.getAttribute('style')).toBeNull()
    }
  })
})
