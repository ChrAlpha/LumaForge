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
    refreshExportInterruption: vi.fn(),
    scheduleToast: vi.fn(),
    abortExportWork: vi.fn(),
    previewRuntime: { cancel: vi.fn(), terminate: vi.fn() },
    registerCurrentPreviewPipelineForEvacuation: vi.fn(),
    registerExportResultResource: vi.fn(),
    revokeCurrentEmbeddedPreviewUrl: vi.fn(),
    interruptionMarkers: {
      begin: vi.fn(),
      finish: vi.fn(),
      retire: vi.fn(),
    },
    orchestrateExport,
  }
}

describe('useFullResExportAction', () => {
  it('orchestrates full-res export with a stable export context', async () => {
    const orchestrateExport = vi.fn().mockResolvedValue(undefined)
    const input = createInput(orchestrateExport)
    const { result } = renderHook(() => useFullResExportAction(input))
    await result.current.exportImage()

    expect(orchestrateExport).toHaveBeenCalledTimes(1)
    expect(orchestrateExport).toHaveBeenCalledWith(
      {},
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
          previewRuntime: input.previewRuntime,
          revokeCurrentEmbeddedPreviewUrl:
            input.revokeCurrentEmbeddedPreviewUrl,
        }),
      }),
    )
  })

  it('hands the export the page markers and the interruption refresh', async () => {
    const orchestrateExport = vi.fn().mockResolvedValue(undefined)
    const input = createInput(orchestrateExport)
    const { result } = renderHook(() => useFullResExportAction(input))

    await result.current.exportImage()

    const [, ctx] = orchestrateExport.mock.calls[0]!
    expect(ctx.services.interruptionMarkers).toBe(input.interruptionMarkers)
    expect(ctx.atoms.refreshExportInterruption).toBe(
      input.refreshExportInterruption,
    )
    expect(ctx.atoms).not.toHaveProperty('setDiscoveredRecoveryState')
  })

  it('starts nothing on render or rerender', () => {
    const orchestrateExport = vi.fn().mockResolvedValue(undefined)
    const input = createInput(orchestrateExport)
    const view = renderHook(() => useFullResExportAction(input))
    view.rerender()

    expect(orchestrateExport).not.toHaveBeenCalled()
    expect(input.interruptionMarkers.begin).not.toHaveBeenCalled()
  })
})
