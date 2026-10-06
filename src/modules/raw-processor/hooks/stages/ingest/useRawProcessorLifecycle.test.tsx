import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { DecodedImage } from '~/lib/raw/decoder'

import type { ImageSession } from '../../../model/session'
import type { SetImageSession } from './useRawProcessorLifecycle'
import { useRawProcessorLifecycle } from './useRawProcessorLifecycle'

function createSession(id = 'pending-session'): ImageSession {
  return {
    id,
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

function createDecodedImage(): DecodedImage {
  return {
    width: 1,
    height: 1,
    channels: 4,
    bitsPerChannel: 32,
    data: new Float32Array(4),
    layout: 'rgba-float32',
    colorSpace: 'linear-prophoto-rgb',
    source: 'quick',
    metadata: { width: 1, height: 1 },
    renderExposure: { ev: 0, multiplier: 1, source: 'identity' },
  }
}

function applySessionUpdate(sessionRef: {
  current: ImageSession | null
}): SetImageSession {
  return (update) => {
    sessionRef.current =
      typeof update === 'function' ? update(sessionRef.current) : update
  }
}

describe('useRawProcessorLifecycle', () => {
  it('marks the processor mounted and cleans up pending load state on unmount', () => {
    const isMountedRef = { current: false }
    const runtimeWorkSessionIdRef = { current: 'runtime-work' }
    const pendingLoadSessionIdRef = { current: 'pending-session' }
    const decodedImageRef = { current: createDecodedImage() }
    const previewCopyCanvasRef = {
      current: document.createElement('canvas') as HTMLCanvasElement | null,
    }
    const sessionRef = { current: createSession() }
    const abortExportWork = vi.fn()
    const abortRuntimeWork = vi.fn()
    const queueExportResultResourceDisposal = vi.fn()
    const revokeCurrentEmbeddedPreviewUrl = vi.fn()
    const setStatus = vi.fn()
    const setError = vi.fn()
    const setProgress = vi.fn()
    const setStats = vi.fn()

    const { unmount } = renderHook(() =>
      useRawProcessorLifecycle({
        isMountedRef,
        runtimeWorkSessionIdRef,
        pendingLoadSessionIdRef,
        decodedImageRef,
        previewCopyCanvasRef,
        sessionRef,
        abortExportWork,
        abortRuntimeWork,
        queueExportResultResourceDisposal,
        revokeCurrentEmbeddedPreviewUrl,
        setStatus,
        setError,
        setProgress,
        setStats,
        setSession: applySessionUpdate(sessionRef),
      }),
    )

    expect(isMountedRef.current).toBe(true)

    unmount()

    expect(isMountedRef.current).toBe(false)
    expect(runtimeWorkSessionIdRef.current).toBeNull()
    expect(pendingLoadSessionIdRef.current).toBeNull()
    expect(abortExportWork).toHaveBeenCalledTimes(1)
    expect(abortRuntimeWork).toHaveBeenCalledTimes(1)
    expect(queueExportResultResourceDisposal).toHaveBeenCalledTimes(1)
    expect(revokeCurrentEmbeddedPreviewUrl).toHaveBeenCalledTimes(1)
    expect(previewCopyCanvasRef.current).toBeNull()
    expect(decodedImageRef.current).toBeNull()
    expect(setStatus).toHaveBeenCalledWith('idle')
    expect(setError).toHaveBeenCalledWith(null)
    expect(setProgress).toHaveBeenCalledWith(0)
    expect(setStats).toHaveBeenCalledWith(null)
    expect(sessionRef.current).toBeNull()
  })
})
