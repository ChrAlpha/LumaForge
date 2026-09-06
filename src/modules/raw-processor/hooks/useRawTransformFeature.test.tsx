import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PreviewSource } from '~/modules/transform-demo/preview-types'

import { captureTransformSource } from '../services/preview/capture-transform-source'
import { useRawTransformFeature } from './useRawTransformFeature'
import type { UseRawWorkflowReturn } from './useRawWorkflow.types'

const demo = vi.hoisted(() => ({
  loadSource: vi.fn(),
  clearSource: vi.fn(),
  reset: vi.fn(),
  setMode: vi.fn(),
  setManual: vi.fn(),
  setConstrainCrop: vi.fn(),
  mode: 'off',
  manual: {
    vertical: 0,
    horizontal: 0,
    rotate: 0,
    aspect: 0,
    scale: 100,
    offsetX: 0,
    offsetY: 0,
  },
  result: null,
  source: null,
  loading: false,
  rendering: false,
  error: null,
}))
vi.mock('~/modules/transform-demo/useTransformDemo', () => ({
  useTransformDemo: () => demo,
}))
vi.mock(
  '../services/preview/capture-transform-source',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('../services/preview/capture-transform-source')
    >()),
    captureTransformSource: vi.fn(),
  }),
)

function workflow(): UseRawWorkflowReturn {
  return {
    hasImage: true,
    sourceFileName: 'current.nef',
    status: 'ready',
    decodedImageVersion: 1,
    lutDataVersion: 1,
    decodedImageRef: { current: { width: 80, height: 60 } },
    pipelineRef: { current: {} },
    params: { viewMode: 'processed', compareSplit: 0.5, userExposureEv: 0 },
    previewTransform: { sourceId: 'one', active: false, setActive: vi.fn() },
    setViewMode: vi.fn(),
  } as unknown as UseRawWorkflowReturn
}
const frame: PreviewSource = {
  name: 'current.nef',
  kind: 'raw',
  originalWidth: 80,
  originalHeight: 60,
  frame: { width: 80, height: 60, data: new Uint8ClampedArray(80 * 60 * 4) },
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.mocked(captureTransformSource).mockResolvedValue(frame)
})
afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('rAW Transform feature', () => {
  it('clears transient geometry on leaving the workspace without invalidating neutral exports', () => {
    const active = workflow()
    active.previewTransform!.active = true
    const first = renderHook(() => useRawTransformFeature(active, false))
    first.unmount()
    expect(active.previewTransform!.setActive).toHaveBeenCalledWith(false)
    const neutral = workflow()
    const second = renderHook(() => useRawTransformFeature(neutral, false))
    second.unmount()
    expect(neutral.previewTransform!.setActive).not.toHaveBeenCalled()
  })

  it('captures on demand and refreshes color without reopening the photo or resetting geometry', async () => {
    const initial = workflow()
    const { result, rerender, unmount } = renderHook(
      ({ input }) => useRawTransformFeature(input, false),
      { initialProps: { input: initial } },
    )
    await act(() => vi.advanceTimersByTimeAsync(150))
    expect(captureTransformSource).not.toHaveBeenCalled()
    act(() => {
      result.current.observe()
    })
    await act(() => vi.advanceTimersByTimeAsync(150))
    expect(demo.loadSource).toHaveBeenLastCalledWith(frame, {
      preserveTransform: true,
    })
    rerender({
      input: {
        ...initial,
        params: { ...initial.params, viewMode: 'compare', compareSplit: 0.2 },
      },
    })
    await act(() => vi.advanceTimersByTimeAsync(150))
    expect(captureTransformSource).toHaveBeenCalledTimes(1)
    rerender({
      input: { ...initial, params: { ...initial.params, userExposureEv: 1 } },
    })
    await act(() => vi.advanceTimersByTimeAsync(150))
    expect(captureTransformSource).toHaveBeenCalledTimes(2)
    act(() => result.current.setMode('vertical'))
    expect(initial.previewTransform?.setActive).toHaveBeenCalledWith(true)
    expect(initial.setViewMode).toHaveBeenCalledWith('processed')
    unmount()
  })

  it('discards a capture completed after the RAW session was replaced', async () => {
    let complete!: (source: PreviewSource) => void
    vi.mocked(captureTransformSource).mockReturnValueOnce(
      new Promise((resolve) => {
        complete = resolve
      }),
    )
    const initial = workflow()
    const { result, rerender, unmount } = renderHook(
      ({ input }) => useRawTransformFeature(input, false),
      { initialProps: { input: initial } },
    )
    act(() => {
      result.current.observe()
    })
    await act(() => vi.advanceTimersByTimeAsync(150))
    rerender({
      input: {
        ...initial,
        previewTransform: { ...initial.previewTransform!, sourceId: 'two' },
      },
    })
    await act(async () => {
      complete(frame)
      await Promise.resolve()
    })
    expect(demo.loadSource).not.toHaveBeenCalled()
    expect(demo.clearSource).toHaveBeenCalledTimes(2)
    unmount()
  })

  it('waits for the current processed CPU frame', async () => {
    const input = workflow()
    const { result, unmount } = renderHook(() =>
      useRawTransformFeature(input, true),
    )
    act(() => {
      result.current.observe()
    })
    await act(() => vi.advanceTimersByTimeAsync(150))
    expect(captureTransformSource).not.toHaveBeenCalled()
    const cpuFrame = {
      requestId: 1,
      sourceId: 'v1:80x60:123',
      width: 80,
      height: 60,
      rgba: frame.frame.data,
    }
    act(() => result.current.setCpuFrame(cpuFrame))
    await act(() => vi.advanceTimersByTimeAsync(150))
    expect(captureTransformSource).toHaveBeenCalledWith(
      expect.objectContaining({ pipeline: null, cpuFrame }),
    )
    unmount()
  })

  it('retains the current RAW CPU frame across HQ upgrades, then clears it for a new session', async () => {
    const input = workflow()
    const { result, rerender, unmount } = renderHook(
      ({ value }) => useRawTransformFeature(value, true),
      { initialProps: { value: input } },
    )
    act(() => {
      result.current.observe()
      result.current.setCpuFrame({
        requestId: 1,
        sourceId: 'v1:80x60:123',
        width: 80,
        height: 60,
        rgba: frame.frame.data,
      })
    })
    await act(() => vi.advanceTimersByTimeAsync(150))
    expect(result.current.available).toBe(true)
    rerender({ value: { ...input, decodedImageVersion: 2 } })
    await act(() => vi.advanceTimersByTimeAsync(150))
    expect(result.current.available).toBe(true)
    expect(captureTransformSource).toHaveBeenCalledTimes(2)
    rerender({
      value: {
        ...input,
        decodedImageVersion: 3,
        previewTransform: {
          ...input.previewTransform!,
          sourceId: 'replacement',
        },
      },
    })
    await act(() => vi.advanceTimersByTimeAsync(150))
    expect(result.current.available).toBe(false)
    expect(captureTransformSource).toHaveBeenCalledTimes(2)
    unmount()
  })
})
