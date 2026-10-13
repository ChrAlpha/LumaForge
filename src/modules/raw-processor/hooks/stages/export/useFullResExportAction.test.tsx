import type { ColorGraphIntent } from '@lumaforge/luma-color-runtime'
import {
  NEUTRAL_USER_COLOR_INTENT,
  pickColorGraphIntent,
} from '@lumaforge/luma-color-runtime'
import { act, renderHook } from '@testing-library/react'
import i18n from 'i18next'
import { describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '~/lib/i18n'
import enMessages from '~/locales/en.json'
import zhMessages from '~/locales/zh-CN.json'

import type { ImageSession } from '../../../model/session'
import { createImageSession } from '../../../model/session-factory'
import type {
  FullResExportNotification,
  orchestrateFullResExport,
} from '../../../services/export/orchestrate-full-res-export'
import type { UseFullResExportActionInput } from './useFullResExportAction'
import { useFullResExportAction } from './useFullResExportAction'

const toastMock = vi.hoisted(() => ({
  toast: { error: vi.fn(), dismiss: vi.fn() },
}))

vi.mock('sonner', () => toastMock)

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
    decodedImageRef: { current: null },
    exportAbortControllerRef: { current: null },
    exportGraphVersionRef: { current: 0 },
    isMountedRef: { current: true },
    resourceRegistryRef: { current: null },
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

  describe('notifications', () => {
    async function notifyThroughHook(
      notifications: FullResExportNotification[],
      wrapper?: typeof I18nProvider,
    ) {
      toastMock.toast.error.mockReset()
      toastMock.toast.dismiss.mockReset()
      const order: string[] = []
      toastMock.toast.error.mockImplementation((title: string) => {
        order.push(`error:${title}`)
      })
      toastMock.toast.dismiss.mockImplementation(() => {
        order.push('dismiss')
      })
      const scheduled: Array<() => void> = []
      const scheduleToast = vi.fn((show: () => void) => {
        order.push('scheduled')
        scheduled.push(show)
      })
      const orchestrateExport = vi.fn<typeof orchestrateFullResExport>(
        async (_request, ctx) => {
          for (const notification of notifications) {
            ctx.services.notify(notification)
          }
        },
      )
      const { result } = renderHook(
        () =>
          useFullResExportAction({
            ...createInput(orchestrateExport),
            scheduleToast,
          }),
        wrapper ? { wrapper } : undefined,
      )

      await result.current.exportImage()

      return {
        order,
        scheduleToast,
        runScheduled() {
          for (const show of scheduled) show()
        },
      }
    }

    it('clears earlier notices at once when an export starts', async () => {
      const { order, scheduleToast } = await notifyThroughHook([
        { kind: 'started' },
      ])

      expect(order).toEqual(['dismiss'])
      expect(scheduleToast).not.toHaveBeenCalled()
      expect(toastMock.toast.error).not.toHaveBeenCalled()
    })

    it('shows a refusal by its code only when its scheduled task runs', async () => {
      const { order, runScheduled } = await notifyThroughHook([
        { kind: 'refused', refusal: { code: 'source-loading' } },
        { kind: 'refused', refusal: { code: 'transform-pending' } },
      ])

      expect(order).toEqual(['scheduled', 'scheduled'])
      expect(toastMock.toast.error).not.toHaveBeenCalled()

      runScheduled()

      expect(toastMock.toast.error.mock.calls).toEqual([
        [
          'Full-resolution export is not ready',
          { description: 'Full-resolution export source is still loading.' },
        ],
        [
          'Full-resolution export is not ready',
          {
            description:
              'Transform is still preparing the current photo. Export once the preview shows it.',
          },
        ],
      ])
    })

    it('shows a refusal diagnostic as given', async () => {
      const { runScheduled } = await notifyThroughHook([
        {
          kind: 'refused',
          refusal: {
            code: 'runtime-unsupported',
            detail: 'Quick preview is still being prepared.',
          },
        },
      ])

      runScheduled()

      expect(toastMock.toast.error.mock.calls).toEqual([
        [
          'Full-resolution export is not ready',
          { description: 'Quick preview is still being prepared.' },
        ],
      ])
    })

    it('shows a failure with its message and the level to retry at', async () => {
      const { order, runScheduled } = await notifyThroughHook([
        { kind: 'started' },
        {
          kind: 'failed',
          code: 'EXPORT_RENDER_FAILED',
          message: 'Worker exploded',
          retryLevel: 'safe',
        },
        {
          kind: 'failed',
          code: 'EXPORT_RENDER_FAILED',
          message: 'Worker exploded',
          retryLevel: null,
        },
        {
          kind: 'failed',
          code: 'EXPORT_RENDER_FAILED',
          message: null,
          retryLevel: 'balanced',
        },
      ])

      runScheduled()

      expect(order).toEqual([
        'dismiss',
        'scheduled',
        'scheduled',
        'scheduled',
        'error:Export failed',
        'error:Export failed',
        'error:Export failed',
      ])
      expect(toastMock.toast.error.mock.calls).toEqual([
        [
          'Export failed',
          { description: 'Worker exploded. Retry with safe fidelity.' },
        ],
        ['Export failed', { description: 'Worker exploded' }],
        [
          'Export failed',
          { description: 'Export failed. Retry with balanced fidelity.' },
        ],
      ])
    })

    it('describes a policy refusal by its code, whatever its message says', async () => {
      const { runScheduled } = await notifyThroughHook([
        {
          kind: 'failed',
          code: 'EXPORT_POLICY_CANNOT_COMPLETE',
          message: 'Plan refused',
          retryLevel: null,
        },
      ])

      runScheduled()

      expect(toastMock.toast.error.mock.calls).toEqual([
        [
          'Export failed',
          { description: enMessages['raw.export.reason.cannotSafelyComplete'] },
        ],
      ])
    })

    it('shows nothing for a notification whose scheduled task never runs', async () => {
      await notifyThroughHook([
        { kind: 'refused', refusal: { code: 'export-running' } },
        {
          kind: 'failed',
          code: 'EXPORT_RENDER_FAILED',
          message: 'late',
          retryLevel: null,
        },
      ])

      expect(toastMock.toast.error).not.toHaveBeenCalled()
    })

    it('shows each notification in the locale current when the export reports it', async () => {
      toastMock.toast.error.mockReset()
      let release!: () => void
      const reported = new Promise<void>((resolve) => {
        release = resolve
      })
      const scheduled: Array<() => void> = []
      const orchestrateExport = vi.fn<typeof orchestrateFullResExport>(
        async (_request, ctx) => {
          await reported
          ctx.services.notify({
            kind: 'refused',
            refusal: { code: 'source-loading' },
          })
          ctx.services.notify({
            kind: 'failed',
            code: 'EXPORT_RENDER_FAILED',
            message: null,
            retryLevel: 'safe',
          })
          ctx.services.notify({
            kind: 'failed',
            code: 'EXPORT_POLICY_CANNOT_COMPLETE',
            message: 'Plan refused',
            retryLevel: null,
          })
        },
      )
      const { result } = renderHook(
        () =>
          useFullResExportAction({
            ...createInput(orchestrateExport),
            scheduleToast: (show) => scheduled.push(show),
          }),
        { wrapper: I18nProvider },
      )

      try {
        const pending = result.current.exportImage()
        // The language menu switches while the export runs.
        localStorage.setItem('lumaforge.locale', 'zh-CN')
        await act(() => i18n.changeLanguage('zh-CN'))
        release()
        await pending
        for (const show of scheduled) show()
      } finally {
        localStorage.clear()
        await act(() => i18n.changeLanguage('en'))
        document.documentElement.lang = 'en'
      }

      expect(toastMock.toast.error.mock.calls).toEqual([
        ['全分辨率导出尚未就绪', { description: '全分辨率导出源还在加载。' }],
        ['导出失败', { description: '导出失败。请以安全模式重试。' }],
        [
          '导出失败',
          { description: zhMessages['raw.export.reason.cannotSafelyComplete'] },
        ],
      ])
    })
  })
})
