import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { SourceInterruptionHint } from '../../../services/export/export-recovery'
import { getExportInterruptionMarkers } from '../../../services/export/export-recovery'
import { useExportRecoveryState } from './useExportRecoveryState'

describe('useExportRecoveryState', () => {
  it('keeps the interruption hint mirrored into the imperative ref', () => {
    const { result } = renderHook(() => useExportRecoveryState())
    const next: SourceInterruptionHint = {
      source: '["frame.dng",3,123]',
      hint: {
        previousCrashLikeInterruption: true,
        previousResourceFailure: false,
        attempts: ['attempt-a'],
      },
    }

    expect(result.current.exportInterruption).toBeNull()
    expect(result.current.exportInterruptionRef.current).toBeNull()
    expect(result.current.pendingRecoveryRetry).toBeNull()

    act(() => {
      result.current.setExportInterruption(next)
    })

    expect(result.current.exportInterruption).toBe(next)
    expect(result.current.exportInterruptionRef.current).toBe(next)
  })

  it('shares the page markers and counts refresh requests', () => {
    const { result } = renderHook(() => useExportRecoveryState())

    expect(result.current.interruptionMarkers).toBe(
      getExportInterruptionMarkers(),
    )
    expect(result.current.interruptionCheck).toBe(0)

    act(() => {
      result.current.refreshExportInterruption()
    })

    expect(result.current.interruptionCheck).toBe(1)
  })
})
