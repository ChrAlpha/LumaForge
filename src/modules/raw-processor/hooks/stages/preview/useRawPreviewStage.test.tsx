import type { ProcessingParams } from '@lumaforge/luma-color-runtime'
import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { createResourceRegistry } from '~/lib/export/resource-registry'
import type { RawRuntimeSession } from '~/lib/raw/runtime-adapter'
import type { RawProcessingPipeline } from '~/lib/webgpu/raw-processing-pipeline'

import type { ImageSession } from '../../../model/session'
import { useRawPreviewStage } from './useRawPreviewStage'

const params: ProcessingParams = {
  intensity: 0.7,
  viewMode: 'processed',
  compareSplit: 0.5,
  styleKind: 'none',
  builtinPreset: null,
  userExposureEv: 0,
  userContrast: 0,
  userHighlights: 0,
  userShadows: 0,
  userWhites: 0,
  userBlacks: 0,
  userTemperature: 0,
  userTint: 0,
  userSaturation: 0,
  userVibrance: 0,
}

describe('useRawPreviewStage', () => {
  it('composes preview lifecycle actions for an empty preview state', () => {
    const { result } = renderHook(() =>
      useRawPreviewStage({
        loadedFile: null,
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
        runtimeAbortControllerRef: { current: null },
        runtimeWorkSessionIdRef: { current: null },
        runtimeSessionRef: { current: null as RawRuntimeSession | null },
        setStatus: vi.fn(),
        setProgress: vi.fn(),
        setError: vi.fn(),
        abortRuntimeWork: vi.fn(),
        disposeRuntimeSession: vi.fn(),
        openSession: vi.fn(),
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
  })
})
