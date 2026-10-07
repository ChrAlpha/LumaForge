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
      prewarm: vi.fn(),
      open: vi.fn(),
      release: vi.fn(),
      cancel: vi.fn(() => controller.abort()),
    }
    leases.push(lease)
    return lease
  })
  return { leases, beginRuntimeSession }
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
    beginRuntimeSession: createHostLeases().beginRuntimeSession,
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
    expect(Object.keys(ctx.refs).sort()).toEqual(
      [
        'decodedImageRef',
        'embeddedPreviewUrlRef',
        'isMountedRef',
        'pendingLoadSessionIdRef',
        'previewCopyCanvasRef',
        'runtimeWorkSessionIdRef',
        'sessionRef',
      ].sort(),
    )
    expect(ctx.services).not.toHaveProperty('disposeRuntimeSession')
    expect(ctx.services).not.toHaveProperty('openSession')
  })

  it('hands the load the workflow host lease unwrapped', async () => {
    const host = createHostLeases()
    const orchestrateLoad = vi.fn(async (_file: File, ctx: RawLoadContext) => {
      ctx.services.beginRuntimeSession()
    })
    const input = {
      ...createInput(orchestrateLoad),
      beginRuntimeSession: host.beginRuntimeSession,
    }
    const { result } = renderHook(() => useRawLoadAction(input))

    await result.current.loadFile(new File(['raw'], 'frame.dng'))

    const [, ctx] = orchestrateLoad.mock.calls[0] as [File, RawLoadContext]
    expect(ctx.services.beginRuntimeSession).toBe(host.beginRuntimeSession)
    expect(host.leases).toHaveLength(1)
  })
})
