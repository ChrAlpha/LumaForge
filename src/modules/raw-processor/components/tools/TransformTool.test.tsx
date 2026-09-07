import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { transformFeatureFixture } from './transform-feature.fixture'
import { TransformTool } from './TransformTool'

describe('transformTool', () => {
  beforeEach(() => {
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
    fireEvent.click(screen.getByRole('button', { name: 'Reset', exact: true }))
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
    fireEvent.click(screen.getByRole('button', { name: 'Auto', exact: true }))
    expect(feature.setMode).toHaveBeenCalledWith('auto')
    fireEvent.click(screen.getByRole('button', { name: 'Grid', exact: true }))
    expect(feature.setShowGrid).toHaveBeenCalledWith(true)
    fireEvent.keyDown(
      screen.getByRole('slider', { name: 'Scale', exact: true }),
      { key: 'ArrowRight' },
    )
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
    expect(
      screen.getByRole('slider', { name: 'Rotate', exact: true }),
    ).not.toHaveAttribute('aria-disabled', 'true')
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
    fireEvent.click(
      screen.getByRole('button', { name: 'Reset Scale', exact: true }),
    )
    expect(feature.setManual).toHaveBeenCalledWith({
      ...feature.demo.manual,
      scale: 100,
    })
  })
})
