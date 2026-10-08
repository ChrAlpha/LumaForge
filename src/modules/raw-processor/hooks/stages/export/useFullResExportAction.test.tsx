import type { ColorGraphIntent } from '@lumaforge/luma-color-runtime'
import {
  NEUTRAL_USER_COLOR_INTENT,
  pickColorGraphIntent,
} from '@lumaforge/luma-color-runtime'
import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { ImageSession } from '../../../model/session'
import { createImageSession } from '../../../model/session-factory'
import type { orchestrateFullResExport } from '../../../services/export/orchestrate-full-res-export'
import type { UseFullResExportActionInput } from './useFullResExportAction'
import { useFullResExportAction } from './useFullResExportAction'

const NEUTRAL_INTENT: ColorGraphIntent = {
  ...NEUTRAL_USER_COLOR_INTENT,
  intensity: 0.7,
  styleKind: 'none',
  builtinPreset: null,
}

function createInput(
  orchestrateExport = vi.fn().mockResolvedValue(undefined),
): UseFullResExportActionInput {
  return {
    loadedImage: { file: null, metadata: null },
    session: null,
    getSession: vi.fn(() => null),
    getColorIntent: vi.fn(() => NEUTRAL_INTENT),
    getLutData: vi.fn(() => null),
    stats: null,
    decodedImageRef: { current: null },
    exportAbortControllerRef: { current: null },
    exportGraphVersionRef: { current: 0 },
    isMountedRef: { current: true },
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
          getSession: input.getSession,
          getColorIntent: input.getColorIntent,
          getLutData: input.getLutData,
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

  it('reads session and color when an action from an older render runs', async () => {
    const rendered = createImageSession(new File(['raw'], 'frame.dng'))
    const store: { session: ImageSession | null; intent: ColorGraphIntent } = {
      session: rendered,
      intent: NEUTRAL_INTENT,
    }
    const admitted: Array<{
      session: ImageSession | null
      intent: ColorGraphIntent
    }> = []
    const orchestrateExport = vi.fn<typeof orchestrateFullResExport>(
      async (_request, ctx) => {
        admitted.push({
          session: ctx.atoms.getSession(),
          intent: pickColorGraphIntent(ctx.atoms.getColorIntent()),
        })
      },
    )
    const input: UseFullResExportActionInput = {
      ...createInput(orchestrateExport),
      session: rendered,
      getSession: () => store.session,
      getColorIntent: () => store.intent,
    }
    const { result } = renderHook(() => useFullResExportAction(input))
    const exportFromRender = result.current.exportImage

    // Both land in the store in the same tick, before any rerender.
    const written = { ...rendered, activeStyle: null, createdAt: 2 }
    store.session = written
    store.intent = { ...NEUTRAL_INTENT, userContrast: 25 }
    await exportFromRender()

    expect(admitted).toEqual([
      { session: written, intent: { ...NEUTRAL_INTENT, userContrast: 25 } },
    ])
    expect(admitted[0]!.session).toBe(written)
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
