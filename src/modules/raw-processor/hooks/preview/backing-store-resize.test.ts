import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  aspectFitBox,
  BACKING_STORE_SETTLE_MS,
  backingStoreSize,
  observeSettledBackingStore,
} from './backing-store-resize'

function captureResizeObservers() {
  const observers: Array<{
    callback: ResizeObserverCallback
    observe: ReturnType<typeof vi.fn>
    disconnect: ReturnType<typeof vi.fn>
  }> = []
  vi.stubGlobal(
    'ResizeObserver',
    vi.fn().mockImplementation((callback: ResizeObserverCallback) => {
      const observer = { callback, observe: vi.fn(), disconnect: vi.fn() }
      observers.push(observer)
      return observer
    }),
  )
  return observers
}

function fireResize(
  callback: ResizeObserverCallback,
  ...sizes: Array<[number, number]>
) {
  callback(
    sizes.map(
      ([width, height]) =>
        ({ contentRect: { width, height } }) as ResizeObserverEntry,
    ),
    {} as ResizeObserver,
  )
}

/** Sets the device pixel ratio the backing store reads until restored. */
function stubDevicePixelRatio(value: number | undefined) {
  const original = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio')
  Object.defineProperty(window, 'devicePixelRatio', {
    configurable: true,
    value,
  })
  return () => {
    if (original) {
      Object.defineProperty(window, 'devicePixelRatio', original)
    } else {
      Reflect.deleteProperty(window, 'devicePixelRatio')
    }
  }
}

/** A canvas that counts backing store assignments, which clear it. */
function countingCanvas() {
  const canvas = document.createElement('canvas')
  let width = canvas.width
  let height = canvas.height
  const assignments = { count: 0 }
  Object.defineProperty(canvas, 'width', {
    get: () => width,
    set: (value: number) => {
      assignments.count += 1
      width = value
    },
  })
  Object.defineProperty(canvas, 'height', {
    get: () => height,
    set: (value: number) => {
      assignments.count += 1
      height = value
    },
  })
  return { canvas, assignments }
}

describe('aspectFitBox', () => {
  it('fits a landscape source to the width of a portrait container', () => {
    expect(
      aspectFitBox({ width: 300, height: 600 }, { width: 400, height: 300 }),
    ).toEqual({ width: 300, height: 225 })
  })

  it('fits a portrait source to the height of a landscape container', () => {
    expect(
      aspectFitBox({ width: 800, height: 400 }, { width: 300, height: 400 }),
    ).toEqual({ width: 300, height: 400 })
  })

  it('fills a container with the same aspect ratio', () => {
    expect(
      aspectFitBox({ width: 800, height: 600 }, { width: 400, height: 300 }),
    ).toEqual({ width: 800, height: 600 })
  })

  it('keeps the container box while the source has no size', () => {
    expect(
      aspectFitBox({ width: 320, height: 180 }, { width: 0, height: 300 }),
    ).toEqual({ width: 320, height: 180 })
    expect(
      aspectFitBox({ width: 320, height: 180 }, { width: 400, height: 0 }),
    ).toEqual({ width: 320, height: 180 })
  })

  it('collapses to an empty box for a zero-size container', () => {
    const source = { width: 400, height: 300 }
    expect(aspectFitBox({ width: 0, height: 0 }, source)).toEqual({
      width: 0,
      height: 0,
    })
    expect(aspectFitBox({ width: 400, height: 0 }, source)).toEqual({
      width: 0,
      height: 0,
    })
    expect(aspectFitBox({ width: 0, height: 300 }, source)).toEqual({
      width: 0,
      height: 0,
    })
  })
})

describe('backingStoreSize', () => {
  let restoreDpr: (() => void) | null = null

  afterEach(() => {
    restoreDpr?.()
    restoreDpr = null
  })

  it.each([
    [1, { width: 333, height: 250 }],
    [1.5, { width: 500, height: 375 }],
    [2, { width: 666, height: 500 }],
    [3, { width: 666, height: 500 }],
    [0, { width: 333, height: 250 }],
    [undefined, { width: 333, height: 250 }],
  ])(
    'scales by a pixel ratio of %s, capped at 2 and 1 when unknown',
    (dpr, expected) => {
      restoreDpr = stubDevicePixelRatio(dpr)
      expect(backingStoreSize({ width: 333, height: 249.75 })).toEqual(expected)
    },
  )

  it('rounds to whole device pixels', () => {
    restoreDpr = stubDevicePixelRatio(1.5)
    expect(backingStoreSize({ width: 333, height: 444 })).toEqual({
      width: 500,
      height: 666,
    })
  })

  it('keeps a zero-size box at the minimum', () => {
    expect(backingStoreSize({ width: 0, height: 0 })).toEqual({
      width: 0,
      height: 0,
    })
    expect(backingStoreSize({ width: 0, height: 0.2 }, 1)).toEqual({
      width: 1,
      height: 1,
    })
  })
})

describe('observeSettledBackingStore', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  function observe(
    options: { applyImmediately?: () => boolean } = {},
    canvas = document.createElement('canvas'),
  ) {
    const observers = captureResizeObservers()
    const target = document.createElement('div')
    const measured: Array<{ width: number; height: number }> = []
    const applied: Array<[number, number]> = []
    const teardown = observeSettledBackingStore(target, canvas, {
      measure: (contentRect) => {
        measured.push({ width: contentRect.width, height: contentRect.height })
        return { width: contentRect.width * 2, height: contentRect.height * 2 }
      },
      onApply: () => {
        applied.push([canvas.width, canvas.height])
      },
      ...options,
    })
    const observer = observers[0]!
    return { target, canvas, observer, measured, applied, teardown }
  }

  it('observes the target and applies the first size at once', () => {
    const { target, canvas, observer, applied } = observe()

    expect(observer.observe).toHaveBeenCalledExactlyOnceWith(target)
    fireResize(observer.callback, [200, 100])

    expect([canvas.width, canvas.height]).toEqual([400, 200])
    expect(applied).toEqual([[400, 200]])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('measures every size but applies only the last once it has settled', () => {
    const { canvas, observer, measured, applied } = observe()
    fireResize(observer.callback, [200, 100])

    fireResize(observer.callback, [210, 100])
    vi.advanceTimersByTime(BACKING_STORE_SETTLE_MS - 1)
    fireResize(observer.callback, [220, 100], [230, 100])
    vi.advanceTimersByTime(BACKING_STORE_SETTLE_MS - 1)

    expect(measured).toHaveLength(4)
    expect([canvas.width, canvas.height]).toEqual([400, 200])
    expect(applied).toHaveLength(1)

    vi.advanceTimersByTime(1)

    expect([canvas.width, canvas.height]).toEqual([460, 200])
    expect(applied).toEqual([
      [400, 200],
      [460, 200],
    ])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('applies a later size at once while the caller asks for it', () => {
    let immediate = true
    const { observer, applied } = observe({ applyImmediately: () => immediate })
    fireResize(observer.callback, [200, 100])
    fireResize(observer.callback, [300, 100])
    expect(applied).toEqual([
      [400, 200],
      [600, 200],
    ])

    immediate = false
    fireResize(observer.callback, [100, 100])
    expect(applied).toHaveLength(2)
    vi.advanceTimersByTime(BACKING_STORE_SETTLE_MS)
    expect(applied.at(-1)).toEqual([200, 200])
  })

  it('applies the first size at once without asking the caller', () => {
    const applyImmediately = vi.fn(() => false)
    const { observer, applied } = observe({ applyImmediately })

    fireResize(observer.callback, [200, 100])

    expect(applied).toHaveLength(1)
    expect(applyImmediately).not.toHaveBeenCalled()
  })

  it('leaves an unchanged backing store unassigned but still applies it', () => {
    const { canvas, assignments } = countingCanvas()
    const { observer, applied } = observe({}, canvas)
    fireResize(observer.callback, [200, 100])
    expect(assignments.count).toBe(2)

    fireResize(observer.callback, [200, 100])
    vi.advanceTimersByTime(BACKING_STORE_SETTLE_MS)

    expect(assignments.count).toBe(2)
    expect(applied).toHaveLength(2)
  })

  it('disconnects and flushes a pending size on teardown', () => {
    const { canvas, observer, applied, teardown } = observe()
    fireResize(observer.callback, [200, 100])
    fireResize(observer.callback, [100, 50])

    teardown()

    expect(observer.disconnect).toHaveBeenCalledOnce()
    expect([canvas.width, canvas.height]).toEqual([200, 100])
    expect(applied).toHaveLength(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('applies nothing on teardown when no size is pending', () => {
    const { observer, applied, teardown } = observe()
    fireResize(observer.callback, [200, 100])

    teardown()
    vi.runAllTimers()

    expect(observer.disconnect).toHaveBeenCalledOnce()
    expect(applied).toHaveLength(1)
  })
})
