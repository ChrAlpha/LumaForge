import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RawTransformFeature } from '../../hooks/useRawTransformFeature'
import { transformFeatureFixture } from '../tools/transform-feature.fixture'
import { TransformListPanel } from './TransformListPanel'

function readyFeature(overrides: Partial<RawTransformFeature> = {}) {
  const feature = transformFeatureFixture({
    hasImage: true,
    available: true,
    current: true,
    ...overrides,
  })
  feature.demo = {
    ...feature.demo,
    ready: true,
    manual: { ...feature.demo.manual, scale: 120, rotate: 2 },
  }
  return feature
}

async function openFrame() {
  fireEvent.click(screen.getByRole('tab', { name: 'Frame' }))
  return screen.findByRole('slider', { name: 'Scale' })
}

describe('transformListPanel', () => {
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

  it.each([
    { available: false },
    { captureError: true },
    { isProcessing: true },
  ])('disables all manual input while blocked by %j', async (blocked) => {
    const feature = readyFeature(blocked)
    render(<TransformListPanel feature={feature} />)
    const scale = await openFrame()
    expect(scale.closest('[data-slot="slider-root"]')).toHaveAttribute(
      'data-disabled',
    )
    const reset = screen.getByRole('button', { name: 'Reset Scale' })
    expect(reset).toBeDisabled()
    fireEvent.keyDown(scale, { key: 'ArrowRight' })
    fireEvent.click(reset)
    const row = scale.closest('[data-adjust-slider-row]')!
    fireEvent.pointerDown(row)
    fireEvent.pointerUp(row)
    expect(feature.setManual).not.toHaveBeenCalled()
  })

  it('ignores a scrub already in progress when processing starts', async () => {
    const feature = readyFeature()
    const { rerender } = render(<TransformListPanel feature={feature} />)
    const scale = await openFrame()
    const row = scale.closest('[data-adjust-slider-row]')!
    vi.spyOn(
      row.querySelector('[data-slot="slider-track"]')!,
      'getBoundingClientRect',
    ).mockReturnValue({ left: 0, top: 0, width: 200, height: 10 } as DOMRect)
    fireEvent.pointerDown(row, { clientX: 100, clientY: 5, buttons: 1 })
    expect(row).toHaveAttribute('data-scrubbing', 'true')
    vi.mocked(feature.setManual).mockClear()
    rerender(
      <TransformListPanel feature={{ ...feature, isProcessing: true }} />,
    )
    fireEvent.pointerMove(row, { clientX: 160, clientY: 5, buttons: 1 })
    fireEvent.pointerUp(row, { clientX: 160, clientY: 5 })
    fireEvent.keyDown(scale, { key: 'ArrowRight' })
    expect(feature.setManual).not.toHaveBeenCalled()
    expect(row).not.toHaveAttribute('data-scrubbing')
  })

  it('announces absolute Scale and resets it to 100 percent', async () => {
    const feature = readyFeature()
    const { rerender } = render(<TransformListPanel feature={feature} />)
    const scale = await openFrame()
    expect(scale).toHaveAttribute('aria-valuetext', '120%')
    fireEvent.click(screen.getByRole('button', { name: 'Reset Scale' }))
    expect(feature.setManual).toHaveBeenCalledWith({
      ...feature.demo.manual,
      scale: 100,
    })
    rerender(
      <TransformListPanel
        feature={{
          ...feature,
          demo: {
            ...feature.demo,
            manual: { ...feature.demo.manual, scale: 100 },
          },
        }}
      />,
    )
    expect(scale).toHaveAttribute('aria-valuetext', '100%')
  })

  it('enables full and Frame reset for a crop-only change', async () => {
    const feature = transformFeatureFixture({ hasImage: true })
    feature.demo = { ...feature.demo, constrainCrop: false }
    render(<TransformListPanel feature={feature} />)
    const fullReset = screen.getByRole('button', { name: 'Reset Upright' })
    expect(fullReset).toBeEnabled()
    fireEvent.click(fullReset)
    expect(feature.reset).toHaveBeenCalledOnce()
    await openFrame()
    const frameReset = screen.getByRole('button', { name: 'Reset Frame' })
    expect(frameReset).toBeEnabled()
    fireEvent.click(frameReset)
    expect(feature.setConstrainCrop).toHaveBeenCalledWith(true)
    expect(feature.setManual).toHaveBeenCalledWith(feature.demo.manual)
  })

  it('resets Frame without restoring stale geometry activation or other fields', async () => {
    const feature = readyFeature()
    feature.demo = { ...feature.demo, constrainCrop: false }
    render(<TransformListPanel feature={feature} />)
    await openFrame()
    fireEvent.click(screen.getByRole('button', { name: 'Reset Frame' }))
    expect(feature.setManual).toHaveBeenCalledWith({
      ...feature.demo.manual,
      scale: 100,
      offsetX: 0,
      offsetY: 0,
    })
    expect(
      vi.mocked(feature.setConstrainCrop).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(feature.setManual).mock.invocationCallOrder[0])
  })
})
