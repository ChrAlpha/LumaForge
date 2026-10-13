import type {
  LumaRawRuntime,
  LumaRawRuntimeInfo,
} from '@lumaforge/luma-raw-runtime'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RawRuntimeHost } from '~/lib/raw/raw-runtime-host'
import { createRawRuntimeHost } from '~/lib/raw/raw-runtime-host'

import { RAW_FILE_ACCEPT } from '../components/Dropzone'
import type { UseHiddenFilePickerOptions } from './useHiddenFilePicker'
import { useRawProcessorViewController } from './useRawProcessorViewController'
import type { UseRawWorkflowReturn } from './useRawWorkflow.types'

vi.mock('./useOnlineLutSources', () => ({
  useOnlineLutSources: () => ({}),
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

function makeRuntime() {
  const info: LumaRawRuntimeInfo = {
    runtime: 'luma',
    version: '0.1.0',
    crossOriginIsolated: true,
    memoryProfile: 'desktop',
  }
  return {
    init: vi.fn<LumaRawRuntime['init']>().mockResolvedValue(info),
    openSession: vi.fn<LumaRawRuntime['openSession']>(),
    dispose: vi.fn<LumaRawRuntime['dispose']>(),
  } satisfies LumaRawRuntime
}

function coiError() {
  return Object.assign(new Error('Cross-origin isolation is required.'), {
    code: 'RAW_CROSS_ORIGIN_ISOLATION_REQUIRED',
  })
}

function workflowFixture(
  rawRuntimeHost: RawRuntimeHost = createRawRuntimeHost({
    runtimeFactory: () => makeRuntime(),
  }),
) {
  return {
    rawRuntimeHost,
    status: 'idle',
    hasImage: true,
    loadFile: vi.fn(),
    loadLUT: vi.fn(),
    loadOnlineLUT: vi.fn(),
    setViewMode: vi.fn(),
    setCompareSplit: vi.fn(),
    resetCompareView: vi.fn(),
    setPreviewViewport: vi.fn(),
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

  afterEach(() => {
    vi.useRealTimers()
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
    expect(workflow.setPreviewViewport).not.toHaveBeenCalled()
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

  describe('runtime readiness', () => {
    // The view warms the RAW engine once the page is idle.
    beforeEach(() => {
      vi.useFakeTimers()
    })

    function renderController(workflow: UseRawWorkflowReturn) {
      return renderHook(
        ({ workflow: current }) =>
          useRawProcessorViewController({
            rawRouteLocation: { search: '', pathname: '/raw' },
            workflow: current,
          }),
        { initialProps: { workflow } },
      )
    }

    it('warms the workflow host once idle and follows its live runtime through idle termination and rewarm', async () => {
      const runtime = makeRuntime()
      const runtimeFactory = vi.fn(() => runtime)
      const host = createRawRuntimeHost({ runtimeFactory, idleMs: 1_000 })
      const { result } = renderController(workflowFixture(host))

      expect(result.current.runtimeReadinessState).toBe('idle')
      expect(runtimeFactory).not.toHaveBeenCalled()

      await act(() => vi.advanceTimersByTimeAsync(200))
      expect(runtime.init).toHaveBeenCalledTimes(1)
      expect(result.current.runtimeReadinessState).toBe('ready')
      expect(host.getSnapshot().runtime).toMatchObject({
        generation: 1,
        initialized: true,
      })

      // The worker idles out on its own; an earlier successful warmup does
      // not keep reporting a ready engine.
      await act(() => vi.advanceTimersByTimeAsync(1_000))
      expect(runtime.dispose).toHaveBeenCalledTimes(1)
      expect(host.getSnapshot()).toMatchObject({
        initialization: 'ready',
        runtime: { initialized: false, lastTermination: { reason: 'idle' } },
      })
      expect(result.current.runtimeReadinessState).toBe('idle')

      await act(async () => {
        result.current.triggerRawRuntimePrewarm()
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(runtime.init).toHaveBeenCalledTimes(2)
      expect(host.getSnapshot().runtime).toMatchObject({
        generation: 2,
        initialized: true,
      })
      expect(result.current.runtimeReadinessState).toBe('ready')
      // One host, one bridge: the rewarm never built a second runtime source.
      expect(runtimeFactory).toHaveBeenCalledTimes(2)
    })

    it('observes the termination the workflow itself asks of its host', async () => {
      const runtime = makeRuntime()
      const host = createRawRuntimeHost({ runtimeFactory: () => runtime })
      const { result } = renderController(workflowFixture(host))

      await act(() => vi.advanceTimersByTimeAsync(200))
      expect(result.current.runtimeReadinessState).toBe('ready')

      await act(() => host.terminateDecodeBridge())
      expect(result.current.runtimeReadinessState).toBe('idle')
    })

    it('reports a pending warmup and retries a recoverable failure', async () => {
      const runtime = makeRuntime()
      let rejectInit!: (error: unknown) => void
      runtime.init.mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectInit = reject
          }),
      )
      const host = createRawRuntimeHost({ runtimeFactory: () => runtime })
      const { result } = renderController(workflowFixture(host))

      await act(() => vi.advanceTimersByTimeAsync(200))
      expect(result.current.runtimeReadinessState).toBe('pending')

      await act(async () => {
        rejectInit(new Error('network blip'))
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(result.current.runtimeReadinessState).toBe('failed')

      await act(async () => {
        result.current.triggerRawRuntimePrewarm()
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(runtime.init).toHaveBeenCalledTimes(2)
      expect(result.current.runtimeReadinessState).toBe('ready')
    })

    it('keeps a cross-origin isolation failure sticky across later triggers', async () => {
      const runtime = makeRuntime()
      runtime.init.mockRejectedValue(coiError())
      const host = createRawRuntimeHost({ runtimeFactory: () => runtime })
      const { result } = renderController(workflowFixture(host))

      await act(() => vi.advanceTimersByTimeAsync(200))
      expect(result.current.runtimeReadinessState).toBe('failed')

      await act(async () => {
        result.current.triggerRawRuntimePrewarm()
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(runtime.init).toHaveBeenCalledTimes(1)
      expect(result.current.runtimeReadinessState).toBe('failed')
    })

    it('reads and warms the host of the workflow it is handed now', async () => {
      const firstRuntime = makeRuntime()
      const secondRuntime = makeRuntime()
      const first = workflowFixture(
        createRawRuntimeHost({ runtimeFactory: () => firstRuntime }),
      )
      const second = workflowFixture(
        createRawRuntimeHost({ runtimeFactory: () => secondRuntime }),
      )
      const { result, rerender } = renderController(first)

      rerender({ workflow: second })
      await act(() => vi.advanceTimersByTimeAsync(200))

      expect(firstRuntime.init).not.toHaveBeenCalled()
      expect(secondRuntime.init).toHaveBeenCalledTimes(1)
      expect(result.current.runtimeReadinessState).toBe('ready')
    })

    it('never starts a runtime before the page is idle or after unmount', async () => {
      const runtimeFactory = vi.fn(() => makeRuntime())
      const host = createRawRuntimeHost({ runtimeFactory })
      const { unmount } = renderController(workflowFixture(host))

      await act(() => vi.advanceTimersByTimeAsync(199))
      unmount()
      await vi.advanceTimersByTimeAsync(1_000)

      expect(runtimeFactory).not.toHaveBeenCalled()
      expect(host.getSnapshot().initialization).toBe('idle')
    })
  })
})
