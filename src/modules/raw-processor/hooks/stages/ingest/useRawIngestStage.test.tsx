import type { ColorGraphIntent } from '@lumaforge/luma-color-runtime'
import { NEUTRAL_USER_COLOR_INTENT } from '@lumaforge/luma-color-runtime'
import { act, renderHook } from '@testing-library/react'
import type { SetStateAction } from 'react'
import { describe, expect, it, vi } from 'vitest'

import type { DecodedImage } from '~/lib/raw/decoder'
import type { RawRuntimeSessionLease } from '~/lib/raw/raw-runtime-host'

import type { ImageSession } from '../../../model/session'
import { createImageSession } from '../../../model/session-factory'
import { useRawIngestStage } from './useRawIngestStage'

const colorIntent: ColorGraphIntent = {
  ...NEUTRAL_USER_COLOR_INTENT,
  intensity: 0.7,
  styleKind: 'none',
  builtinPreset: null,
}

type IngestStageInput = Parameters<typeof useRawIngestStage>[0]

/** A synchronous session store, with replaceFile publishing through it. */
function createStorePorts(initial: ImageSession | null = null) {
  let current = initial
  const setSession = vi.fn((value: SetStateAction<ImageSession | null>) => {
    current = typeof value === 'function' ? value(current) : value
  })
  return {
    getSession: vi.fn(() => current),
    setSession,
    replaceFile: vi.fn((file: File) => {
      const next = createImageSession(file)
      setSession(next)
      return next
    }),
    resetSession: vi.fn(() => setSession(null)),
  }
}

function createInput(
  overrides: Partial<IngestStageInput> = {},
): IngestStageInput {
  return {
    setStatus: vi.fn(),
    setError: vi.fn(),
    setProgress: vi.fn(),
    getColorIntent: () => colorIntent,
    getView: () => ({ mode: 'processed', compareSplit: 0.5 }),
    getLut: () => null,
    setColorIntent: vi.fn(),
    getSession: vi.fn(() => null),
    setSession: vi.fn(),
    setDecodedImageVersion: vi.fn(),
    setStats: vi.fn(),
    scheduleToast: vi.fn(),
    replaceFile: vi.fn(),
    abortRuntimeWork: vi.fn(),
    abortExportWork: vi.fn(),
    queueExportResultResourceDisposal: vi.fn(),
    revokeCurrentEmbeddedPreviewUrl: vi.fn(),
    clearSessionEmbeddedPreviewUrl: vi.fn(),
    setDecodedImageRef: vi.fn(),
    invalidateExportGraph: vi.fn(),
    yieldToPaint: () => Promise.resolve(),
    getPrewarmState: vi.fn(),
    beginRuntimeSession: vi.fn(),
    decodedImageRef: { current: null as DecodedImage | null },
    embeddedPreviewUrlRef: { current: null },
    isMountedRef: { current: false },
    runtimeWorkSessionIdRef: { current: null },
    pendingLoadSessionIdRef: { current: null },
    previewCopyCanvasRef: { current: null },
    resetSession: vi.fn(),
    ...overrides,
  }
}

function createLease(): RawRuntimeSessionLease {
  const controller = new AbortController()
  return {
    signal: controller.signal,
    prewarm: vi.fn(),
    open: vi.fn(() => new Promise<never>(() => {})),
    release: vi.fn(),
    cancel: vi.fn(() => controller.abort()),
  }
}

describe('useRawIngestStage', () => {
  it('loads and resets through the session store alone', () => {
    const before = createImageSession(new File(['raw'], 'before.ARW'))
    const ports = createStorePorts(before)
    const leases: RawRuntimeSessionLease[] = []
    const input = createInput({
      ...ports,
      getPrewarmState: vi.fn(() => 'ready' as const),
      beginRuntimeSession: vi.fn(() => {
        const lease = createLease()
        leases.push(lease)
        return lease
      }),
      // The load stops at its paint boundary; only its synchronous start runs.
      yieldToPaint: () => new Promise<void>(() => {}),
    })
    const { result } = renderHook(() => useRawIngestStage(input))

    void result.current.loadFile(new File(['raw'], 'first.ARW'))
    void result.current.loadFile(new File(['raw'], 'second.ARW'))

    // The second load in the same tick sees and replaces the first through
    // the store; the load keeps no mirror of the session it published.
    const current = ports.getSession()
    expect(current?.sourceFile.name).toBe('second.ARW')
    expect(input.runtimeWorkSessionIdRef.current).toBe(current?.id)
    expect(input.pendingLoadSessionIdRef.current).toBe(current?.id)
    expect(ports.replaceFile).toHaveBeenCalledTimes(2)
    expect(leases).toHaveLength(2)

    act(() => {
      result.current.reset()
    })

    expect(ports.resetSession).toHaveBeenCalledTimes(1)
    expect(ports.getSession()).toBeNull()
    expect(input.runtimeWorkSessionIdRef.current).toBeNull()
    expect(input.pendingLoadSessionIdRef.current).toBeNull()
  })

  it('composes load and reset actions for an empty workflow', () => {
    const { result } = renderHook(() => useRawIngestStage(createInput()))

    expect(typeof result.current.loadFile).toBe('function')
    expect(typeof result.current.reset).toBe('function')
  })
})
