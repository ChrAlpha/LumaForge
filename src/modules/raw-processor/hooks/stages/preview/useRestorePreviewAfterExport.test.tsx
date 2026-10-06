import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { DecodedImage, ProgressCallback } from '~/lib/raw/decoder'
import type { RawRuntimeSession } from '~/lib/raw/runtime-adapter'

import type { ImageSession } from '../../../model/session'
import type { SetImageSession } from './useRestorePreviewAfterExport'
import { useRestorePreviewAfterExport } from './useRestorePreviewAfterExport'

function createSession(): ImageSession {
  return {
    id: 'session-restore',
    createdAt: 1,
    sourceFile: {
      file: new File(['raw'], 'restore.dng'),
      name: 'restore.dng',
      extension: 'dng',
      sizeBytes: 3,
      metadata: { width: 400, height: 300 },
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
      status: 'ready',
      qualityPreset: 'high',
      fidelityLevel: 'balanced',
      fullResCapability: { status: 'supported', width: 400, height: 300 },
      recovery: { status: 'none' },
      checkpointDurable: false,
      retryRecommended: false,
    },
  }
}

function createDecodedImage(): DecodedImage {
  return {
    width: 640,
    height: 480,
    channels: 4,
    bitsPerChannel: 32,
    data: new Float32Array(640 * 480 * 4),
    layout: 'rgba-float32',
    colorSpace: 'linear-prophoto-rgb',
    source: 'quick',
    metadata: { width: 640, height: 480, make: 'Fuji', model: 'X-T5' },
    renderExposure: {
      ev: 0,
      multiplier: 1,
      source: 'identity',
    },
    timings: { decodeMs: 12 },
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

describe('useRestorePreviewAfterExport', () => {
  it('restores the quick preview for the active exported session', async () => {
    const file = new File(['raw'], 'restore.dng')
    const session = createSession()
    const sessionRef = { current: session }
    const runtimeAbortControllerRef = {
      current: null as AbortController | null,
    }
    const runtimeWorkSessionIdRef = { current: null as string | null }
    const runtimeSessionRef: { current: RawRuntimeSession | null } = {
      current: null,
    }
    const decoded = createDecodedImage()
    const runtimeSession: RawRuntimeSession = {
      sourceDimensions: { width: 640, height: 480 },
      extractEmbeddedPreview: vi.fn(),
      decodeQuickRaw: vi.fn(async (onProgress?: ProgressCallback) => {
        onProgress?.({ phase: 'processing', progress: 42 })
        return decoded
      }),
      decodeBoundedHqRaw: vi.fn(),
      applyCalibration: vi.fn().mockResolvedValue({ applied: true } as const),
      dispose: vi.fn(),
    }
    const openSession = vi.fn().mockResolvedValue(runtimeSession)
    const setStatus = vi.fn()
    const setProgress = vi.fn()
    const setDecodedImageRef = vi.fn()
    const disposeRuntimeSession = vi.fn()

    const { result } = renderHook(() =>
      useRestorePreviewAfterExport({
        loadedFile: file,
        sessionRef,
        isMountedRef: { current: true },
        runtimeAbortControllerRef,
        runtimeWorkSessionIdRef,
        runtimeSessionRef,
        setStatus,
        setProgress,
        setError: vi.fn(),
        setSession: applySessionUpdate(sessionRef),
        setDecodedImageRef,
        abortRuntimeWork: vi.fn(),
        disposeRuntimeSession,
        openSession,
        scheduleToast: vi.fn(),
        toast: { error: vi.fn() },
      }),
    )

    await result.current.restorePreviewAfterExport()

    expect(openSession).toHaveBeenCalledWith(file, expect.any(AbortSignal))
    expect(runtimeSession.decodeQuickRaw).toHaveBeenCalledWith(
      expect.any(Function),
      expect.any(AbortSignal),
    )
    expect(setStatus).toHaveBeenCalledWith('decoding')
    expect(setStatus).toHaveBeenCalledWith('processing')
    expect(setProgress).toHaveBeenCalledWith(42)
    expect(setDecodedImageRef).toHaveBeenCalledWith(decoded, {
      preserveExportResult: true,
    })
    expect(sessionRef.current?.previewBundle.quickDecodePreview).toEqual({
      status: 'ready',
      width: 640,
      height: 480,
      timings: { decodeMs: 12 },
    })
    expect(sessionRef.current?.previewBundle.displaySource).toBe('quick')
    expect(sessionRef.current?.renderState).toEqual({
      status: 'ready',
      lastRenderSource: 'quick',
    })
    expect(sessionRef.current?.sourceFile.metadata).toEqual(decoded.metadata)
    expect(runtimeAbortControllerRef.current).toBeNull()
    expect(runtimeWorkSessionIdRef.current).toBeNull()
    expect(disposeRuntimeSession).toHaveBeenCalledWith(runtimeSession)
  })
})
