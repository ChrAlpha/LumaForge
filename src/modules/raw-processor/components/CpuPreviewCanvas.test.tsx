import { render, screen } from '@testing-library/react'
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

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

describe('cpuPreviewCanvas', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('redraws at the new box once a resize settles, never per frame of it', () => {
    vi.useFakeTimers()
    let onResize: () => void = () => {}
    vi.stubGlobal(
      'ResizeObserver',
      vi.fn((callback: () => void) => {
        onResize = callback
        return { observe: vi.fn(), disconnect: vi.fn(), unobserve: vi.fn() }
      }),
    )
    const drawImage = vi.fn()
    const context = {
      drawImage,
      putImageData: vi.fn(),
      clearRect: vi.fn(),
    } as unknown as CanvasRenderingContext2D
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(((
      contextId: string,
    ) =>
      contextId === '2d' ? context : null) as HTMLCanvasElement['getContext'])

    render(<CpuPreviewCanvas frame={frame} inFlight={false} />)
    expect(drawImage).toHaveBeenCalledTimes(1)
    // The canvas keeps its last draw undistorted while the box animates.
    expect(screen.getByLabelText(/preview/i)).toHaveClass('object-contain')

    act(() => {
      onResize()
      vi.advanceTimersByTime(CPU_CANVAS_RESIZE_SETTLE_MS / 2)
      onResize()
      vi.advanceTimersByTime(CPU_CANVAS_RESIZE_SETTLE_MS - 1)
    })
    expect(drawImage).toHaveBeenCalledTimes(1)
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(drawImage).toHaveBeenCalledTimes(2)
  })

  it('draws via backing canvas (putImageData) then drawImage to visible', () => {
    const drawImage = vi.fn()
    const putImageData = vi.fn()
    const context = {
      drawImage,
      putImageData,
      clearRect: vi.fn(),
      scale: vi.fn(),
      setTransform: vi.fn(),
    } as unknown as CanvasRenderingContext2D
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(((
      contextId: string,
    ) =>
      contextId === '2d' ? context : null) as HTMLCanvasElement['getContext'])

    render(<CpuPreviewCanvas frame={frame} inFlight={false} />)
    expect(putImageData).toHaveBeenCalled()
    expect(drawImage).toHaveBeenCalled()
    vi.restoreAllMocks()
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
