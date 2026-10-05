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
  it('resets the compare view to a centred split at fit, zoom and pan included', () => {
    const workflow = workflowFixture()
    const { result } = renderHook(() =>
      useRawProcessorViewController({
        rawRouteLocation: { search: '', pathname: '/raw' },
        workflow,
      }),
    )

    act(() => result.current.handleCompareReset())

    expect(workflow.setViewMode).toHaveBeenCalledWith('compare')
    expect(workflow.setCompareSplit).toHaveBeenCalledWith(0.5)
    expect(workflow.resetPreviewViewport).toHaveBeenCalledOnce()
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
