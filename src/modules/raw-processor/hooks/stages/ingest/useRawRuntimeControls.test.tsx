import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { createRawRuntimeSessionLeases } from '~/lib/raw/raw-runtime-host'
import type { RawRuntimeSession } from '~/lib/raw/runtime-adapter'

import { useRawRuntimeControls } from './useRawRuntimeControls'

function createRuntimeSession(): RawRuntimeSession {
  return {
    sourceDimensions: {},
    extractEmbeddedPreview: vi.fn(),
    decodeQuickRaw: vi.fn(),
    decodeBoundedHqRaw: vi.fn(),
    applyCalibration: vi.fn().mockResolvedValue({ applied: true } as const),
    dispose: vi.fn(),
  }
}

function createInput(
  overrides: Partial<Parameters<typeof useRawRuntimeControls>[0]> = {},
): Parameters<typeof useRawRuntimeControls>[0] {
  return {
    cancelHostSession: vi.fn(),
    runtimeSessionRef: { current: null },
    runtimeAbortControllerRef: { current: null },
    runtimeWorkSessionIdRef: { current: null },
    exportAbortControllerRef: { current: null },
    disposedRuntimeSessionsRef: { current: new WeakSet<RawRuntimeSession>() },
    ...overrides,
  }
}

describe('useRawRuntimeControls', () => {
  it('disposes each restore session once and clears the active session ref', () => {
    const runtimeSession = createRuntimeSession()
    const runtimeSessionRef = { current: runtimeSession }

    const { result } = renderHook(() =>
      useRawRuntimeControls(createInput({ runtimeSessionRef })),
    )

    result.current.disposeRuntimeSession(runtimeSession)
    result.current.disposeRuntimeSession(runtimeSession)

    expect(runtimeSession.dispose).toHaveBeenCalledTimes(1)
    expect(runtimeSessionRef.current).toBeNull()
  })

  it('aborts active runtime and export work', () => {
    const runtimeAbortController = new AbortController()
    const exportAbortController = new AbortController()
    const runtimeSession = createRuntimeSession()
    const cancelHostSession = vi.fn()
    const runtimeAbortControllerRef = { current: runtimeAbortController }
    const exportAbortControllerRef = { current: exportAbortController }
    const runtimeWorkSessionIdRef = { current: 'runtime-work' }
    const runtimeSessionRef = { current: runtimeSession }

    const { result } = renderHook(() =>
      useRawRuntimeControls(
        createInput({
          cancelHostSession,
          runtimeSessionRef,
          runtimeAbortControllerRef,
          runtimeWorkSessionIdRef,
          exportAbortControllerRef,
        }),
      ),
    )

    result.current.abortRuntimeWork()
    result.current.abortExportWork()

    expect(cancelHostSession).toHaveBeenCalledTimes(1)
    expect(runtimeAbortController.signal.aborted).toBe(true)
    expect(exportAbortController.signal.aborted).toBe(true)
    expect(runtimeAbortControllerRef.current).toBeNull()
    expect(exportAbortControllerRef.current).toBeNull()
    expect(runtimeWorkSessionIdRef.current).toBeNull()
    expect(runtimeSession.dispose).toHaveBeenCalledTimes(1)
    expect(runtimeSessionRef.current).toBeNull()
  })

  it('cancels the ingest session through its host lease, disposing it exactly once', async () => {
    const ingestSession = createRuntimeSession()
    const openSession = vi.fn((_file: File, _signal: AbortSignal) =>
      Promise.resolve(ingestSession),
    )
    const leases = createRawRuntimeSessionLeases(openSession)
    const runtimeWorkSessionIdRef = { current: 'load-session' }
    const { result } = renderHook(() =>
      useRawRuntimeControls(
        createInput({
          cancelHostSession: leases.cancel,
          runtimeWorkSessionIdRef,
        }),
      ),
    )

    const lease = leases.begin()
    await lease.open(new File(['raw'], 'frame.dng'))

    result.current.abortRuntimeWork()
    result.current.abortRuntimeWork()
    // The load's own settle path is a no-op on a lease the workflow ended.
    lease.release()
    lease.cancel()

    expect(lease.signal.aborted).toBe(true)
    expect(runtimeWorkSessionIdRef.current).toBeNull()
    expect(ingestSession.dispose).toHaveBeenCalledTimes(1)
  })

  it('never cancels export work when it cancels the ingest session', () => {
    const exportAbortController = new AbortController()
    const exportAbortControllerRef = { current: exportAbortController }
    const { result } = renderHook(() =>
      useRawRuntimeControls(createInput({ exportAbortControllerRef })),
    )

    result.current.abortRuntimeWork()

    expect(exportAbortController.signal.aborted).toBe(false)
    expect(exportAbortControllerRef.current).toBe(exportAbortController)
  })
})
