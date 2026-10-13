import type { RawRenderExposure } from '@lumaforge/luma-color-runtime'
import { act, renderHook } from '@testing-library/react'
import i18n from 'i18next'
import type { ComponentType, PropsWithChildren } from 'react'
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'

import { I18nProvider } from '~/lib/i18n'
import type { DecodedImage } from '~/lib/raw/decoder'
import { createRawRuntimeSessionLeases } from '~/lib/raw/raw-runtime-host'
import type { RawRuntimeSession } from '~/lib/raw/runtime-adapter'

import type { ImageSession } from '../../../model/session'
import {
  createLoadedTestSession,
  createTestDecodedImage,
  createTestSession,
} from '../../../test-support/builders'
import { useRestorePreviewAfterExport } from './useRestorePreviewAfterExport'

const toastMock = vi.hoisted(() => ({ toast: { error: vi.fn() } }))

vi.mock('sonner', () => toastMock)

const toastError = toastMock.toast.error

beforeEach(() => {
  toastError.mockReset()
})

/** A source whose export ran and released the decoded preview. */
function exportedSession(
  exportState: Partial<ImageSession['exportState']> = {},
  id = 'session-1',
): ImageSession {
  return createLoadedTestSession({
    id,
    exportState: {
      status: 'ready',
      activePlan: {
        profileName: 'desktop-fast',
        preferredRows: 128,
        concurrency: 1,
        runtimeMemoryProfile: 'desktop',
        outputSink: 'blob-handoff',
        checkpointMode: 'safe-retry',
      },
      ...exportState,
    },
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve
    reject = innerReject
  })
  return { promise, resolve, reject }
}

function fakeRuntimeSession(
  decodeQuickRaw: RawRuntimeSession['decodeQuickRaw'],
): RawRuntimeSession {
  return {
    sourceDimensions: { width: 400, height: 300 },
    extractEmbeddedPreview: vi.fn(),
    decodeQuickRaw: vi.fn(decodeQuickRaw),
    decodeBoundedHqRaw: vi.fn(),
    dispose: vi.fn(),
  }
}

type MountOptions = {
  session?: ImageSession | null
  decode?: RawRuntimeSession['decodeQuickRaw']
  /** Opens a source; by default it answers with the mount's own session. */
  open?: (file: File, own: RawRuntimeSession) => Promise<RawRuntimeSession>
  liveFrame?: DecodedImage | null
  pin?: RawRenderExposure | null
  mounted?: boolean
  runtimeWork?: string | null
  wrapper?: ComponentType<PropsWithChildren>
}

/**
 * Mounts a restore over the host's one-session slot, the slot a replacing
 * load takes its lease from too.
 */
function mountRestore({
  session = exportedSession(),
  decode = async () => createTestDecodedImage(),
  open = async (_file, own) => own,
  liveFrame = null,
  pin = null,
  mounted = true,
  runtimeWork = null,
  wrapper,
}: MountOptions = {}) {
  const runtimeSession = fakeRuntimeSession(decode)
  const openSession = vi.fn((file: File, _signal: AbortSignal) =>
    open(file, runtimeSession),
  )
  const slot = createRawRuntimeSessionLeases(openSession)
  const beginSession = vi.fn(slot.begin)
  const refs = {
    session: { current: session },
    pin: { current: pin },
    runtimeWork: { current: runtimeWork },
  }
  const setStatus = vi.fn()
  const setProgress = vi.fn()
  const setDecodedImageRef = vi.fn()
  const { result } = renderHook(
    () =>
      useRestorePreviewAfterExport({
        getSession: () => refs.session.current,
        decodedImageRef: { current: liveFrame },
        rawRenderExposureRef: refs.pin,
        isMountedRef: { current: mounted },
        runtimeWorkSessionIdRef: refs.runtimeWork,
        beginRuntimeSession: beginSession,
        setStatus,
        setProgress,
        setError: vi.fn(),
        setSession: (update) => {
          refs.session.current =
            typeof update === 'function' ? update(refs.session.current) : update
        },
        setDecodedImageRef,
        scheduleToast: (notify) => notify(),
      }),
    { wrapper },
  )
  return {
    result,
    restore: () => result.current.restorePreviewAfterExport(),
    runtimeSession,
    openSession,
    openSignal: (call = 0) => openSession.mock.calls[call]?.[1],
    beginSession,
    cancelSession: slot.cancel,
    refs,
    setStatus,
    setProgress,
    setDecodedImageRef,
  }
}

type RestoreView = ReturnType<typeof mountRestore>

/** A rejection that is not an Error, so it carries no message to show. */
const NON_ERROR_REJECTION = { reason: 'socket closed' }

describe('useRestorePreviewAfterExport', () => {
  it.each([
    ['delivered', {}],
    ['failed', { status: 'failed', lastErrorCode: 'EXPORT_RENDER_FAILED' }],
  ] satisfies Array<[string, Partial<ImageSession['exportState']>]>)(
    'restores the quick preview a %s export released, on a host lease',
    async (_label, exportState) => {
      const decoded = createTestDecodedImage({
        metadata: { width: 400, height: 300, make: 'Fuji', model: 'X-T5' },
      })
      const view = mountRestore({
        session: exportedSession(exportState),
        decode: async (onProgress) => {
          onProgress?.({ phase: 'processing', progress: 42 })
          return decoded
        },
      })
      const file = view.refs.session.current!.sourceFile.file

      await view.restore()

      // The session's own file, opened once on the host's slot and decoded
      // under that lease's signal; no pin, so it decodes as a first quick.
      expect(view.openSession).toHaveBeenCalledExactlyOnceWith(
        file,
        expect.any(AbortSignal),
      )
      expect(view.runtimeSession.decodeQuickRaw).toHaveBeenCalledWith(
        expect.any(Function),
        view.openSignal(),
        undefined,
      )
      expect(view.setStatus.mock.calls).toEqual([
        ['decoding'],
        ['processing'],
        ['ready'],
      ])
      expect(view.setProgress.mock.calls).toEqual([[0], [42], [100]])
      expect(view.setDecodedImageRef).toHaveBeenCalledExactlyOnceWith(decoded, {
        preserveExportResult: true,
      })
      expect(view.refs.session.current?.previewBundle).toMatchObject({
        quickDecodePreview: { status: 'ready', width: 400, height: 300 },
        displaySource: 'quick',
      })
      expect(view.refs.session.current?.sourceFile.metadata).toEqual(
        decoded.metadata,
      )
      expect(view.refs.runtimeWork.current).toBeNull()
      // Releasing the settled lease disposes its session once, without abort.
      expect(view.runtimeSession.dispose).toHaveBeenCalledTimes(1)
      expect(view.openSignal()?.aborted).toBe(false)
    },
  )

  it('decodes with the exposure pin it read when it began, an explicit 0 EV included', async () => {
    const pin: RawRenderExposure = {
      ev: 0,
      multiplier: 1,
      source: 'image-statistics',
    }
    const opened = deferred<RawRuntimeSession>()
    const view = mountRestore({ pin, open: () => opened.promise })

    const restore = view.restore()
    await vi.waitFor(() => expect(view.openSession).toHaveBeenCalled())
    // The pin moves while the source opens.
    view.refs.pin.current = {
      ev: 0.7,
      multiplier: 2 ** 0.7,
      source: 'image-statistics',
    }
    opened.resolve(view.runtimeSession)
    await restore

    expect(view.runtimeSession.decodeQuickRaw).toHaveBeenCalledWith(
      expect.any(Function),
      expect.any(AbortSignal),
      { pinnedExposure: pin },
    )
  })

  it('restores the source that is active when it runs, not one from an older render', async () => {
    const view = mountRestore()
    const restoreFromEarlierRender =
      view.result.current.restorePreviewAfterExport
    const next = exportedSession({}, 'session-next')
    view.refs.session.current = next

    await restoreFromEarlierRender()

    expect(view.openSession).toHaveBeenCalledWith(
      next.sourceFile.file,
      expect.any(AbortSignal),
    )
    expect(view.refs.session.current?.previewBundle.displaySource).toBe('quick')
  })

  it.each([
    [
      'a newer source is published while it decodes',
      'decode',
      (view: RestoreView) => {
        view.refs.session.current = createTestSession({ id: 'session-next' })
      },
    ],
    [
      'a reset cancels its lease while it decodes',
      'decode',
      (view: RestoreView) => {
        view.refs.session.current = null
        view.cancelSession()
      },
    ],
    [
      'a reset cancels its lease while the source opens',
      'open',
      (view: RestoreView) => {
        view.refs.session.current = null
        view.cancelSession()
      },
    ],
  ] as const)(
    'writes nothing and stays silent when %s',
    async (_label, stage, interrupt) => {
      const opened = deferred<RawRuntimeSession>()
      const decode = deferred<DecodedImage>()
      const view = mountRestore({
        open: () => opened.promise,
        decode: () => decode.promise,
      })

      const restore = view.restore()
      await vi.waitFor(() => expect(view.openSession).toHaveBeenCalled())
      if (stage === 'open') interrupt(view)
      opened.resolve(view.runtimeSession)
      if (stage === 'decode') {
        await vi.waitFor(() =>
          expect(view.runtimeSession.decodeQuickRaw).toHaveBeenCalled(),
        )
        interrupt(view)
      }
      const current = view.refs.session.current
      decode.resolve(createTestDecodedImage())
      await restore

      expect(view.setDecodedImageRef).not.toHaveBeenCalled()
      expect(view.setStatus).not.toHaveBeenCalledWith('ready')
      expect(toastError).not.toHaveBeenCalled()
      expect(view.refs.session.current).toBe(current)
      expect(view.runtimeSession.dispose).toHaveBeenCalledTimes(1)
      if (stage === 'open') {
        expect(view.runtimeSession.decodeQuickRaw).not.toHaveBeenCalled()
      }
    },
  )

  it('yields to a replacing load that takes the next host lease mid-restore', async () => {
    const next = createTestSession({ id: 'session-next' })
    const replacement = fakeRuntimeSession(async () => createTestDecodedImage())
    const decode = deferred<DecodedImage>()
    const view = mountRestore({
      decode: () => decode.promise,
      open: async (file, own) =>
        file === next.sourceFile.file ? replacement : own,
    })

    const restore = view.restore()
    await vi.waitFor(() =>
      expect(view.runtimeSession.decodeQuickRaw).toHaveBeenCalled(),
    )
    expect(view.refs.runtimeWork.current).toBe('session-1')

    // The load publishes its session, fences runtime work on it, and takes
    // the host's slot, which aborts the restore's lease.
    view.refs.session.current = next
    view.refs.runtimeWork.current = next.id
    const loadLease = view.beginSession()
    expect(view.openSignal()?.aborted).toBe(true)
    decode.reject(new DOMException('aborted', 'AbortError'))
    await restore

    expect(view.setDecodedImageRef).not.toHaveBeenCalled()
    expect(view.setStatus).not.toHaveBeenCalledWith('ready')
    expect(toastError).not.toHaveBeenCalled()
    expect(view.refs.session.current).toBe(next)
    // The restore's end leaves the replacement's fence and lease alone.
    expect(view.refs.runtimeWork.current).toBe(next.id)
    expect(view.runtimeSession.dispose).toHaveBeenCalledTimes(1)
    await expect(loadLease.open(next.sourceFile.file!)).resolves.toBe(
      replacement,
    )
    expect(loadLease.signal.aborted).toBe(false)
  })

  it.each([
    ['without an active source', { session: null }],
    ['for a source no export has released', { session: createTestSession() }],
    [
      'while the export that released the preview still runs',
      { session: exportedSession({ status: 'exporting' }) },
    ],
    [
      'while a decoded frame is still live',
      { liveFrame: createTestDecodedImage() },
    ],
    ['after the workflow unmounted', { mounted: false }],
    [
      'while a load or restore holds the runtime work fence',
      { runtimeWork: 'session-next' },
    ],
  ] satisfies Array<[string, MountOptions]>)(
    'opens nothing %s',
    async (_label, options) => {
      const view = mountRestore(options)

      await view.restore()

      // Taking a lease would cancel the one a load holds.
      expect(view.beginSession).not.toHaveBeenCalled()
      expect(view.setStatus).not.toHaveBeenCalled()
      expect(view.setDecodedImageRef).not.toHaveBeenCalled()
    },
  )

  it.each([
    [
      'the decode fails',
      { decode: () => Promise.reject(new Error('decode failed')) },
      'decode failed',
    ],
    [
      'the source fails to open',
      { open: () => Promise.reject(new Error('open failed')) },
      'open failed',
    ],
    [
      'it fails with no message of its own',
      { open: () => Promise.reject(NON_ERROR_REJECTION) },
      'Preview restore failed.',
    ],
  ] satisfies Array<[string, MountOptions, string]>)(
    'reports a restore that fails when %s, keeping the session and freeing the slot',
    async (_label, options, description) => {
      const view = mountRestore(options)
      const session = view.refs.session.current

      await view.restore()

      expect(toastError.mock.calls).toEqual([
        ['Preview restore failed', { description }],
      ])
      expect(view.setStatus).toHaveBeenLastCalledWith('ready')
      expect(view.setProgress).toHaveBeenLastCalledWith(0)
      expect(view.setDecodedImageRef).not.toHaveBeenCalled()
      expect(view.refs.session.current).toBe(session)
      expect(view.refs.runtimeWork.current).toBeNull()

      // The freed slot hands the next restore a fresh lease.
      await view.restore()
      expect(view.beginSession).toHaveBeenCalledTimes(2)
      expect(view.openSignal(1)?.aborted).toBe(false)
    },
  )

  it('reports in the locale current when the decode fails, with the runtime detail as given', async () => {
    onTestFinished(async () => {
      localStorage.clear()
      await act(() => i18n.changeLanguage('en'))
    })
    const decode = deferred<DecodedImage>()
    await act(() => i18n.changeLanguage('en'))
    const view = mountRestore({
      decode: () => decode.promise,
      wrapper: I18nProvider,
    })

    const restore = view.restore()
    await vi.waitFor(() =>
      expect(view.runtimeSession.decodeQuickRaw).toHaveBeenCalled(),
    )
    // The language menu switches while the RAW decodes.
    localStorage.setItem('lumaforge.locale', 'zh-CN')
    await act(() => i18n.changeLanguage('zh-CN'))
    decode.reject(new Error('decode failed'))
    await restore

    expect(toastError.mock.calls).toEqual([
      ['预览恢复失败', { description: 'decode failed' }],
    ])
  })
})
