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
    dispose: vi.fn(),
  }
}

function createInput(
  overrides: Partial<Parameters<typeof useRawRuntimeControls>[0]> = {},
): Parameters<typeof useRawRuntimeControls>[0] {
  return {
    cancelHostSession: vi.fn(),
    runtimeWorkSessionIdRef: { current: null },
    exportAbortControllerRef: { current: null },
    ...overrides,
  }
}

describe('useRawRuntimeControls', () => {
  it('aborts active runtime and export work', () => {
    const exportAbortController = new AbortController()
    const cancelHostSession = vi.fn()
    const exportAbortControllerRef = { current: exportAbortController }
    const runtimeWorkSessionIdRef = { current: 'runtime-work' }

    const { result } = renderHook(() =>
      useRawRuntimeControls(
        createInput({
          cancelHostSession,
          runtimeWorkSessionIdRef,
          exportAbortControllerRef,
        }),
      ),
    )

    result.current.abortRuntimeWork()
    result.current.abortExportWork()

    expect(cancelHostSession).toHaveBeenCalledTimes(1)
    expect(exportAbortController.signal.aborted).toBe(true)
    expect(exportAbortControllerRef.current).toBeNull()
    expect(runtimeWorkSessionIdRef.current).toBeNull()
  })

  it('cancels the session through its host lease, disposing it exactly once', async () => {
    const runtimeSession = createRuntimeSession()
    const openSession = vi.fn((_file: File, _signal: AbortSignal) =>
      Promise.resolve(runtimeSession),
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
    // The lease owner's own settle path is a no-op on a lease the workflow
    // ended.
    lease.release()
    lease.cancel()

    expect(lease.signal.aborted).toBe(true)
    expect(runtimeWorkSessionIdRef.current).toBeNull()
    expect(runtimeSession.dispose).toHaveBeenCalledTimes(1)
  })

  it('never cancels export work when it cancels the RAW session', () => {
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
