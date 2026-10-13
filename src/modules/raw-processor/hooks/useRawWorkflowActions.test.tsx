import { renderHook } from '@testing-library/react'
import { atom, createStore } from 'jotai'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from 'vitest'

import type { PreviewView } from '~/lib/preview/preview-view'
import type { PipelineStats } from '~/lib/webgpu/raw-processing-pipeline'

import {
  PIPELINE_TIMING_PUBLISH_MS,
  useRawWorkflowActions,
} from './useRawWorkflowActions'

const view: PreviewView = { mode: 'compare', compareSplit: 0.5 }

function createStats(overrides: Partial<PipelineStats> = {}): PipelineStats {
  return {
    processTime: 2,
    inputSize: { width: 800, height: 600 },
    previewSize: { width: 640, height: 480 },
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
      viewRef: { current: view },
      isMountedRef: { current: true },
      status,
      setError,
      setStatus,
      setStats: (update) => store.set(statsAtom, update),
      getStats: () => store.get(statsAtom),
    }),
  )

  return {
    result,
    setError,
    setStatus,
    notifications,
    readStats: () => store.get(statsAtom),
    resetStats: () => store.set(statsAtom, null),
  }
}

describe('useRawWorkflowActions', () => {
  it('reads the current view from its ref and offers no color port', () => {
    const viewRef = {
      current: { mode: 'original', compareSplit: 0.62 } as PreviewView,
    }
    const { result } = renderHook(() =>
      useRawWorkflowActions({
        viewRef,
        isMountedRef: { current: true },
        status: 'ready',
        setError: vi.fn(),
        setStatus: vi.fn(),
        setStats: vi.fn(),
        getStats: () => null,
      }),
    )

    expect(result.current.getCurrentView()).toEqual({
      mode: 'original',
      compareSplit: 0.62,
    })
    // The port reads the ref when called, not the render that made it, and
    // hands out the view its owner holds, with nothing composed onto it.
    viewRef.current = { mode: 'compare', compareSplit: 0.2 }
    expect(result.current.getCurrentView()).toBe(viewRef.current)
    expect(result.current.getCurrentView()).toEqual({
      mode: 'compare',
      compareSplit: 0.2,
    })

    // Color is read from the store by its readers; the view port neither
    // takes nor hands out a color intent.
    expect(result.current).not.toHaveProperty('getCurrentColorIntent')
    type ActionsInput = Parameters<typeof useRawWorkflowActions>[0]
    expectTypeOf<ActionsInput>().not.toHaveProperty('paramsRef')
  })

  it('runs scheduled toasts only while mounted', () => {
    const queuedTasks: Array<() => void> = []
    const notify = vi.fn()
    const isMountedRef = { current: false }
    const { result } = renderHook(() =>
      useRawWorkflowActions({
        viewRef: { current: view },
        isMountedRef,
        status: 'ready',
        setError: vi.fn(),
        setStatus: vi.fn(),
        setStats: vi.fn(),
        getStats: () => null,
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

    const changedDimension = createStats({
      processTime: 2.5,
      previewSize: { width: 640, height: 481 },
    })
    result.current.updateStats(changedDimension)

    expect(readStats()).toBe(changedDimension)
    expect(notifications).toHaveBeenCalledTimes(2)
  })

  describe('render timings', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it('publishes a timing change alone on a trailing beat with the latest timing', () => {
      const { result, notifications, readStats } = renderStatsHarness()
      const first = createStats()
      result.current.updateStats(first)

      result.current.updateStats(createStats({ processTime: 2.5 }))
      const latest = createStats({ processTime: 9 })
      result.current.updateStats(latest)
      expect(readStats()).toBe(first)

      vi.advanceTimersByTime(PIPELINE_TIMING_PUBLISH_MS)
      expect(readStats()).toBe(latest)
      expect(notifications).toHaveBeenCalledTimes(2)
    })

    it('publishes a pipeline change at once and drops the timings it outdates', () => {
      const { result, notifications, readStats } = renderStatsHarness()
      result.current.updateStats(createStats())
      result.current.updateStats(createStats({ processTime: 4 }))

      const resized = createStats({
        processTime: 5,
        previewSize: { width: 641, height: 480 },
      })
      result.current.updateStats(resized)
      expect(readStats()).toBe(resized)

      vi.advanceTimersByTime(PIPELINE_TIMING_PUBLISH_MS)
      expect(readStats()).toBe(resized)
      expect(notifications).toHaveBeenCalledTimes(2)
    })

    it('does not bring timings back over a reset', () => {
      const { result, readStats, resetStats } = renderStatsHarness()
      result.current.updateStats(createStats())
      result.current.updateStats(createStats({ processTime: 4 }))
      resetStats()

      vi.advanceTimersByTime(PIPELINE_TIMING_PUBLISH_MS)
      expect(readStats()).toBeNull()
    })
  })

  it.each<[string, Partial<PipelineStats>]>([
    ['inputSize.width', { inputSize: { width: 801, height: 600 } }],
    ['inputSize.height', { inputSize: { width: 800, height: 601 } }],
    ['previewSize.width', { previewSize: { width: 641, height: 480 } }],
    ['previewSize.height', { previewSize: { width: 640, height: 481 } }],
  ])('publishes a pipeline change to %s at once', (_field, overrides) => {
    const { result, notifications, readStats } = renderStatsHarness()

    result.current.updateStats(createStats())
    const changed = createStats(overrides)
    result.current.updateStats(changed)

    expect(readStats()).toBe(changed)
    expect(notifications).toHaveBeenCalledTimes(2)
  })
})
