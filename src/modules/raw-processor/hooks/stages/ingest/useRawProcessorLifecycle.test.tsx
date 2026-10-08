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
      fullResCapability: { status: 'unknown' },
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

function applySessionUpdate(store: {
  session: ImageSession | null
}): SetImageSession {
  return (update) => {
    store.session =
      typeof update === 'function' ? update(store.session) : update
  }
}

function renderLifecycle(
  refs: {
    pendingLoadSessionId?: string | null
    session?: ImageSession | null
  },
  options: { reactStrictMode?: boolean } = {},
) {
  const isMountedRef = { current: false }
  const runtimeWorkSessionIdRef = {
    current: 'runtime-work' as string | null,
  }
  const pendingLoadSessionIdRef = {
    current: refs.pendingLoadSessionId ?? null,
  }
  const decodedImageRef = {
    current: createDecodedImage() as DecodedImage | null,
  }
  const previewCopyCanvasRef = { current: null as HTMLCanvasElement | null }
  const store = { session: refs.session ?? null }
  const calls = {
    abortExportWork: vi.fn(),
    abortRuntimeWork: vi.fn(),
    queueExportResultResourceDisposal: vi.fn(),
    revokeCurrentEmbeddedPreviewUrl: vi.fn(),
    setStatus: vi.fn(),
    setError: vi.fn(),
    setProgress: vi.fn(),
    setStats: vi.fn(),
    setSession: vi.fn<SetImageSession>((update) => {
      store.session =
        typeof update === 'function' ? update(store.session) : update
    }),
  }
  const rendered = renderHook(
    () =>
      useRawProcessorLifecycle({
        isMountedRef,
        runtimeWorkSessionIdRef,
        pendingLoadSessionIdRef,
        decodedImageRef,
        previewCopyCanvasRef,
        ...calls,
      }),
    options,
  )
  return {
    ...rendered,
    isMountedRef,
    runtimeWorkSessionIdRef,
    pendingLoadSessionIdRef,
    decodedImageRef,
    store,
    calls,
  }
}

function releaseCounts(calls: ReturnType<typeof renderLifecycle>['calls']) {
  return {
    abortExportWork: calls.abortExportWork.mock.calls.length,
    abortRuntimeWork: calls.abortRuntimeWork.mock.calls.length,
    dispose: calls.queueExportResultResourceDisposal.mock.calls.length,
    revoke: calls.revokeCurrentEmbeddedPreviewUrl.mock.calls.length,
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
    const store = { session: createSession() as ImageSession | null }
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
        abortExportWork,
        abortRuntimeWork,
        queueExportResultResourceDisposal,
        revokeCurrentEmbeddedPreviewUrl,
        setStatus,
        setError,
        setProgress,
        setStats,
        setSession: applySessionUpdate(store),
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
    expect(store.session).toBeNull()
  })

  it('clears only its own pending load, leaving a session a newer load put in the store', () => {
    const newer = createSession('newer-session')
    const lifecycle = renderLifecycle({
      pendingLoadSessionId: 'pending-session',
      session: createSession(),
    })
    // A newer load took the store's slot before this mount departs.
    lifecycle.store.session = newer

    lifecycle.unmount()

    expect(lifecycle.calls.setSession).toHaveBeenCalledTimes(1)
    expect(lifecycle.store.session).toBe(newer)
    expect(lifecycle.decodedImageRef.current).toBeNull()
    expect(lifecycle.calls.setStatus).toHaveBeenCalledWith('idle')
  })

  it("releases a loaded session's resources once on unmount", () => {
    const lifecycle = renderLifecycle({
      session: createSession('loaded-session'),
    })

    lifecycle.unmount()

    expect(releaseCounts(lifecycle.calls)).toEqual({
      abortExportWork: 1,
      abortRuntimeWork: 1,
      dispose: 1,
      revoke: 1,
    })
    expect(lifecycle.isMountedRef.current).toBe(false)
    expect(lifecycle.runtimeWorkSessionIdRef.current).toBeNull()
    // Unmounting is not a reset, so the result owner gets no cleanup reason.
    expect(
      lifecycle.calls.queueExportResultResourceDisposal,
    ).toHaveBeenCalledExactlyOnceWith()
  })

  it('drops its fences before it cancels, so work settling meanwhile writes nothing', () => {
    const lifecycle = renderLifecycle({
      session: createSession('loaded-session'),
    })
    const settled = vi.fn()
    // Outgoing runtime work settles while its owner is being cancelled; it
    // checks the fence the shared release has already dropped.
    lifecycle.calls.abortRuntimeWork.mockImplementation(() => {
      if (lifecycle.runtimeWorkSessionIdRef.current === 'runtime-work') {
        settled()
      }
    })

    lifecycle.unmount()

    expect(settled).not.toHaveBeenCalled()
    expect(lifecycle.pendingLoadSessionIdRef.current).toBeNull()
  })

  it('fences stale work and releases resources before it drops its pending load', () => {
    const order: string[] = []
    const lifecycle = renderLifecycle({
      pendingLoadSessionId: 'pending-session',
      session: createSession(),
    })
    const fenced = () =>
      `mounted=${String(lifecycle.isMountedRef.current)}:runtime=${String(lifecycle.runtimeWorkSessionIdRef.current)}:pending=${String(lifecycle.pendingLoadSessionIdRef.current)}`
    lifecycle.calls.abortExportWork.mockImplementation(() => {
      order.push(`abortExportWork:${fenced()}`)
    })
    lifecycle.calls.abortRuntimeWork.mockImplementation(() => {
      order.push('abortRuntimeWork')
    })
    lifecycle.calls.queueExportResultResourceDisposal.mockImplementation(() => {
      order.push('dispose')
    })
    lifecycle.calls.revokeCurrentEmbeddedPreviewUrl.mockImplementation(() => {
      order.push('revoke')
    })
    lifecycle.calls.setStatus.mockImplementation(() => {
      order.push(
        `setStatus:decoded=${lifecycle.decodedImageRef.current ? 'set' : 'null'}`,
      )
    })
    const applyUpdate = lifecycle.calls.setSession.getMockImplementation()!
    lifecycle.calls.setSession.mockImplementation((update) => {
      order.push('setSession')
      applyUpdate(update)
    })

    lifecycle.unmount()

    expect(order).toEqual([
      'abortExportWork:mounted=false:runtime=null:pending=null',
      'abortRuntimeWork',
      'dispose',
      'revoke',
      'setStatus:decoded=null',
      'setSession',
    ])
    expect(lifecycle.store.session).toBeNull()
  })

  it('leaves a loaded session in the store when the mount departs', () => {
    const loaded = createSession('loaded-session')
    const lifecycle = renderLifecycle({ session: loaded })

    lifecycle.unmount()

    expect(lifecycle.calls.setSession).not.toHaveBeenCalled()
    expect(lifecycle.calls.setStatus).not.toHaveBeenCalled()
    expect(lifecycle.store.session).toBe(loaded)
    expect(lifecycle.decodedImageRef.current).not.toBeNull()
  })

  describe('under StrictMode replay', () => {
    it('runs its cleanup once on mount and ends mounted with the loaded session untouched', () => {
      const loaded = createSession('loaded-session')
      const lifecycle = renderLifecycle(
        { session: loaded },
        { reactStrictMode: true },
      )

      expect(lifecycle.isMountedRef.current).toBe(true)
      expect(releaseCounts(lifecycle.calls)).toEqual({
        abortExportWork: 1,
        abortRuntimeWork: 1,
        dispose: 1,
        revoke: 1,
      })
      expect(lifecycle.calls.setSession).not.toHaveBeenCalled()
      expect(lifecycle.store.session).toBe(loaded)

      // A rerender with the same inputs replays nothing.
      lifecycle.rerender()
      expect(releaseCounts(lifecycle.calls).dispose).toBe(1)
      expect(lifecycle.isMountedRef.current).toBe(true)
    })

    it('drops a pending load once, and the repeated cleanup leaves a replacement source', () => {
      const lifecycle = renderLifecycle(
        {
          pendingLoadSessionId: 'pending-session',
          session: createSession(),
        },
        { reactStrictMode: true },
      )

      // The replay's cleanup dropped the pending load it found.
      expect(lifecycle.calls.setSession).toHaveBeenCalledTimes(1)
      expect(lifecycle.store.session).toBeNull()
      expect(lifecycle.pendingLoadSessionIdRef.current).toBeNull()

      // A replacement source loads and settles before the real unmount.
      const replacement = createSession('replacement-session')
      lifecycle.store.session = replacement
      lifecycle.decodedImageRef.current = createDecodedImage()

      lifecycle.unmount()

      expect(releaseCounts(lifecycle.calls).dispose).toBe(2)
      expect(lifecycle.calls.setSession).toHaveBeenCalledTimes(1)
      expect(lifecycle.store.session).toBe(replacement)
      expect(lifecycle.decodedImageRef.current).not.toBeNull()
    })

    it('runs its cleanup again on the real unmount after the replay', () => {
      const lifecycle = renderLifecycle(
        { session: createSession('loaded-session') },
        { reactStrictMode: true },
      )

      lifecycle.unmount()

      expect(lifecycle.isMountedRef.current).toBe(false)
      expect(releaseCounts(lifecycle.calls)).toEqual({
        abortExportWork: 2,
        abortRuntimeWork: 2,
        dispose: 2,
        revoke: 2,
      })
    })
  })
})
