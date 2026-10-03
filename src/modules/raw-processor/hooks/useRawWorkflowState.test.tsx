import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { useRawWorkflowState } from './useRawWorkflowState'

describe('useRawWorkflowState', () => {
  it('exposes transient workflow status, progress, error, and stats', () => {
    const { result } = renderHook(() => useRawWorkflowState())

    expect(result.current.status).toBe('idle')
    expect(result.current.error).toBeNull()
    expect(result.current.progress).toBe(0)
    expect(result.current.stats).toBeNull()

    const stats = {
      uploadTime: 1,
      lutUploadTime: 0,
      processTime: 2,
      totalTime: 3,
      inputSize: { width: 100, height: 50 },
      previewSize: { width: 100, height: 50 },
      inputFormat: 'uint16-rgb' as const,
      transformPath: 'no-lut' as const,
      lutRole: null,
      lutInputTransfer: null,
      lutOutputTransfer: null,
      lutSize: null,
    }

    act(() => {
      result.current.setStatus('processing')
      result.current.setError('Decode failed')
      result.current.setProgress(42)
      result.current.setStats(stats)
    })

    expect(result.current.status).toBe('processing')
    expect(result.current.error).toBe('Decode failed')
    expect(result.current.progress).toBe(42)
    expect(result.current.stats).toBe(stats)
  })
})
