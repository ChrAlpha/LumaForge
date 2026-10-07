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
      fullResCapability: { status: 'unknown' },
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

  it('fences stale work before releasing resources and dropping the session', () => {
    const order: string[] = []
    const runtimeWorkSessionIdRef = {
      current: 'runtime-session' as string | null,
    }
    const pendingLoadSessionIdRef = {
      current: 'pending-session' as string | null,
    }
    const record = (name: string) =>
      vi.fn(() => {
        order.push(name)
      })
    const sessionRef = { current: createSession() as ImageSession | null }

    const { result } = renderHook(() =>
      useRawSessionReset({
        runtimeWorkSessionIdRef,
        pendingLoadSessionIdRef,
        previewCopyCanvasRef: { current: null },
        sessionRef,
        abortExportWork: vi.fn(() => {
          order.push(
            `abortExportWork:${String(runtimeWorkSessionIdRef.current)}:${String(pendingLoadSessionIdRef.current)}`,
          )
        }),
        abortRuntimeWork: record('abortRuntimeWork'),
        queueExportResultResourceDisposal: record('dispose'),
        revokeCurrentEmbeddedPreviewUrl: record('revoke'),
        setDecodedImageRef: record('setDecodedImageRef'),
        setStatus: vi.fn(),
        setError: vi.fn(),
        setProgress: vi.fn(),
        setStats: vi.fn(),
        resetSession: vi.fn(() => {
          order.push(`resetSession:${String(sessionRef.current?.id)}`)
        }),
      }),
    )

    result.current.reset()

    expect(order).toEqual([
      'abortExportWork:null:null',
      'abortRuntimeWork',
      'dispose',
      'revoke',
      'setDecodedImageRef',
      'resetSession:session-1',
    ])
    expect(sessionRef.current).toBeNull()
  })
})
