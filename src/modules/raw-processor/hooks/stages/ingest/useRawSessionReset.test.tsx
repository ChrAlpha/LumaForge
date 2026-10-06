import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { ImageSession } from '../../../model/session'
import { useRawSessionReset } from './useRawSessionReset'

function createSession(): ImageSession {
  return {
    id: 'session-1',
    createdAt: 1,
    sourceFile: {
      name: 'frame.dng',
      extension: 'dng',
      sizeBytes: 3,
      supportLevel: 'experimental',
    },
    previewBundle: {
      embeddedPreview: { status: 'idle' },
      quickDecodePreview: { status: 'idle' },
      boundedHqPreview: { status: 'idle' },
      displaySource: 'none',
      boundedHqRequiredForExport: false,
    },
    activeStyle: null,
    viewState: {
      mode: 'processed',
      compareSplit: 0.5,
      zoom: 1,
      panX: 0,
      panY: 0,
      fitMode: 'screen',
    },
    renderState: { status: 'idle' },
    exportState: {
      status: 'idle',
      qualityPreset: 'high',
      fidelityLevel: 'balanced',
      fullResCapability: { status: 'unknown' },
      recovery: { status: 'none' },
      checkpointDurable: false,
      retryRecommended: false,
    },
  }
}

describe('useRawSessionReset', () => {
  it('clears RAW workflow refs and resets session state', () => {
    const runtimeWorkSessionIdRef = { current: 'runtime-session' }
    const pendingLoadSessionIdRef = { current: 'pending-session' }
    const previewCopyCanvasRef = {
      current: document.createElement('canvas') as HTMLCanvasElement | null,
    }
    const sessionRef = { current: createSession() }
    const setPendingRecoveryRetry = vi.fn()
    const abortExportWork = vi.fn()
    const abortRuntimeWork = vi.fn()
    const queueExportResultResourceDisposal = vi.fn()
    const revokeCurrentEmbeddedPreviewUrl = vi.fn()
    const setDecodedImageRef = vi.fn()
    const setStatus = vi.fn()
    const setError = vi.fn()
    const setProgress = vi.fn()
    const setStats = vi.fn()
    const resetSession = vi.fn()

    const { result } = renderHook(() =>
      useRawSessionReset({
        runtimeWorkSessionIdRef,
        pendingLoadSessionIdRef,
        previewCopyCanvasRef,
        sessionRef,
        setPendingRecoveryRetry,
        abortExportWork,
        abortRuntimeWork,
        queueExportResultResourceDisposal,
        revokeCurrentEmbeddedPreviewUrl,
        setDecodedImageRef,
        setStatus,
        setError,
        setProgress,
        setStats,
        resetSession,
      }),
    )

    result.current.reset()

    expect(runtimeWorkSessionIdRef.current).toBeNull()
    expect(pendingLoadSessionIdRef.current).toBeNull()
    expect(setPendingRecoveryRetry).toHaveBeenCalledWith(null)
    expect(abortExportWork).toHaveBeenCalledTimes(1)
    expect(abortRuntimeWork).toHaveBeenCalledTimes(1)
    expect(queueExportResultResourceDisposal).toHaveBeenCalledWith(
      'reset-session',
    )
    expect(revokeCurrentEmbeddedPreviewUrl).toHaveBeenCalledTimes(1)
    expect(previewCopyCanvasRef.current).toBeNull()
    expect(setDecodedImageRef).toHaveBeenCalledWith(null)
    expect(setStatus).toHaveBeenCalledWith('idle')
    expect(setError).toHaveBeenCalledWith(null)
    expect(setProgress).toHaveBeenCalledWith(0)
    expect(setStats).toHaveBeenCalledWith(null)
    expect(resetSession).toHaveBeenCalledTimes(1)
    expect(sessionRef.current).toBeNull()
  })
})
