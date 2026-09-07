import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { transformFeatureFixture } from './transform-feature.fixture'
import { TransformTool } from './TransformTool'

describe('transformTool', () => {
  beforeEach(() => {
    vi.stubGlobal('PointerEvent', MouseEvent)
    vi.stubGlobal(
      'ResizeObserver',
      vi.fn(() => ({
        observe: vi.fn(),
        unobserve: vi.fn(),
        disconnect: vi.fn(),
      })),
    )
  })
  afterEach(() => vi.unstubAllGlobals())

  it('observes the current RAW only while mounted and never loads a sample', () => {
    const stop = vi.fn()
    const feature = transformFeatureFixture({ observe: vi.fn(() => stop) })
    const { unmount, container } = render(<TransformTool feature={feature} />)
    expect(feature.observe).toHaveBeenCalledOnce()
    expect(feature.demo.loadSource).not.toHaveBeenCalled()
    expect(
      screen.getByText('Open a RAW photo to adjust its perspective.'),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Auto' })).toBeDisabled()
    expect(container.querySelector('canvas, img')).toBeNull()
    unmount()
    expect(stop).toHaveBeenCalledOnce()
  })

  it('keeps Reset available after a failed active transform', () => {
    const feature = transformFeatureFixture({
      hasImage: true,
      active: true,
      captureError: true,
      busy: true,
    })
    feature.demo = { ...feature.demo, mode: 'auto' }
    render(<TransformTool feature={feature} />)
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The processed preview is unavailable. Wait for it or reset Transform.',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }))
    expect(feature.reset).toHaveBeenCalledOnce()
  })

  it('offers modes, view aids and independent geometry controls', () => {
    const feature = transformFeatureFixture({
      hasImage: true,
      available: true,
      current: true,
    })
    feature.demo = { ...feature.demo, ready: true }
    render(<TransformTool feature={feature} />)
    expect(screen.getByRole('slider', { name: 'Scale' })).toHaveAttribute(
      'aria-valuetext',
      '100%',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Auto' }))
    expect(feature.setMode).toHaveBeenCalledWith('auto')
    fireEvent.click(screen.getByRole('button', { name: 'Grid' }))
    expect(feature.setShowGrid).toHaveBeenCalledWith(true)
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Scale' }), {
      key: 'ArrowRight',
    })
    expect(feature.setManual).toHaveBeenCalledWith({
      ...feature.demo.manual,
      scale: 101,
    })
  })

  it('explains abstention and allows manual correction', () => {
    const feature = transformFeatureFixture({
      hasImage: true,
      available: true,
      current: true,
    })
    feature.demo = {
      ...feature.demo,
      ready: true,
      mode: 'auto',
      solution: { ...feature.demo.solution, status: 'insufficient' },
    }
    const { rerender } = render(<TransformTool feature={feature} />)
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Not enough reliable structure. Try manual adjustments.',
    )
    expect(screen.getByRole('slider', { name: 'Rotate' })).not.toHaveAttribute(
      'aria-disabled',
      'true',
    )
    rerender(
      <TransformTool
        feature={{ ...feature, demo: { ...feature.demo, mode: 'off' } }}
      />,
    )
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('resets the Scale readout to 100 percent without changing other fields', () => {
    const feature = transformFeatureFixture({
      hasImage: true,
      available: true,
      current: true,
    })
    feature.demo = {
      ...feature.demo,
      ready: true,
      manual: { ...feature.demo.manual, scale: 120, rotate: 2 },
    }
    render(<TransformTool feature={feature} />)
    expect(screen.getByRole('slider', { name: 'Scale' })).toHaveAttribute(
      'aria-valuetext',
      '120%',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Reset Scale' }))
    expect(feature.setManual).toHaveBeenCalledWith({
      ...feature.demo.manual,
      scale: 100,
    })
  })

  it('allows a full reset when only constrain crop has changed', () => {
    const feature = transformFeatureFixture({ hasImage: true })
    feature.demo = { ...feature.demo, constrainCrop: false }
    render(<TransformTool feature={feature} />)
    const reset = screen.getByRole('button', { name: 'Reset' })
    expect(reset).toBeEnabled()
    fireEvent.click(reset)
    expect(feature.reset).toHaveBeenCalledOnce()
  })

  it('ignores an existing scrub after processing disables the controls', () => {
    const feature = transformFeatureFixture({
      hasImage: true,
      available: true,
      current: true,
    })
    feature.demo = { ...feature.demo, ready: true }
    const { rerender } = render(<TransformTool feature={feature} />)
    const row = screen
      .getByRole('slider', { name: 'Scale' })
      .closest('[data-adjust-row]')!
    vi.spyOn(
      row.querySelector('[data-slot="slider-track"]')!,
      'getBoundingClientRect',
    ).mockReturnValue({ left: 0, top: 0, width: 200, height: 10 } as DOMRect)
    fireEvent.pointerDown(row, { clientX: 100, clientY: 5, buttons: 1 })
    expect(row).toHaveAttribute('data-scrubbing', 'true')
    vi.mocked(feature.setManual).mockClear()
    rerender(<TransformTool feature={{ ...feature, isProcessing: true }} />)
    fireEvent.pointerMove(row, { clientX: 160, clientY: 5, buttons: 1 })
    fireEvent.pointerUp(row, { clientX: 160, clientY: 5 })
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Scale' }), {
      key: 'ArrowRight',
    })
    expect(feature.setManual).not.toHaveBeenCalled()
  })
})
