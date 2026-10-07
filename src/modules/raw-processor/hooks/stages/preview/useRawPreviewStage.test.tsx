import type { ColorGraphIntent } from '@lumaforge/luma-color-runtime'
import { NEUTRAL_USER_COLOR_INTENT } from '@lumaforge/luma-color-runtime'
import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { createResourceRegistry } from '~/lib/export/resource-registry'
import type { RawProcessingPipeline } from '~/lib/webgpu/raw-processing-pipeline'

import type { ImageSession } from '../../../model/session'
import { useRawPreviewStage } from './useRawPreviewStage'

const params: ColorGraphIntent = {
  ...NEUTRAL_USER_COLOR_INTENT,
  intensity: 0.7,
  styleKind: 'none',
  builtinPreset: null,
}

describe('useRawPreviewStage', () => {
  it('composes preview lifecycle actions for an empty preview state', async () => {
    const beginRuntimeSession = vi.fn()
    const { result } = renderHook(() =>
      useRawPreviewStage({
        session: null,
        sessionRef: { current: null as ImageSession | null },
        pendingLoadSessionIdRef: { current: null },
        decodedImageRef: { current: null },
        decodedImageVersion: 0,
        rawRenderExposureRef: { current: null },
        resourceRegistryRef: { current: createResourceRegistry() },
        setDecodedImageVersion: vi.fn(),
        invalidateExportGraph: vi.fn(),
        embeddedPreviewUrlRef: { current: null },
        setSession: vi.fn(),
        pipelineRef: { current: null as RawProcessingPipeline | null },
        params,
        lutDataRef: { current: null },
        lutDataVersion: 0,
        displaySource: 'none',
        isMountedRef: { current: true },
        runtimeWorkSessionIdRef: { current: null },
        beginRuntimeSession,
        setStatus: vi.fn(),
        setProgress: vi.fn(),
        setError: vi.fn(),
        scheduleToast: vi.fn(),
        toast: { error: vi.fn() },
      }),
    )

    expect(result.current.histogram).toEqual({
      state: 'unavailable',
      reason: 'no-image',
    })
    expect(typeof result.current.setDecodedImageRef).toBe('function')
    expect(typeof result.current.restorePreviewAfterExport).toBe('function')
    expect(
      typeof result.current.registerCurrentPreviewPipelineForEvacuation,
    ).toBe('function')
    expect(typeof result.current.setOriginalPreviewPipeline).toBe('function')

    // Without a source there is nothing to restore and no host lease to take.
    await result.current.restorePreviewAfterExport()
    expect(beginRuntimeSession).not.toHaveBeenCalled()
  })
})
