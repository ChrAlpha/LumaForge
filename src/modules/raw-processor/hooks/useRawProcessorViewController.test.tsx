import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { useRawProcessorViewController } from './useRawProcessorViewController'
import type { UseRawWorkflowReturn } from './useRawWorkflow.types'

vi.mock('./useOnlineLutSources', () => ({
  useOnlineLutSources: () => ({}),
}))
vi.mock('./stages/ingest/useRawRuntimeReadiness', () => ({
  useRawRuntimeReadiness: () => ({
    runtimeReadinessState: { status: 'idle' },
    triggerRawRuntimePrewarm: vi.fn(),
  }),
}))
vi.mock('./useCapabilityGate', () => ({
  useCapabilityGate: () => ({ ready: false }),
}))
vi.mock('./useHiddenFilePicker', () => ({
  useHiddenFilePicker: () => ({ open: vi.fn() }),
}))

function workflowFixture() {
  return {
    status: 'idle',
    hasImage: true,
    loadFile: vi.fn(),
    loadLUT: vi.fn(),
    loadOnlineLUT: vi.fn(),
    setViewMode: vi.fn(),
    setCompareSplit: vi.fn(),
    resetCompareView: vi.fn(),
    resetPreviewViewport: vi.fn(),
    exportImage: vi.fn(),
    recoverInterruptedExport: vi.fn(),
    reset: vi.fn(),
    updateStats: vi.fn(),
    pipelineRef: { current: null },
    activeStyle: null,
  } as unknown as UseRawWorkflowReturn
}

describe('useRawProcessorViewController', () => {
  it('resets the compare view through one guarded workflow transaction', () => {
    const workflow = workflowFixture()
    const { result } = renderHook(() =>
      useRawProcessorViewController({
        rawRouteLocation: { search: '', pathname: '/raw' },
        workflow,
      }),
    )

    act(() => result.current.handleCompareReset())

    expect(workflow.resetCompareView).toHaveBeenCalledOnce()
    // Never split into separate mode, split and viewport writes, so a
    // refused reset cannot still move the viewport.
    expect(workflow.setViewMode).not.toHaveBeenCalled()
    expect(workflow.setCompareSplit).not.toHaveBeenCalled()
    expect(workflow.resetPreviewViewport).not.toHaveBeenCalled()
  })

  it('reads the reset command of the workflow it is handed now', () => {
    const first = workflowFixture()
    const second = workflowFixture()
    const { result, rerender } = renderHook(
      ({ workflow }) =>
        useRawProcessorViewController({
          rawRouteLocation: { search: '', pathname: '/raw' },
          workflow,
        }),
      { initialProps: { workflow: first } },
    )

    rerender({ workflow: second })
    act(() => result.current.handleCompareReset())

    expect(first.resetCompareView).not.toHaveBeenCalled()
    expect(second.resetCompareView).toHaveBeenCalledOnce()
  })

  it('starts the explicit export with no choices, whatever a surface hands over', () => {
    const workflow = workflowFixture()
    const { result } = renderHook(() =>
      useRawProcessorViewController({
        rawRouteLocation: { search: '', pathname: '/raw' },
        workflow,
      }),
    )
    // The tool surfaces still pass their old quality/fidelity pair.
    const onExport: (options: {
      quality: 'standard' | 'high'
      fidelity: 'safe' | 'balanced' | 'max'
    }) => void = result.current.handleExport

    act(() => onExport({ quality: 'standard', fidelity: 'max' }))

    expect(workflow.exportImage).toHaveBeenCalledOnce()
    expect(workflow.exportImage).toHaveBeenCalledWith()
  })

  it('hands a LUT load back to the caller so it can wait for it to settle', async () => {
    const workflow = workflowFixture()
    vi.mocked(workflow.loadLUT).mockResolvedValue('failed')
    const { result } = renderHook(() =>
      useRawProcessorViewController({
        rawRouteLocation: { search: '', pathname: '/raw' },
        workflow,
      }),
    )
    const file = new File(['x'], 'look.cube')
    await expect(result.current.handleLutDrop([file])).resolves.toBe('failed')
    expect(result.current.handleLutDrop([])).toBeUndefined()
  })
})
