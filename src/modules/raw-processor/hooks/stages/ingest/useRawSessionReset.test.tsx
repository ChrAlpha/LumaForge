import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { useRawSessionReset } from './useRawSessionReset'

describe('useRawSessionReset', () => {
  it('clears RAW workflow refs and resets session state', () => {
    const runtimeWorkSessionIdRef = { current: 'runtime-session' }
    const pendingLoadSessionIdRef = { current: 'pending-session' }
    const previewCopyCanvasRef = {
      current: document.createElement('canvas') as HTMLCanvasElement | null,
    }
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

    const { result } = renderHook(() =>
      useRawSessionReset({
        runtimeWorkSessionIdRef,
        pendingLoadSessionIdRef,
        previewCopyCanvasRef: { current: null },
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
          order.push('resetSession')
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
      'resetSession',
    ])
  })

  it('clears workflow state before it drops the session, with the store reset last', () => {
    const order: string[] = []
    const record = (name: string) =>
      vi.fn((...args: unknown[]) => {
        order.push(args.length ? `${name}:${String(args[0])}` : name)
      })
    const runtimeWorkSessionIdRef = {
      current: 'runtime-session' as string | null,
    }
    const pendingLoadSessionIdRef = {
      current: 'pending-session' as string | null,
    }
    const previewCopyCanvasRef = {
      current: document.createElement('canvas') as HTMLCanvasElement | null,
    }
    const { result } = renderHook(() =>
      useRawSessionReset({
        runtimeWorkSessionIdRef,
        pendingLoadSessionIdRef,
        previewCopyCanvasRef,
        abortExportWork: record('abortExportWork'),
        abortRuntimeWork: record('abortRuntimeWork'),
        queueExportResultResourceDisposal: record('dispose'),
        revokeCurrentEmbeddedPreviewUrl: vi.fn(() => {
          order.push(
            `revoke:canvas=${previewCopyCanvasRef.current ? 'set' : 'null'}`,
          )
        }),
        setDecodedImageRef: vi.fn((decoded: unknown) => {
          order.push(
            `setDecodedImageRef:${String(decoded)}:canvas=${previewCopyCanvasRef.current ? 'set' : 'null'}`,
          )
        }),
        setStatus: record('setStatus'),
        setError: record('setError'),
        setProgress: record('setProgress'),
        setStats: record('setStats'),
        resetSession: record('resetSession'),
      }),
    )

    result.current.reset()

    expect(order).toEqual([
      'abortExportWork',
      'abortRuntimeWork',
      'dispose:reset-session',
      'revoke:canvas=set',
      'setDecodedImageRef:null:canvas=null',
      'setStatus:idle',
      'setError:null',
      'setProgress:0',
      'setStats:null',
      'resetSession',
    ])
  })

  it('fences the refs a later load wrote when a reset from an earlier render runs', () => {
    const runtimeWorkSessionIdRef = { current: null as string | null }
    const pendingLoadSessionIdRef = { current: null as string | null }
    const previewCopyCanvasRef = {
      current: null as HTMLCanvasElement | null,
    }
    const resetSession = vi.fn()
    const { result } = renderHook(() =>
      useRawSessionReset({
        runtimeWorkSessionIdRef,
        pendingLoadSessionIdRef,
        previewCopyCanvasRef,
        abortExportWork: vi.fn(),
        abortRuntimeWork: vi.fn(),
        queueExportResultResourceDisposal: vi.fn(),
        revokeCurrentEmbeddedPreviewUrl: vi.fn(),
        setDecodedImageRef: vi.fn(),
        setStatus: vi.fn(),
        setError: vi.fn(),
        setProgress: vi.fn(),
        setStats: vi.fn(),
        resetSession,
      }),
    )
    const { reset } = result.current

    // A load wrote its refs synchronously, before any rerender.
    runtimeWorkSessionIdRef.current = 'session-1'
    pendingLoadSessionIdRef.current = 'session-1'
    previewCopyCanvasRef.current = document.createElement('canvas')

    reset()

    expect(runtimeWorkSessionIdRef.current).toBeNull()
    expect(pendingLoadSessionIdRef.current).toBeNull()
    expect(previewCopyCanvasRef.current).toBeNull()
    expect(resetSession).toHaveBeenCalledTimes(1)
  })

  it('repeats the release on every reset and leaves what is left to free to the owners', () => {
    const order: string[] = []
    const record = (name: string) =>
      vi.fn((...args: unknown[]) => {
        order.push(args.length ? `${name}:${String(args[0])}` : name)
      })
    const { result } = renderHook(() =>
      useRawSessionReset({
        runtimeWorkSessionIdRef: { current: 'session-1' },
        pendingLoadSessionIdRef: { current: null },
        previewCopyCanvasRef: { current: null },
        abortExportWork: record('abortExportWork'),
        abortRuntimeWork: record('abortRuntimeWork'),
        queueExportResultResourceDisposal: record('dispose'),
        revokeCurrentEmbeddedPreviewUrl: record('revoke'),
        setDecodedImageRef: vi.fn(),
        setStatus: vi.fn(),
        setError: vi.fn(),
        setProgress: vi.fn(),
        setStats: vi.fn(),
        resetSession: record('resetSession'),
      }),
    )

    result.current.reset()
    result.current.reset()

    const once = [
      'abortExportWork',
      'abortRuntimeWork',
      'dispose:reset-session',
      'revoke',
      'resetSession',
    ]
    expect(order).toEqual([...once, ...once])
  })

  it('runs nothing on mount or StrictMode replay, only when called', () => {
    const effects = {
      abortExportWork: vi.fn(),
      abortRuntimeWork: vi.fn(),
      queueExportResultResourceDisposal: vi.fn(),
      revokeCurrentEmbeddedPreviewUrl: vi.fn(),
      setDecodedImageRef: vi.fn(),
      resetSession: vi.fn(),
    }
    const { result, rerender, unmount } = renderHook(
      () =>
        useRawSessionReset({
          runtimeWorkSessionIdRef: { current: 'session-1' },
          pendingLoadSessionIdRef: { current: null },
          previewCopyCanvasRef: { current: null },
          setStatus: vi.fn(),
          setError: vi.fn(),
          setProgress: vi.fn(),
          setStats: vi.fn(),
          ...effects,
        }),
      { reactStrictMode: true },
    )
    rerender()

    for (const effect of Object.values(effects)) {
      expect(effect).not.toHaveBeenCalled()
    }

    result.current.reset()
    unmount()

    for (const effect of Object.values(effects)) {
      expect(effect).toHaveBeenCalledTimes(1)
    }
  })
})
