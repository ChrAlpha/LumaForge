import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { MobileLabViewMode } from './useMobileLabChromeController'
import { useMobileLabChromeController } from './useMobileLabChromeController'

type Input = Parameters<typeof useMobileLabChromeController>[0]

function renderController(overrides: Partial<Input> = {}) {
  const onViewModeChange = vi.fn<(mode: MobileLabViewMode) => void>()
  const initialProps: Input = {
    hasImage: true,
    isProcessing: false,
    viewMode: 'processed',
    onViewModeChange,
    ...overrides,
  }
  const hook = renderHook(
    (props: Input) => useMobileLabChromeController(props),
    {
      initialProps,
    },
  )
  return { ...hook, onViewModeChange, initialProps }
}

describe('useMobileLabChromeController', () => {
  it('keeps the compare split on while switching tools', () => {
    const { result, onViewModeChange } = renderController()

    act(() => result.current.setCompareSplitMode(true))
    expect(result.current.compareSplitOpen).toBe(true)
    expect(onViewModeChange).toHaveBeenLastCalledWith('compare')
    onViewModeChange.mockClear()

    act(() => result.current.handleModeChange('tone'))
    act(() => result.current.handleModeChange('look'))

    expect(result.current.mode).toBe('look')
    expect(result.current.compareSplitOpen).toBe(true)
    expect(onViewModeChange).not.toHaveBeenCalled()
  })

  it('opens export in the deck and returns to the previous tool on close', () => {
    const { result } = renderController()

    act(() => result.current.handleModeChange('tone'))
    act(() => result.current.setDockExpanded(false))
    act(() => result.current.openExport())

    expect(result.current.exportOpen).toBe(true)
    expect(result.current.dockExpanded).toBe(true)
    expect(result.current.mode).toBe('tone')

    act(() => result.current.closeExport())
    expect(result.current.exportOpen).toBe(false)
    expect(result.current.mode).toBe('tone')
    expect(result.current.dockExpanded).toBe(true)
  })

  it('closes the export panel when a tool is chosen', () => {
    const { result } = renderController()

    act(() => result.current.openExport())
    act(() => result.current.handleModeChange('look'))

    expect(result.current.exportOpen).toBe(false)
    expect(result.current.mode).toBe('look')
    expect(result.current.dockExpanded).toBe(true)
  })

  it('opens the export panel on the rising edge of preferExportMode only', () => {
    const { result, rerender, initialProps } = renderController()

    rerender({ ...initialProps, preferExportMode: true })
    expect(result.current.exportOpen).toBe(true)

    act(() => result.current.closeExport())
    rerender({ ...initialProps, preferExportMode: true })
    expect(result.current.exportOpen).toBe(false)
  })

  it('closes the split without changing the tool when compare becomes unavailable', () => {
    const { result, rerender, initialProps, onViewModeChange } =
      renderController()

    act(() => result.current.handleModeChange('transform'))
    act(() => result.current.setCompareSplitMode(true))
    rerender({ ...initialProps, viewMode: 'compare', compareDisabled: true })

    expect(result.current.compareSplitOpen).toBe(false)
    expect(result.current.mode).toBe('transform')
    expect(onViewModeChange).toHaveBeenLastCalledWith('processed')
  })

  it('drops the export panel when the RAW is cleared', () => {
    const { result, rerender, initialProps } = renderController()

    act(() => result.current.openExport())
    rerender({ ...initialProps, hasImage: false })

    expect(result.current.exportOpen).toBe(false)
    expect(result.current.mode).toBe('look')
  })
})
