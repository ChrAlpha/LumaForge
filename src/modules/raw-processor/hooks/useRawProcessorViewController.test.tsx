import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { RAW_FILE_ACCEPT } from '../components/Dropzone'
import type { UseHiddenFilePickerOptions } from './useHiddenFilePicker'
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
const pickerCalls = vi.hoisted(() => [] as UseHiddenFilePickerOptions[])
vi.mock('./useHiddenFilePicker', () => ({
  useHiddenFilePicker: (options: UseHiddenFilePickerOptions) => {
    pickerCalls.push(options)
    return { open: vi.fn(), inputProps: {} }
  },
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
    reset: vi.fn(),
    updateStats: vi.fn(),
    pipelineRef: { current: null },
    activeStyle: null,
  } as unknown as UseRawWorkflowReturn
}

describe('useRawProcessorViewController', () => {
  beforeEach(() => {
    pickerCalls.length = 0
  })

  it('mounts only the Replace RAW picker, and a picked file loads as a new photo', () => {
    const workflow = workflowFixture()
    const { result } = renderHook(() =>
      useRawProcessorViewController({
        rawRouteLocation: { search: '', pathname: '/raw' },
        workflow,
      }),
    )

    // One picker per render: no second, recovery-only file path exists.
    expect(pickerCalls).toHaveLength(1)
    expect(pickerCalls[0].accept).toBe(RAW_FILE_ACCEPT.join(','))
    expect(result.current).not.toHaveProperty('recoveryPicker')
    expect(result.current).not.toHaveProperty('handleRecoveryFileSelect')

    act(() => result.current.handleReplaceFile())
    expect(result.current.replacePicker.open).toHaveBeenCalledOnce()

    const file = new File(['x'], 'photo.dng')
    act(() => pickerCalls[0].onFile(file))
    expect(workflow.loadFile).toHaveBeenCalledWith(file)
    expect(workflow.exportImage).not.toHaveBeenCalled()
  })

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
