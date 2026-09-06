import '../raw-lab.css'

import { fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import {
  clampCompareSplit,
  CompareSplitHandle,
  getCompareSplitFromClientX,
  getCompareSplitPositionGeometry,
} from './CompareSplitHandle'

beforeAll(() => {
  window.PointerEvent = MouseEvent as typeof PointerEvent
  HTMLElement.prototype.setPointerCapture = function (pointerId: number) {
    this.dataset.capturedPointerId = String(pointerId)
  }
  HTMLElement.prototype.hasPointerCapture = function (pointerId: number) {
    return this.dataset.capturedPointerId === String(pointerId)
  }
  HTMLElement.prototype.releasePointerCapture = function (pointerId: number) {
    if (this.dataset.capturedPointerId === String(pointerId)) {
      delete this.dataset.capturedPointerId
    }
  }
})

describe('compare split helpers', () => {
  it('clamps finite split values to the preview frame range', () => {
    expect(clampCompareSplit(-1)).toBe(0)
    expect(clampCompareSplit(0.5)).toBe(0.5)
    expect(clampCompareSplit(2)).toBe(1)
  })

  it('maps pointer x position to a clamped frame fraction', () => {
    expect(getCompareSplitFromClientX({ left: 100, width: 400 }, 300)).toBe(0.5)
    expect(getCompareSplitFromClientX({ left: 100, width: 400 }, 60)).toBe(0)
    expect(getCompareSplitFromClientX({ left: 100, width: 400 }, 520)).toBe(1)
  })
})

describe('compareSplitHandle', () => {
  it('updates split with keyboard arrows', () => {
    const onChange = vi.fn()

    render(<CompareSplitHandle value={0.5} onChange={onChange} />)

    const slider = screen.getByRole('slider', {
      name: 'Compare unprocessed RAW and final JPEG',
    })

    fireEvent.keyDown(slider, { key: 'ArrowRight' })
    expect(onChange).toHaveBeenLastCalledWith(0.51)

    fireEvent.keyDown(slider, { key: 'ArrowLeft' })
    expect(onChange).toHaveBeenLastCalledWith(0.49)
  })

  it('previews pointer movement on animation frames and commits on release', () => {
    const onChange = vi.fn()
    const onPreviewChange = vi.fn()
    const animationFrames: FrameRequestCallback[] = []
    const requestAnimationFrame = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback) => {
        animationFrames.push(callback)
        return animationFrames.length
      })
    const cancelAnimationFrame = vi
      .spyOn(window, 'cancelAnimationFrame')
      .mockImplementation(() => {})

    render(
      <div data-testid="track">
        {createElement(CompareSplitHandle, {
          value: 0.5,
          onChange,
          onPreviewChange,
        })}
      </div>,
    )

    const track = screen.getByTestId('track')
    const slider = screen.getByRole('slider')
    Object.defineProperty(track, 'getBoundingClientRect', {
      value: () => ({ left: 100, width: 400 }),
    })
    Object.defineProperty(slider, 'getBoundingClientRect', {
      value: () => ({ left: 320, width: 44 }),
    })

    fireEvent.pointerDown(slider, { clientX: 340, pointerId: 1 })
    fireEvent.pointerMove(slider, { clientX: 380, pointerId: 1 })

    expect(onChange).not.toHaveBeenCalled()
    expect(onPreviewChange).not.toHaveBeenCalled()
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1)

    animationFrames[0]?.(performance.now())
    expect(onPreviewChange).toHaveBeenLastCalledWith(0.7)
    expect(onChange).not.toHaveBeenCalled()

    fireEvent.pointerUp(slider, { clientX: 380, pointerId: 1 })
    expect(onChange).toHaveBeenLastCalledWith(0.7)

    requestAnimationFrame.mockRestore()
    cancelAnimationFrame.mockRestore()
  })

  it('scopes transform will-change to active compare dragging', () => {
    const onChange = vi.fn()

    render(
      <div data-testid="track">
        <CompareSplitHandle value={0.5} onChange={onChange} />
      </div>,
    )

    const slider = screen.getByRole('slider')
    expect(getComputedStyle(slider).willChange).not.toContain('transform')

    fireEvent.pointerDown(slider, { clientX: 50, pointerId: 1 })

    expect(getComputedStyle(slider).willChange).toContain('transform')
  })

  it('commits pointer movement in frame coordinates when the photo is letterboxed', () => {
    const onChange = vi.fn()

    render(
      <div data-testid="track">
        <canvas data-raw-compare-track="image" data-testid="image-track" />
        <CompareSplitHandle value={0.5} onChange={onChange} />
      </div>,
    )

    const track = screen.getByTestId('track')
    const imageTrack = screen.getByTestId('image-track')
    const slider = screen.getByRole('slider')
    Object.defineProperty(track, 'getBoundingClientRect', {
      value: () => ({ left: 0, width: 1000 }),
    })
    Object.defineProperty(imageTrack, 'getBoundingClientRect', {
      value: () => ({ left: 250, width: 500 }),
    })
    Object.defineProperty(slider, 'getBoundingClientRect', {
      value: () => ({ left: 500, width: 44 }),
    })

    fireEvent.pointerDown(slider, { clientX: 650, pointerId: 1 })
    fireEvent.pointerUp(slider, { clientX: 650, pointerId: 1 })

    expect(onChange).toHaveBeenLastCalledWith(0.65)
    expect(slider.style.getPropertyValue('--raw-compare-split')).toBe('80%')
  })

  it('keeps handle position in frame coordinates when the photo is zoomed and panned', () => {
    const onChange = vi.fn()

    render(
      <div data-testid="frame">
        <canvas
          data-raw-compare-track="image"
          data-testid="image-track"
          style={
            {
              '--raw-preview-zoom': '2',
              '--raw-preview-pan-x': '100px',
              transform: 'translate3d(100px, 0, 0) scale(2)',
            } as React.CSSProperties
          }
        />
        <CompareSplitHandle value={0.5} onChange={onChange} />
      </div>,
    )

    const frame = screen.getByTestId('frame')
    const imageTrack = screen.getByTestId('image-track')
    const slider = screen.getByRole('slider')

    Object.defineProperty(frame, 'getBoundingClientRect', {
      value: () => ({ left: 0, width: 1000 }),
    })
    Object.defineProperty(imageTrack, 'getBoundingClientRect', {
      value: () => ({ left: 100, width: 1000 }),
    })
    Object.defineProperty(imageTrack, 'offsetWidth', {
      value: 500,
    })

    // split is a frame coordinate: handle stays centred in the preview frame.
    // The photo layer still receives the transformed clip coordinate:
    //   clipFrac = 0.5 + (500 - 100 - 250 - 100) / (2 * 500) = 0.55
    expect(getCompareSplitPositionGeometry(slider, 0.5)).toMatchObject({
      split: 0.5,
      handleX: 500,
      clipSplit: 0.55,
    })
  })

  it('keeps pointer split independent from preview zoom and compensates the clip split', () => {
    const onChange = vi.fn()

    render(
      <div data-testid="frame">
        <canvas
          data-raw-compare-track="image"
          data-testid="image-track"
          style={
            {
              '--raw-preview-zoom': '2',
              '--raw-preview-pan-x': '100px',
              transform: 'translate3d(100px, 0, 0) scale(2)',
            } as React.CSSProperties
          }
        />
        <CompareSplitHandle value={0.5} onChange={onChange} />
      </div>,
    )

    const frame = screen.getByTestId('frame')
    const imageTrack = screen.getByTestId('image-track')
    const slider = screen.getByRole('slider')
    Object.defineProperty(frame, 'getBoundingClientRect', {
      value: () => ({ left: 0, width: 1000 }),
    })
    Object.defineProperty(imageTrack, 'getBoundingClientRect', {
      value: () => ({ left: 100, width: 1000 }),
    })
    Object.defineProperty(imageTrack, 'offsetWidth', {
      value: 500,
    })
    Object.defineProperty(slider, 'getBoundingClientRect', {
      value: () => ({ left: 500, width: 44 }),
    })

    fireEvent.pointerDown(slider, { clientX: 500, pointerId: 1 })
    fireEvent.pointerUp(slider, { clientX: 500, pointerId: 1 })

    // The committed split remains a frame coordinate, while the CSS clip
    // compensates for the transformed photo surface.
    expect(onChange).toHaveBeenLastCalledWith(0.5)
    expect(slider.style.getPropertyValue('--raw-compare-split')).toBe('55%')
  })

  it('keeps the transient preview position when the parent rerenders during drag', () => {
    const onChange = vi.fn()
    const animationFrames: FrameRequestCallback[] = []
    const requestAnimationFrame = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback) => {
        animationFrames.push(callback)
        return animationFrames.length
      })
    const cancelAnimationFrame = vi
      .spyOn(window, 'cancelAnimationFrame')
      .mockImplementation(() => {})

    const { rerender } = render(
      <div data-testid="track">
        <CompareSplitHandle value={0.5} onChange={onChange} />
      </div>,
    )

    const track = screen.getByTestId('track')
    const slider = screen.getByRole('slider')
    Object.defineProperty(track, 'getBoundingClientRect', {
      value: () => ({ left: 0, width: 100 }),
    })
    Object.defineProperty(slider, 'getBoundingClientRect', {
      value: () => ({ left: 50, width: 44 }),
    })

    fireEvent.pointerDown(slider, { clientX: 50, pointerId: 1 })
    fireEvent.pointerMove(slider, { clientX: 80, pointerId: 1 })
    animationFrames[0]?.(performance.now())

    expect(slider.style.getPropertyValue('--raw-compare-split')).toBe('80%')

    rerender(
      <div data-testid="track">
        <CompareSplitHandle value={0.5} onChange={onChange} />
      </div>,
    )

    expect(slider.style.getPropertyValue('--raw-compare-split')).toBe('80%')

    requestAnimationFrame.mockRestore()
    cancelAnimationFrame.mockRestore()
  })

  it('publishes transient pointer split to the parent frame for sibling preview layers', () => {
    const onChange = vi.fn()
    const animationFrames: FrameRequestCallback[] = []
    const requestAnimationFrame = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback) => {
        animationFrames.push(callback)
        return animationFrames.length
      })
    const cancelAnimationFrame = vi
      .spyOn(window, 'cancelAnimationFrame')
      .mockImplementation(() => {})

    render(
      <div data-testid="track">
        <div data-testid="sample-layer" />
        <CompareSplitHandle value={0.5} onChange={onChange} />
      </div>,
    )

    const track = screen.getByTestId('track')
    const slider = screen.getByRole('slider')
    Object.defineProperty(track, 'getBoundingClientRect', {
      value: () => ({ left: 0, width: 100 }),
    })
    Object.defineProperty(slider, 'getBoundingClientRect', {
      value: () => ({ left: 50, width: 44 }),
    })

    fireEvent.pointerDown(slider, { clientX: 50, pointerId: 1 })
    fireEvent.pointerMove(slider, { clientX: 80, pointerId: 1 })
    animationFrames[0]?.(performance.now())

    expect(track.style.getPropertyValue('--raw-compare-split')).toBe('80%')
    expect(onChange).not.toHaveBeenCalled()

    requestAnimationFrame.mockRestore()
    cancelAnimationFrame.mockRestore()
  })

  it('keeps pointer dragging usable when pointer capture is unavailable', () => {
    const onChange = vi.fn()
    const originalSetPointerCapture = HTMLElement.prototype.setPointerCapture
    const originalReleasePointerCapture =
      HTMLElement.prototype.releasePointerCapture
    HTMLElement.prototype.setPointerCapture = vi.fn(() => {
      throw new DOMException('No active pointer', 'NotFoundError')
    })
    HTMLElement.prototype.releasePointerCapture = vi.fn(() => {
      throw new DOMException('No active pointer', 'NotFoundError')
    })

    try {
      render(
        <div data-testid="track">
          <CompareSplitHandle value={0.5} onChange={onChange} />
        </div>,
      )

      const track = screen.getByTestId('track')
      const slider = screen.getByRole('slider')
      Object.defineProperty(track, 'getBoundingClientRect', {
        value: () => ({ left: 0, width: 100 }),
      })
      Object.defineProperty(slider, 'getBoundingClientRect', {
        value: () => ({ left: 50, width: 44 }),
      })

      expect(() => {
        fireEvent.pointerDown(slider, { clientX: 50, pointerId: 1 })
        fireEvent.pointerMove(slider, { clientX: 80, pointerId: 1 })
        fireEvent.pointerUp(slider, { clientX: 80, pointerId: 1 })
      }).not.toThrow()
      expect(onChange).toHaveBeenLastCalledWith(0.8)
    } finally {
      HTMLElement.prototype.setPointerCapture = originalSetPointerCapture
      HTMLElement.prototype.releasePointerCapture =
        originalReleasePointerCapture
    }
  })

  it('keeps pointer and click interactions from reaching the parent dropzone', () => {
    const onChange = vi.fn()
    const onParentClick = vi.fn()
    const onParentPointerDown = vi.fn()

    render(
      <div onClick={onParentClick} onPointerDown={onParentPointerDown}>
        <CompareSplitHandle value={0.5} onChange={onChange} />
      </div>,
    )

    const slider = screen.getByRole('slider')

    fireEvent.pointerDown(slider, { clientX: 340, pointerId: 1 })
    fireEvent.click(slider)

    expect(onParentPointerDown).not.toHaveBeenCalled()
    expect(onParentClick).not.toHaveBeenCalled()
  })

  it('exposes the full range and supports Home and End keys', () => {
    const onChange = vi.fn()

    render(<CompareSplitHandle value={0.5} onChange={onChange} />)

    const slider = screen.getByRole('slider')

    expect(slider).toHaveAttribute('aria-valuemin', '0')
    expect(slider).toHaveAttribute('aria-valuemax', '100')

    fireEvent.keyDown(slider, { key: 'Home' })
    expect(onChange).toHaveBeenLastCalledWith(0)

    fireEvent.keyDown(slider, { key: 'End' })
    expect(onChange).toHaveBeenLastCalledWith(1)
  })
})

describe('compare split handle photo box', () => {
  it('publishes the letterboxed photo box so the line and labels can hug it', () => {
    const frame = document.createElement('div')
    const track = document.createElement('div')
    track.setAttribute('data-raw-compare-track', 'image')
    frame.append(track)
    const handle = document.createElement('button')
    frame.append(handle)
    document.body.append(frame)

    frame.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 400, height: 300 }) as DOMRect
    track.getBoundingClientRect = () =>
      ({ left: 0, top: 50, width: 400, height: 200 }) as DOMRect
    Object.defineProperty(track, 'offsetWidth', { value: 400 })
    Object.defineProperty(track, 'offsetHeight', { value: 200 })

    const geometry = getCompareSplitPositionGeometry(handle, 0.5)
    expect(geometry.geometry.trackTop).toBe(50)
    expect(geometry.geometry.trackHeight).toBe(200)

    frame.remove()
  })
})
