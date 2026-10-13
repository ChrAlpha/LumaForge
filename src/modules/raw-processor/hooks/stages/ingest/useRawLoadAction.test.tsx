import { act, renderHook } from '@testing-library/react'
import i18n from 'i18next'
import type { ComponentType, PropsWithChildren } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '~/lib/i18n'
import type { RawRuntimeSessionLease } from '~/lib/raw/raw-runtime-host'
import type { PrewarmState } from '~/lib/raw/runtime-adapter'

import type {
  RawLoadContext,
  RawLoadNotification,
} from '../../../services/ingest/orchestrate-raw-load'
import type { UseRawLoadActionInput } from './useRawLoadAction'
import { useRawLoadAction } from './useRawLoadAction'

const toastMock = vi.hoisted(() => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

vi.mock('sonner', () => toastMock)

const loadMock = vi.hoisted(() => ({ orchestrateRawLoad: vi.fn() }))

vi.mock('../../../services/ingest/orchestrate-raw-load', () => loadMock)

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

function createInput(): UseRawLoadActionInput {
  return {
    scheduleToast: vi.fn(),
    replaceFile: vi.fn(),
    abortRuntimeWork: vi.fn(),
    abortExportWork: vi.fn(),
    queueExportResultResourceDisposal: vi.fn(),
    revokeCurrentEmbeddedPreviewUrl: vi.fn(),
    setDecodedImageRef: vi.fn(),
    getPrewarmState: vi.fn<() => PrewarmState>(() => 'idle'),
    beginRuntimeSession: createHostLeases().beginRuntimeSession,
    embeddedPreviewUrlRef: { current: null },
    isMountedRef: { current: true },
    runtimeWorkSessionIdRef: { current: null },
    pendingLoadSessionIdRef: { current: null },
    previewCopyCanvasRef: { current: null },
  }
}

describe('useRawLoadAction', () => {
  describe('notifications', () => {
    async function notifyThroughHook(
      notifications: RawLoadNotification[],
      wrapper?: ComponentType<PropsWithChildren>,
    ) {
      toastMock.toast.success.mockReset()
      toastMock.toast.error.mockReset()
      const scheduled: Array<() => void> = []
      const scheduleToast = vi.fn((show: () => void) => {
        scheduled.push(show)
      })
      loadMock.orchestrateRawLoad.mockImplementation(
        async (_file: File, ctx: RawLoadContext) => {
          for (const notification of notifications) {
            ctx.services.notify(notification)
          }
        },
      )
      const { result } = renderHook(
        () => useRawLoadAction({ ...createInput(), scheduleToast }),
        { wrapper },
      )

      await result.current.loadFile(new File(['raw'], 'frame.dng'))

      return { scheduled, scheduleToast }
    }

    function shownToasts() {
      return [
        ...toastMock.toast.success.mock.calls.map((call) => [
          'success',
          ...call,
        ]),
        ...toastMock.toast.error.mock.calls.map((call) => ['error', ...call]),
      ]
    }

    const EVERY_NOTIFICATION: RawLoadNotification[] = [
      { kind: 'preview-unavailable' },
      {
        kind: 'loaded',
        fileName: 'frame.dng',
        width: 4243,
        height: 2828,
        make: 'Sony',
        model: 'ILCE-7RM5',
      },
      {
        kind: 'loaded',
        fileName: 'bare.dng',
        width: 1600,
        height: 1067,
        make: undefined,
        model: undefined,
      },
      { kind: 'load-failed', message: 'open exploded' },
      { kind: 'load-failed', message: null },
    ]

    afterEach(() => {
      localStorage.clear()
      document.documentElement.lang = 'en'
    })

    it('keeps every English notification', async () => {
      const { scheduled } = await notifyThroughHook(EVERY_NOTIFICATION)
      for (const show of scheduled) show()

      expect(shownToasts()).toEqual([
        [
          'success',
          'Loaded frame.dng',
          { description: '4243×2828 • Sony ILCE-7RM5' },
        ],
        ['success', 'Loaded bare.dng', { description: '1600×1067 • Unknown ' }],
        [
          'error',
          'Preview unavailable',
          {
            description:
              'Full-resolution export needs a decoded RAW preview exposure before it can run.',
          },
        ],
        ['error', 'Failed to load RAW file', { description: 'open exploded' }],
        [
          'error',
          'Failed to load RAW file',
          { description: 'Failed to load file' },
        ],
      ])
    })

    it('shows every notification in the current locale and runtime detail as given', async () => {
      localStorage.setItem('lumaforge.locale', 'zh-CN')
      try {
        const { scheduled } = await notifyThroughHook(
          EVERY_NOTIFICATION,
          I18nProvider,
        )
        for (const show of scheduled) show()
      } finally {
        await act(() => i18n.changeLanguage('en'))
      }

      expect(shownToasts()).toEqual([
        [
          'success',
          '已载入 frame.dng',
          { description: '4243×2828 • Sony ILCE-7RM5' },
        ],
        ['success', '已载入 bare.dng', { description: '1600×1067 • 未知 ' }],
        [
          'error',
          '预览不可用',
          {
            description: '全分辨率导出需要先解码出 RAW 预览曝光才能运行。',
          },
        ],
        ['error', '无法载入 RAW 文件', { description: 'open exploded' }],
        ['error', '无法载入 RAW 文件', { description: '无法载入文件' }],
      ])
    })

    it('shows a notification in the locale current when the load reports it', async () => {
      toastMock.toast.error.mockReset()
      const scheduled: Array<() => void> = []
      const reported = Promise.withResolvers<void>()
      loadMock.orchestrateRawLoad.mockImplementation(
        async (_file: File, ctx: RawLoadContext) => {
          await reported.promise
          ctx.services.notify({ kind: 'load-failed', message: null })
        },
      )
      try {
        await act(() => i18n.changeLanguage('en'))
        const { result } = renderHook(
          () =>
            useRawLoadAction({
              ...createInput(),
              scheduleToast: (show) => scheduled.push(show),
            }),
          { wrapper: I18nProvider },
        )
        const load = result.current.loadFile(new File(['raw'], 'frame.dng'))
        // The language menu switches while the RAW decodes.
        localStorage.setItem('lumaforge.locale', 'zh-CN')
        await act(() => i18n.changeLanguage('zh-CN'))
        reported.resolve()
        await load
        for (const show of scheduled) show()
      } finally {
        await act(() => i18n.changeLanguage('en'))
      }

      expect(toastMock.toast.error.mock.calls).toEqual([
        ['无法载入 RAW 文件', { description: '无法载入文件' }],
      ])
    })

    it('shows each load outcome only when its scheduled task runs, in order', async () => {
      const { scheduled, scheduleToast } = await notifyThroughHook([
        { kind: 'preview-unavailable' },
        { kind: 'load-failed', message: 'open exploded' },
      ])

      expect(scheduleToast).toHaveBeenCalledTimes(2)
      expect(toastMock.toast.error).not.toHaveBeenCalled()

      for (const show of scheduled) show()

      expect(toastMock.toast.error.mock.calls).toEqual([
        [
          'Preview unavailable',
          {
            description:
              'Full-resolution export needs a decoded RAW preview exposure before it can run.',
          },
        ],
        ['Failed to load RAW file', { description: 'open exploded' }],
      ])
      expect(toastMock.toast.success).not.toHaveBeenCalled()
    })

    it('describes a loaded source by its bounded HQ size and camera', async () => {
      const { scheduled } = await notifyThroughHook([
        {
          kind: 'loaded',
          fileName: 'frame.dng',
          width: 4243,
          height: 2828,
          make: 'Sony',
          model: 'ILCE-7RM5',
        },
        {
          kind: 'loaded',
          fileName: 'bare.dng',
          width: 1600,
          height: 1067,
          make: undefined,
          model: undefined,
        },
      ])

      for (const show of scheduled) show()

      expect(toastMock.toast.success.mock.calls).toEqual([
        ['Loaded frame.dng', { description: '4243×2828 • Sony ILCE-7RM5' }],
        ['Loaded bare.dng', { description: '1600×1067 • Unknown ' }],
      ])
    })

    it('shows nothing for a notification whose scheduled task never runs', async () => {
      await notifyThroughHook([{ kind: 'load-failed', message: 'late' }])

      expect(toastMock.toast.error).not.toHaveBeenCalled()
    })
  })
})
