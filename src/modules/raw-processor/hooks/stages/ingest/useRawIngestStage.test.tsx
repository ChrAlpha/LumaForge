import type { ColorGraphIntent } from '@lumaforge/luma-color-runtime'
import { NEUTRAL_USER_COLOR_INTENT } from '@lumaforge/luma-color-runtime'
import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { DecodedImage } from '~/lib/raw/decoder'
import type { RawRuntimeSession } from '~/lib/raw/runtime-adapter'

import type { ImageSession } from '../../../model/session'
import { useRawIngestStage } from './useRawIngestStage'

const colorIntent: ColorGraphIntent = {
  ...NEUTRAL_USER_COLOR_INTENT,
  intensity: 0.7,
  styleKind: 'none',
  builtinPreset: null,
}

describe('useRawIngestStage', () => {
  it('composes load and reset actions for an empty workflow', () => {
    const { result } = renderHook(() =>
      useRawIngestStage({
        setStatus: vi.fn(),
        setError: vi.fn(),
        setProgress: vi.fn(),
        getColorIntent: () => colorIntent,
        getView: () => ({ mode: 'processed', compareSplit: 0.5 }),
        getLut: () => null,
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
        disposeRuntimeSession: vi.fn(),
        yieldToPaint: () => Promise.resolve(),
        getPrewarmState: vi.fn(),
        prewarm: vi.fn(),
        runtimeAbortControllerRef: { current: null },
        runtimeSessionRef: { current: null as RawRuntimeSession | null },
        disposedRuntimeSessionsRef: {
          current: new WeakSet<RawRuntimeSession>(),
        },
        decodedImageRef: { current: null as DecodedImage | null },
        sessionRef: { current: null as ImageSession | null },
        embeddedPreviewUrlRef: { current: null },
        isMountedRef: { current: false },
        runtimeWorkSessionIdRef: { current: null },
        pendingLoadSessionIdRef: { current: null },
        previewCopyCanvasRef: { current: null },
        resetSession: vi.fn(),
      }),
    )

    expect(typeof result.current.loadFile).toBe('function')
    expect(typeof result.current.reset).toBe('function')
  })
})
