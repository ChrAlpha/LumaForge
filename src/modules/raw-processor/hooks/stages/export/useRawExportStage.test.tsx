import type { ProcessingParams } from '@lumaforge/luma-color-runtime'
import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { createResourceRegistry } from '~/lib/export/resource-registry'
import type { RawProcessingPipeline } from '~/lib/webgpu/raw-processing-pipeline'

import type { ExportRecoveryState, ImageSession } from '../../../model/session'
import { useRawExportStage } from './useRawExportStage'

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

describe('useRawExportStage', () => {
  it('composes export state and actions for an empty workflow', () => {
    const { result } = renderHook(() =>
      useRawExportStage({
        setStatus: vi.fn(),
        setError: vi.fn(),
        setProgress: vi.fn(),
        setSession: vi.fn(),
        loadedImage: { file: null, metadata: null },
        session: null,
        params,
        lutDataRef: { current: null },
        decodedImageRef: { current: null },
        stats: null,
        setDiscoveredRecoveryState: vi.fn(),
        exportAbortControllerRef: { current: null },
        exportGraphVersionRef: { current: 0 },
        isMountedRef: { current: true },
        sessionRef: { current: null as ImageSession | null },
        pipelineRef: { current: null as RawProcessingPipeline | null },
        resourceRegistryRef: { current: createResourceRegistry() },
        previewCopyCanvasRef: { current: null },
        scheduleToast: vi.fn(),
        abortExportWork: vi.fn(),
        abortRuntimeWork: vi.fn(),
        terminateRawDecodeBridge: vi.fn(),
        registerCurrentPreviewPipelineForEvacuation: vi.fn(),
        registerExportResultResource: vi.fn(),
        revokeCurrentEmbeddedPreviewUrl: vi.fn(),
        discoveredRecovery: { status: 'none' },
        embeddedPreviewUrl: null,
        status: 'idle',
        hasImage: false,
        displaySource: 'none',
        rawRenderExposure: null,
        pendingRecoveryRetry: null,
        setPendingRecoveryRetry: vi.fn(),
        discoveredRecoveryRef: {
          current: { status: 'none' } as ExportRecoveryState,
        },
        loadFile: vi.fn(),
        queueExportResultResourceDisposal: vi.fn(),
        toast: { error: vi.fn(), success: vi.fn() },
      }),
    )

    expect(result.current.canExport).toBe(false)
    expect(result.current.exportResult).toBeNull()
    expect(result.current.previewSuspended).toBe(false)
    expect(typeof result.current.exportImage).toBe('function')
    expect(typeof result.current.exportPreviewImage).toBe('function')
    expect(typeof result.current.recoverInterruptedExport).toBe('function')
    expect(typeof result.current.downloadExportResult).toBe('function')
  })
})
