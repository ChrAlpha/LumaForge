import type { ProcessingParams } from '@lumaforge/luma-color-runtime'
import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { PipelineStats } from '~/lib/webgpu/raw-processing-pipeline'

import { useRawWorkflowActions } from './useRawWorkflowActions'

const params: ProcessingParams = {
  intensity: 0.7,
  viewMode: 'compare',
  compareSplit: 0.5,
  styleKind: 'none',
  builtinPreset: null,
  userExposureEv: 0,
  userContrast: 0,
  userHighlights: 0,
  userShadows: 0,
  userWhites: 0,
  userBlacks: 0,
  userTemperature: 0,
  userTint: 0,
  userSaturation: 0,
  userVibrance: 0,
}

describe('useRawWorkflowActions', () => {
  it('reads current params from the imperative ref', () => {
    const { result } = renderHook(() =>
      useRawWorkflowActions({
        paramsRef: { current: params },
        isMountedRef: { current: true },
        status: 'ready',
        setError: vi.fn(),
        setStatus: vi.fn(),
        setStats: vi.fn(),
      }),
    )

    expect(result.current.getCurrentProcessingParams()).toBe(params)
  })

  it('runs scheduled toasts only while mounted', () => {
    const queuedTasks: Array<() => void> = []
    const notify = vi.fn()
    const isMountedRef = { current: false }
    const { result } = renderHook(() =>
      useRawWorkflowActions({
        paramsRef: { current: params },
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

  it('dismisses errors and forwards stat updates', () => {
    const setError = vi.fn()
    const setStatus = vi.fn()
    const setStats = vi.fn()
    const stats = { inputSize: { width: 800, height: 600 } } as PipelineStats
    const { result } = renderHook(() =>
      useRawWorkflowActions({
        paramsRef: { current: params },
        isMountedRef: { current: true },
        status: 'error',
        setError,
        setStatus,
        setStats,
      }),
    )

    result.current.dismissError()
    result.current.updateStats(stats)

    expect(setError).toHaveBeenCalledWith(null)
    expect(setStatus).toHaveBeenCalledWith('idle')
    expect(setStats).toHaveBeenCalledWith(stats)
  })
})
