import { NEUTRAL_USER_COLOR_INTENT } from '@lumaforge/luma-color-runtime'
import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { PrewarmState } from '~/lib/raw/runtime-adapter'

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
    setPendingRecoveryRetry: vi.fn(),
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
    disposeRuntimeSession: vi.fn(),
    yieldToPaint: vi.fn(),
    getPrewarmState: vi.fn<() => PrewarmState>(() => 'idle'),
    prewarm: vi.fn(),
    runtimeAbortControllerRef: { current: null },
    runtimeSessionRef: { current: null },
    disposedRuntimeSessionsRef: { current: new WeakSet() },
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
          setPendingRecoveryRetry: input.setPendingRecoveryRetry,
        }),
        services: expect.objectContaining({
          replaceFile: input.replaceFile,
          setDecodedImageRef: input.setDecodedImageRef,
          registerCurrentPreviewPipelineForEvacuation:
            input.registerCurrentPreviewPipelineForEvacuation,
        }),
        refs: expect.objectContaining({
          runtimeAbortControllerRef: input.runtimeAbortControllerRef,
          sessionRef: input.sessionRef,
          pendingLoadSessionIdRef: input.pendingLoadSessionIdRef,
        }),
      }),
    )
  })
})
