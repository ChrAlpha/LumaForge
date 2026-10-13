import { act, render, screen } from '@testing-library/react'
import type { Mock } from 'vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  CPU_CANVAS_RESIZE_SETTLE_MS,
  CpuPreviewCanvas,
} from './CpuPreviewCanvas'

const frame = {
  requestId: 1,
  sourceId: 's1',
  rgba: new Uint8ClampedArray(2 * 2 * 4).fill(128),
  width: 2,
  height: 2,
}

const wideFrame = {
  requestId: 2,
  sourceId: 's1',
  rgba: new Uint8ClampedArray(4 * 2 * 4).fill(64),
  width: 4,
  height: 2,
}

interface ContextMock {
  drawImage: Mock
  putImageData: Mock
  clearRect: Mock
  scale: Mock
  setTransform: Mock
}

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = []

  readonly targets = new Set<Element>()
  readonly observe = vi.fn((target: Element) => {
    this.targets.add(target)
  })

  readonly unobserve = vi.fn((target: Element) => {
    this.targets.delete(target)
  })

  readonly disconnect = vi.fn(() => {
    this.targets.clear()
  })

  constructor(private readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this)
  }

  notify() {
    this.callback(
      Array.from(this.targets, (target) => ({ target }) as ResizeObserverEntry),
      this as unknown as ResizeObserver,
    )
  }
}

let contexts: Map<HTMLCanvasElement, ContextMock>
let layout: { width: number; height: number }
let originalDevicePixelRatio: PropertyDescriptor | undefined

function contextFor(canvas: HTMLCanvasElement): ContextMock {
  const context = contexts.get(canvas)
  if (!context) throw new Error('canvas has no 2d context yet')
  return context
}

function setDevicePixelRatio(value: number) {
  Object.defineProperty(window, 'devicePixelRatio', {
    configurable: true,
    value,
  })
}

// Mirrors the browser: only observers that still observe a target get
// notified after a layout change. The redraw lands once the box settles.
function resizeContainer(width: number, height: number) {
  layout = { width, height }
  act(() => {
    for (const observer of FakeResizeObserver.instances) {
      if (observer.targets.size > 0) observer.notify()
    }
    vi.advanceTimersByTime(CPU_CANVAS_RESIZE_SETTLE_MS)
  })
}

// Notifies every observer, disconnected ones included, as a notification
// already in flight would, then lets any settle delay elapse.
function notifyAllObservers() {
  act(() => {
    for (const observer of FakeResizeObserver.instances) observer.notify()
    vi.advanceTimersByTime(CPU_CANVAS_RESIZE_SETTLE_MS)
  })
}

function observingInstances() {
  return FakeResizeObserver.instances.filter(
    (observer) => observer.targets.size > 0,
  )
}

function visibleCanvas(container: HTMLElement): HTMLCanvasElement {
  const canvas = container.querySelector('canvas')
  if (!canvas) throw new Error('visible canvas not rendered')
  return canvas
}

function backingCanvas(): HTMLCanvasElement {
  const backing = [...contexts.keys()].find((canvas) => !canvas.isConnected)
  if (!backing) throw new Error('backing canvas not created')
  return backing
}

describe('cpuPreviewCanvas', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    contexts = new Map()
    layout = { width: 400, height: 300 }
    FakeResizeObserver.instances = []
    originalDevicePixelRatio = Object.getOwnPropertyDescriptor(
      window,
      'devicePixelRatio',
    )

    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      function (this: HTMLCanvasElement, contextId: string) {
        if (contextId !== '2d') return null
        let context = contexts.get(this)
        if (!context) {
          context = {
            drawImage: vi.fn(),
            putImageData: vi.fn(),
            clearRect: vi.fn(),
            scale: vi.fn(),
            setTransform: vi.fn(),
          }
          contexts.set(this, context)
        }
        return context as unknown as CanvasRenderingContext2D
      } as HTMLCanvasElement['getContext'],
    )
    Object.defineProperty(HTMLCanvasElement.prototype, 'clientWidth', {
      configurable: true,
      get(this: HTMLCanvasElement) {
        return this.isConnected ? layout.width : 0
      },
    })
    Object.defineProperty(HTMLCanvasElement.prototype, 'clientHeight', {
      configurable: true,
      get(this: HTMLCanvasElement) {
        return this.isConnected ? layout.height : 0
      },
    })
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    Reflect.deleteProperty(HTMLCanvasElement.prototype, 'clientWidth')
    Reflect.deleteProperty(HTMLCanvasElement.prototype, 'clientHeight')
    if (originalDevicePixelRatio) {
      Object.defineProperty(
        window,
        'devicePixelRatio',
        originalDevicePixelRatio,
      )
    } else {
      Reflect.deleteProperty(window, 'devicePixelRatio')
    }
  })

  it('redraws at the new box once a resize settles, never per frame of it', () => {
    const { container } = render(
      <CpuPreviewCanvas frame={frame} inFlight={false} />,
    )
    const visible = contextFor(visibleCanvas(container))
    expect(visible.drawImage).toHaveBeenCalledTimes(1)
    // The canvas keeps its last draw undistorted while the box animates.

    const [observer] = observingInstances()
    layout = { width: 200, height: 400 }
    act(() => {
      observer?.notify()
      vi.advanceTimersByTime(CPU_CANVAS_RESIZE_SETTLE_MS / 2)
      observer?.notify()
      vi.advanceTimersByTime(CPU_CANVAS_RESIZE_SETTLE_MS - 1)
    })
    expect(visible.drawImage).toHaveBeenCalledTimes(1)
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(visible.drawImage).toHaveBeenCalledTimes(2)
  })

  it('draws via backing canvas (putImageData) then drawImage to visible', () => {
    const { container } = render(
      <CpuPreviewCanvas frame={frame} inFlight={false} />,
    )

    const visible = contextFor(visibleCanvas(container))
    const backing = backingCanvas()
    expect(contextFor(backing).putImageData).toHaveBeenCalledTimes(1)
    expect(visible.drawImage).toHaveBeenCalledWith(
      backing,
      0,
      0,
      frame.width,
      frame.height,
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
    )
    expect(visible.putImageData).not.toHaveBeenCalled()
  })

  it('refits the existing frame when the container resizes', () => {
    setDevicePixelRatio(3)
    const { container } = render(
      <CpuPreviewCanvas frame={wideFrame} inFlight={false} />,
    )
    const canvas = visibleCanvas(container)
    const visible = contextFor(canvas)
    const backing = backingCanvas()

    expect(observingInstances()).toHaveLength(1)
    expect(observingInstances()[0]?.targets).toContain(canvas)

    // 400x300 CSS at a DPR capped to 2, 2:1 frame letterboxed vertically.
    expect([canvas.width, canvas.height]).toEqual([800, 600])
    expect(visible.drawImage).toHaveBeenLastCalledWith(
      backing,
      0,
      0,
      4,
      2,
      0,
      100,
      800,
      400,
    )

    resizeContainer(200, 400)
    expect([canvas.width, canvas.height]).toEqual([400, 800])
    expect(visible.drawImage).toHaveBeenLastCalledWith(
      backing,
      0,
      0,
      4,
      2,
      0,
      300,
      400,
      200,
    )

    resizeContainer(600, 150)
    expect([canvas.width, canvas.height]).toEqual([1200, 300])
    expect(visible.drawImage).toHaveBeenLastCalledWith(
      backing,
      0,
      0,
      4,
      2,
      300,
      0,
      600,
      300,
    )

    // A resize only re-fits the uploaded backing frame: raw pixels are
    // uploaded once, never with putImageData on the visible canvas.
    expect(contextFor(backing).putImageData).toHaveBeenCalledTimes(1)
    expect(visible.putImageData).not.toHaveBeenCalled()
    expect([backing.width, backing.height]).toEqual([4, 2])
  })

  it('skips zero-sized containers without NaN or backing-store growth', () => {
    setDevicePixelRatio(2)
    layout = { width: 0, height: 0 }
    const { container, rerender } = render(
      <CpuPreviewCanvas frame={frame} inFlight={false} />,
    )
    const canvas = visibleCanvas(container)
    const initialSize = [canvas.width, canvas.height]

    rerender(<CpuPreviewCanvas frame={wideFrame} inFlight={false} />)
    resizeContainer(0, 0)
    resizeContainer(400, 0)
    resizeContainer(0, 300)
    resizeContainer(0, 0)

    expect([canvas.width, canvas.height]).toEqual(initialSize)
    expect(contexts.get(canvas)?.drawImage ?? vi.fn()).not.toHaveBeenCalled()

    resizeContainer(400, 300)
    const visible = contextFor(canvas)
    expect([canvas.width, canvas.height]).toEqual([800, 600])
    expect(visible.drawImage).toHaveBeenCalledTimes(1)
    const [, ...geometry] = visible.drawImage.mock.calls[0] ?? []
    expect(geometry).toEqual([0, 0, 4, 2, 0, 100, 800, 400])
    expect(geometry.every((value) => Number.isFinite(value))).toBe(true)
  })

  it('observes layout only while a frame is on the canvas', () => {
    const { container, rerender } = render(
      <CpuPreviewCanvas
        frame={null}
        inFlight={false}
        fallbackThumbnailUrl="blob:embedded"
      />,
    )
    expect(container.querySelector('img')).toHaveAttribute(
      'src',
      'blob:embedded',
    )
    expect(observingInstances()).toHaveLength(0)

    rerender(
      <CpuPreviewCanvas
        frame={frame}
        inFlight={false}
        fallbackThumbnailUrl="blob:embedded"
      />,
    )
    const visible = contextFor(visibleCanvas(container))
    expect(observingInstances()).toHaveLength(1)
    const drawsWithFrame = visible.drawImage.mock.calls.length

    rerender(
      <CpuPreviewCanvas
        frame={null}
        inFlight={false}
        fallbackThumbnailUrl="blob:embedded"
      />,
    )
    expect(container.querySelector('canvas')).toBeNull()
    expect(observingInstances()).toHaveLength(0)
    for (const observer of FakeResizeObserver.instances) {
      expect(observer.disconnect).toHaveBeenCalled()
    }

    resizeContainer(200, 400)
    notifyAllObservers()
    expect(visible.drawImage).toHaveBeenCalledTimes(drawsWithFrame)
  })

  it('leaves no observer or pending draw behind after unmount', () => {
    const { container, unmount } = render(
      <CpuPreviewCanvas frame={frame} inFlight={false} />,
    )
    const visible = contextFor(visibleCanvas(container))
    expect(observingInstances()).toHaveLength(1)
    const drawsBeforeUnmount = visible.drawImage.mock.calls.length

    unmount()

    expect(FakeResizeObserver.instances.length).toBeGreaterThan(0)
    for (const observer of FakeResizeObserver.instances) {
      expect(observer.disconnect).toHaveBeenCalled()
    }
    expect(observingInstances()).toHaveLength(0)

    // Even a notification that was already in flight must not draw.
    notifyAllObservers()
    expect(visible.drawImage).toHaveBeenCalledTimes(drawsBeforeUnmount)
  })

  it('shows a spinner while a render is in flight', () => {
    render(<CpuPreviewCanvas frame={frame} inFlight />)
    expect(screen.getByTestId('cpu-preview-spinner')).toBeInTheDocument()
  })

  it('shows loading instead of unavailable before the first CPU frame resolves', () => {
    render(<CpuPreviewCanvas frame={null} inFlight failureReason={null} />)

    expect(screen.getByTestId('cpu-preview-spinner')).toBeInTheDocument()
    expect(
      screen.queryByTestId('cpu-preview-unavailable'),
    ).not.toBeInTheDocument()
  })

  it('shows an explicit placeholder when no frame and no thumbnail on failure', () => {
    render(
      <CpuPreviewCanvas
        frame={null}
        inFlight={false}
        failureReason="render-failed"
      />,
    )
    expect(screen.getByTestId('cpu-preview-unavailable')).toBeInTheDocument()
  })
})
