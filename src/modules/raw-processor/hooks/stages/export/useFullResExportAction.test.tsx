import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { UseFullResExportActionInput } from './useFullResExportAction'
import { useFullResExportAction } from './useFullResExportAction'

function createInput(
  orchestrateExport = vi.fn().mockResolvedValue(undefined),
): UseFullResExportActionInput {
  return {
    loadedImage: { file: null, metadata: null },
    session: null,
    params: {
      intensity: 0.7,
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
    },
    stats: null,
    lutDataRef: { current: null },
    decodedImageRef: { current: null },
    exportAbortControllerRef: { current: null },
    exportGraphVersionRef: { current: 0 },
    isMountedRef: { current: true },
    sessionRef: { current: null },
    pipelineRef: { current: null },
    resourceRegistryRef: { current: null },
    previewCopyCanvasRef: { current: null },
    setStatus: vi.fn(),
    setError: vi.fn(),
    setProgress: vi.fn(),
    setSession: vi.fn(),
    setDiscoveredRecoveryState: vi.fn(),
    scheduleToast: vi.fn(),
    abortExportWork: vi.fn(),
    abortRuntimeWork: vi.fn(),
    terminateRawDecodeBridge: vi.fn(),
    registerCurrentPreviewPipelineForEvacuation: vi.fn(),
    registerExportResultResource: vi.fn(),
    revokeCurrentEmbeddedPreviewUrl: vi.fn(),
    orchestrateExport,
  }
}

describe('useFullResExportAction', () => {
  it('orchestrates full-res export with a stable export context', async () => {
    const orchestrateExport = vi.fn().mockResolvedValue(undefined)
    const input = createInput(orchestrateExport)
    const { result } = renderHook(() => useFullResExportAction(input))
    const options = { quality: 'high' as const, fidelity: 'balanced' as const }

    await result.current.exportImage(options)

    expect(orchestrateExport).toHaveBeenCalledTimes(1)
    expect(orchestrateExport).toHaveBeenCalledWith(
      options,
      expect.objectContaining({
        atoms: expect.objectContaining({
          loadedImage: input.loadedImage,
          params: input.params,
          stats: input.stats,
        }),
        refs: expect.objectContaining({
          exportAbortControllerRef: input.exportAbortControllerRef,
          exportGraphVersionRef: input.exportGraphVersionRef,
          isMountedRef: input.isMountedRef,
        }),
        services: expect.objectContaining({
          abortExportWork: input.abortExportWork,
          abortRuntimeWork: input.abortRuntimeWork,
          revokeCurrentEmbeddedPreviewUrl:
            input.revokeCurrentEmbeddedPreviewUrl,
        }),
      }),
    )
  })
})
