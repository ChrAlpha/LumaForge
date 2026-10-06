import type { ColorGraphIntent } from '@lumaforge/luma-color-runtime'
import { NEUTRAL_USER_COLOR_INTENT } from '@lumaforge/luma-color-runtime'
import { renderHook } from '@testing-library/react'
import { atom, createStore } from 'jotai'
import { describe, expect, it, vi } from 'vitest'

import type { PreviewView } from '~/lib/preview/preview-view'
import type { PipelineStats } from '~/lib/webgpu/raw-processing-pipeline'

import { useRawWorkflowActions } from './useRawWorkflowActions'

const params: ColorGraphIntent = {
  ...NEUTRAL_USER_COLOR_INTENT,
  intensity: 0.7,
  styleKind: 'none',
  builtinPreset: null,
}
const view: PreviewView = { mode: 'compare', compareSplit: 0.5 }

function createStats(overrides: Partial<PipelineStats> = {}): PipelineStats {
  return {
    uploadTime: 1,
    lutUploadTime: 0,
    processTime: 2,
    totalTime: 3,
    inputSize: { width: 800, height: 600 },
    previewSize: { width: 640, height: 480 },
    inputFormat: 'uint16-rgb',
    transformPath: 'no-lut',
    lutRole: null,
    lutInputTransfer: null,
    lutOutputTransfer: null,
    lutSize: null,
    ...overrides,
  }
}

function renderStatsHarness(status: 'ready' | 'error' = 'ready') {
  const store = createStore()
  const statsAtom = atom<PipelineStats | null>(null)
  const notifications = vi.fn()
  store.sub(statsAtom, notifications)
  const setError = vi.fn()
  const setStatus = vi.fn()
  const { result } = renderHook(() =>
    useRawWorkflowActions({
      paramsRef: { current: params },
      viewRef: { current: view },
      isMountedRef: { current: true },
      status,
      setError,
      setStatus,
      setStats: (update) => store.set(statsAtom, update),
    }),
  )

  return {
    result,
    setError,
    setStatus,
    notifications,
    readStats: () => store.get(statsAtom),
  }
}

describe('useRawWorkflowActions', () => {
  it('reads the current color intent and view from their own refs as separate ports', () => {
    const paramsRef = {
      current: { ...params, intensity: 0.37, userContrast: 12 },
    }
    const viewRef = {
      current: { mode: 'original', compareSplit: 0.62 } as PreviewView,
    }
    const { result } = renderHook(() =>
      useRawWorkflowActions({
        paramsRef,
        viewRef,
        isMountedRef: { current: true },
        status: 'ready',
        setError: vi.fn(),
        setStatus: vi.fn(),
        setStats: vi.fn(),
      }),
    )

    const colorIntent = result.current.getCurrentColorIntent()
    expect(colorIntent).toMatchObject({ intensity: 0.37, userContrast: 12 })
    expect(colorIntent).not.toHaveProperty('viewMode')
    expect(colorIntent).not.toHaveProperty('compareSplit')
    expect(result.current.getCurrentView()).toEqual({
      mode: 'original',
      compareSplit: 0.62,
    })

    // The ports read the refs when called, not the render that made them.
    paramsRef.current = { ...paramsRef.current, intensity: 0.62 }
    viewRef.current = { mode: 'compare', compareSplit: 0.2 }
    expect(result.current.getCurrentColorIntent().intensity).toBe(0.62)
    expect(result.current.getCurrentView()).toEqual({
      mode: 'compare',
      compareSplit: 0.2,
    })
  })

  it('runs scheduled toasts only while mounted', () => {
    const queuedTasks: Array<() => void> = []
    const notify = vi.fn()
    const isMountedRef = { current: false }
    const { result } = renderHook(() =>
      useRawWorkflowActions({
        paramsRef: { current: params },
        viewRef: { current: view },
        isMountedRef,
        status: 'ready',
        setError: vi.fn(),
        setStatus: vi.fn(),
        setStats: vi.fn(),
        postCommitTask: (task) => queuedTasks.push(task),
      }),
    )

    result.current.scheduleToast(notify)
    queuedTasks.pop()?.()
    expect(notify).not.toHaveBeenCalled()

    isMountedRef.current = true
    result.current.scheduleToast(notify)
    queuedTasks.pop()?.()
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('dismisses errors and publishes only changed stat updates', () => {
    const { result, setError, setStatus, notifications, readStats } =
      renderStatsHarness('error')

    result.current.dismissError()

    expect(setError).toHaveBeenCalledWith(null)
    expect(setStatus).toHaveBeenCalledWith('idle')

    const stats = createStats()
    result.current.updateStats(stats)

    expect(readStats()).toBe(stats)
    expect(notifications).toHaveBeenCalledTimes(1)

    const equalStats = createStats()
    expect(equalStats).not.toBe(stats)
    expect(equalStats.inputSize).not.toBe(stats.inputSize)
    expect(equalStats.previewSize).not.toBe(stats.previewSize)
    result.current.updateStats(equalStats)

    expect(readStats()).toBe(stats)
    expect(notifications).toHaveBeenCalledTimes(1)

    const changedTiming = createStats({ processTime: 2.5 })
    result.current.updateStats(changedTiming)

    expect(readStats()).toBe(changedTiming)
    expect(notifications).toHaveBeenCalledTimes(2)

    const changedDimension = createStats({
      processTime: 2.5,
      previewSize: { width: 640, height: 481 },
    })
    result.current.updateStats(changedDimension)

    expect(readStats()).toBe(changedDimension)
    expect(notifications).toHaveBeenCalledTimes(3)
  })

  it.each<[string, Partial<PipelineStats>]>([
    ['uploadTime', { uploadTime: 1.5 }],
    ['lutUploadTime', { lutUploadTime: 0.5 }],
    ['processTime', { processTime: 2.5 }],
    ['totalTime', { totalTime: 3.5 }],
    ['inputSize.width', { inputSize: { width: 801, height: 600 } }],
    ['inputSize.height', { inputSize: { width: 800, height: 601 } }],
    ['previewSize.width', { previewSize: { width: 641, height: 480 } }],
    ['previewSize.height', { previewSize: { width: 640, height: 481 } }],
    ['inputFormat', { inputFormat: 'float-rgba' }],
    ['transformPath', { transformPath: 'display-lut' }],
    ['lutRole', { lutRole: 'display-look' }],
    ['lutInputTransfer', { lutInputTransfer: 's-log3' }],
    ['lutOutputTransfer', { lutOutputTransfer: 's-log3' }],
    ['lutSize', { lutSize: 33 }],
  ])('publishes a stat update when %s changes', (_field, overrides) => {
    const { result, notifications, readStats } = renderStatsHarness()

    result.current.updateStats(createStats())
    const changed = createStats(overrides)
    result.current.updateStats(changed)

    expect(readStats()).toBe(changed)
    expect(notifications).toHaveBeenCalledTimes(2)
  })
})
