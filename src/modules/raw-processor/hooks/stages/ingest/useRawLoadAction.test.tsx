import { NEUTRAL_USER_COLOR_INTENT } from '@lumaforge/luma-color-runtime'
import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { RawRuntimeSessionLease } from '~/lib/raw/raw-runtime-host'
import type { PrewarmState } from '~/lib/raw/runtime-adapter'

import type { RawLoadContext } from '../../../services/ingest/orchestrate-raw-load'
import type { UseRawLoadActionInput } from './useRawLoadAction'
import { useRawLoadAction } from './useRawLoadAction'

function createColorIntent(): ReturnType<
  UseRawLoadActionInput['getColorIntent']
> {
  return {
    ...NEUTRAL_USER_COLOR_INTENT,
    intensity: 0.7,
    styleKind: 'none',
    builtinPreset: null,
  }
}

function createHostLeases() {
  const leases: Array<{
    signal: AbortSignal
    release: ReturnType<typeof vi.fn>
    cancel: ReturnType<typeof vi.fn>
  }> = []
  const beginRuntimeSession = vi.fn((): RawRuntimeSessionLease => {
    const controller = new AbortController()
    const lease = {
      signal: controller.signal,
      open: vi.fn(),
      release: vi.fn(),
      cancel: vi.fn(() => controller.abort()),
    }
    leases.push(lease)
    return lease
  })
  return { leases, beginRuntimeSession }
}

/** Loads that only take their lease, keeping what the seam handed them. */
function createLeaseTakingLoad() {
  const taken: RawRuntimeSessionLease[] = []
  const orchestrateLoad = vi.fn(async (_file: File, ctx: RawLoadContext) => {
    taken.push(ctx.services.beginRuntimeSession())
  })
  return { taken, orchestrateLoad }
}

function createInput(
  orchestrateLoad = vi.fn().mockResolvedValue(undefined),
): UseRawLoadActionInput {
  return {
    setStatus: vi.fn(),
    setError: vi.fn(),
    setProgress: vi.fn(),
    getColorIntent: vi.fn(createColorIntent),
    getView: vi.fn(() => ({ mode: 'compare' as const, compareSplit: 0.5 })),
    getLut: vi.fn(() => null),
    setColorIntent: vi.fn(),
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
    registerCurrentPreviewPipelineForEvacuation: vi.fn(),
    yieldToPaint: vi.fn(),
    getPrewarmState: vi.fn<() => PrewarmState>(() => 'idle'),
    prewarm: vi.fn(),
    beginRuntimeSession: createHostLeases().beginRuntimeSession,
    runtimeAbortControllerRef: { current: null },
    decodedImageRef: { current: null },
    sessionRef: { current: null },
    embeddedPreviewUrlRef: { current: null },
    isMountedRef: { current: true },
    runtimeWorkSessionIdRef: { current: null },
    pendingLoadSessionIdRef: { current: null },
    previewCopyCanvasRef: { current: null },
    orchestrateLoad,
  }
}

describe('useRawLoadAction', () => {
  it('orchestrates RAW loading with the ingest context', async () => {
    const orchestrateLoad = vi.fn().mockResolvedValue(undefined)
    const input = createInput(orchestrateLoad)
    const file = new File(['raw'], 'frame.dng')

    const { result } = renderHook(() => useRawLoadAction(input))

    await result.current.loadFile(file)

    expect(orchestrateLoad).toHaveBeenCalledTimes(1)
    expect(orchestrateLoad).toHaveBeenCalledWith(
      file,
      expect.objectContaining({
        atoms: expect.objectContaining({
          setStatus: input.setStatus,
          getColorIntent: input.getColorIntent,
          getView: input.getView,
          getLut: input.getLut,
          setColorIntent: input.setColorIntent,
        }),
        services: expect.objectContaining({
          replaceFile: input.replaceFile,
          setDecodedImageRef: input.setDecodedImageRef,
          registerCurrentPreviewPipelineForEvacuation:
            input.registerCurrentPreviewPipelineForEvacuation,
          prewarm: input.prewarm,
        }),
        refs: expect.objectContaining({
          sessionRef: input.sessionRef,
          pendingLoadSessionIdRef: input.pendingLoadSessionIdRef,
        }),
      }),
    )
  })

  it('hands the load only normal source lifecycle ports', async () => {
    const orchestrateLoad = vi.fn().mockResolvedValue(undefined)
    const { result } = renderHook(() =>
      useRawLoadAction(createInput(orchestrateLoad)),
    )

    await result.current.loadFile(new File(['raw'], 'frame.dng'))

    const [, ctx] = orchestrateLoad.mock.calls[0]
    expect(Object.keys(ctx.atoms).sort()).toEqual(
      [
        'getColorIntent',
        'getLut',
        'getView',
        'setColorIntent',
        'setDecodedImageVersion',
        'setError',
        'setProgress',
        'setSession',
        'setStats',
        'setStatus',
      ].sort(),
    )
  })

  it('hands the load no native session ref, disposal set, or abort controller of its own', async () => {
    const orchestrateLoad = vi.fn().mockResolvedValue(undefined)
    const { result } = renderHook(() =>
      useRawLoadAction(createInput(orchestrateLoad)),
    )

    await result.current.loadFile(new File(['raw'], 'frame.dng'))

    const [, ctx] = orchestrateLoad.mock.calls[0] as [File, RawLoadContext]
    expect(ctx.refs).not.toHaveProperty('runtimeSessionRef')
    expect(ctx.refs).not.toHaveProperty('disposedRuntimeSessionsRef')
    expect(ctx.refs).not.toHaveProperty('runtimeAbortControllerRef')
    expect(ctx.services).not.toHaveProperty('disposeRuntimeSession')
    expect(ctx.services).not.toHaveProperty('openSession')
  })

  it('lets the shared runtime abort ref cancel the load lease on the host', async () => {
    const host = createHostLeases()
    const { orchestrateLoad } = createLeaseTakingLoad()
    const input = {
      ...createInput(orchestrateLoad),
      beginRuntimeSession: host.beginRuntimeSession,
    }
    const { result } = renderHook(() => useRawLoadAction(input))

    await result.current.loadFile(new File(['raw'], 'frame.dng'))

    const [first] = host.leases
    const cancellation = input.runtimeAbortControllerRef.current
    expect(cancellation?.signal).toBe(first!.signal)

    // The runtime controls abort preview work through this ref.
    cancellation!.abort()
    expect(first!.cancel).toHaveBeenCalledTimes(1)
    expect(first!.release).not.toHaveBeenCalled()
    expect(input.runtimeAbortControllerRef.current).toBeNull()
  })

  it('clears the shared abort ref when the lease ends, but never a newer one', async () => {
    const host = createHostLeases()
    const { taken, orchestrateLoad } = createLeaseTakingLoad()
    const input = {
      ...createInput(orchestrateLoad),
      beginRuntimeSession: host.beginRuntimeSession,
    }
    const { result } = renderHook(() => useRawLoadAction(input))

    await result.current.loadFile(new File(['raw'], 'a.dng'))
    const first = input.runtimeAbortControllerRef.current
    taken[0]!.release()
    expect(host.leases[0]!.release).toHaveBeenCalledTimes(1)
    expect(first?.signal.aborted).toBe(false)
    expect(input.runtimeAbortControllerRef.current).toBeNull()

    await result.current.loadFile(new File(['raw'], 'b.dng'))
    await result.current.loadFile(new File(['raw'], 'c.dng'))
    const newer = input.runtimeAbortControllerRef.current
    expect(newer?.signal).toBe(host.leases[2]!.signal)

    taken[1]!.cancel()
    taken[1]!.release()
    expect(input.runtimeAbortControllerRef.current).toBe(newer)

    taken[2]!.cancel()
    expect(input.runtimeAbortControllerRef.current).toBeNull()
  })
})
