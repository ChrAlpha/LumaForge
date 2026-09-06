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

  it('keeps reset available after capture fails while disabling stale preview saving', () => {
    const feature = transformFeatureFixture({
      hasImage: true,
      active: true,
      captureError: true,
      busy: true,
    })
    render(<TransformTool feature={feature} />)
    expect(
      screen.getByText(
        'The processed preview is unavailable. Wait for it or reset Transform.',
      ),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Save preview JPEG' }),
    ).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }))
    expect(feature.reset).toHaveBeenCalledOnce()
    expect(feature.download).not.toHaveBeenCalled()
  })

  it('uses transform comparison and saves only a current processed preview', () => {
    const feature = transformFeatureFixture({
      hasImage: true,
      available: true,
      current: true,
    })
    render(<TransformTool feature={feature} />)
    fireEvent.click(screen.getByRole('button', { name: 'Before transform' }))
    expect(feature.setBefore).toHaveBeenCalledWith(true)
    fireEvent.click(screen.getByRole('button', { name: 'After transform' }))
    expect(feature.setBefore).toHaveBeenCalledWith(false)
    fireEvent.click(screen.getByRole('button', { name: 'Grid' }))
    expect(feature.setShowGrid).toHaveBeenCalledWith(true)
    fireEvent.click(screen.getByRole('button', { name: 'Save preview JPEG' }))
    expect(feature.download).toHaveBeenCalledOnce()
    expect(
      screen.getByText(/Perspective preview, up to 1600 px/),
    ).toBeInTheDocument()
  })

  it('explains an abstained automatic correction and keeps manual recovery available', () => {
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
    expect(
      screen.getByText(
        'Not enough reliable structure. Try manual adjustments.',
      ),
    ).toHaveAttribute('role', 'status')
    expect(
      screen.getByRole('slider', { name: 'Rotate', exact: true }),
    ).not.toHaveAttribute('aria-disabled', 'true')
    rerender(
      <TransformTool
        feature={{ ...feature, demo: { ...feature.demo, mode: 'off' } }}
      />,
    )
    expect(
      screen.queryByText(
        'Not enough reliable structure. Try manual adjustments.',
      ),
    ).toBeNull()
  })
})
