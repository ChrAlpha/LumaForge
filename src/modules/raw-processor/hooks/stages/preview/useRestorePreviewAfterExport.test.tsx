import { NEUTRAL_USER_COLOR_INTENT } from '@lumaforge/luma-color-runtime'
import { createBlobOutputResult } from '@lumaforge/render-engine/export'
import { act, renderHook } from '@testing-library/react'
import i18n from 'i18next'
import type { ComponentType, PropsWithChildren } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '~/lib/i18n'
import type { DecodedImage, ProgressCallback } from '~/lib/raw/decoder'
import { createRawRuntimeSessionLeases } from '~/lib/raw/raw-runtime-host'
import type { RawRuntimeSession } from '~/lib/raw/runtime-adapter'

import { createExportResult } from '../../../model/export-result'
import type { ImageSession } from '../../../model/session'
import { createTransformState } from '../../../model/session-factory'
import { captureExportResultIdentity } from '../../../services/export/export-result-identity'
import type { SetImageSession } from '../../../state/session.atoms'
import { useRestorePreviewAfterExport } from './useRestorePreviewAfterExport'

const toastMock = vi.hoisted(() => ({ toast: { error: vi.fn() } }))

vi.mock('sonner', () => toastMock)

function freshToastError() {
  toastMock.toast.error.mockReset()
  return toastMock.toast.error
}

const ACTIVE_PLAN: NonNullable<ImageSession['exportState']['activePlan']> = {
  profileName: 'desktop-fast',
  preferredRows: 128,
  concurrency: 1,
  runtimeMemoryProfile: 'desktop',
  outputSink: 'blob-handoff',
  checkpointMode: 'safe-retry',
}

function createDeliveredResult(sessionId: string, file: File) {
  return createExportResult({
    kind: 'full-resolution',
    output: createBlobOutputResult({
      filename: 'restore_fullres.jpg',
      blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
    }),
    width: 400,
    height: 300,
    copyCapability: { mode: 'full-resolution' },
    identity: captureExportResultIdentity({
      resultKind: 'full-resolution',
      attemptId: `attempt-${sessionId}`,
      sessionId,
      sourceFile: file,
      intent: {
        styleKind: 'none',
        builtinPreset: null,
        intensity: 0,
        ...NEUTRAL_USER_COLOR_INTENT,
      },
      lut: null,
      rawRenderExposure: { ev: 0, multiplier: 1, source: 'identity' },
      geometry: null,
    }),
  })
}

/**
 * A source whose export finished and released the decoded preview: the
 * delivered JPEG stands in for it, the state a restore exists for.
 */
function createSession(
  id = 'session-restore',
  file = new File(['raw'], 'restore.dng'),
): ImageSession {
  return withExportState(createLoadingSession(id, file), {
    status: 'ready',
    activePlan: ACTIVE_PLAN,
    result: createDeliveredResult(id, file),
  })
}

function withExportState(
  session: ImageSession,
  exportState: Partial<ImageSession['exportState']>,
): ImageSession {
  return {
    ...session,
    exportState: { ...session.exportState, ...exportState },
  }
}

/** A source a load has just published: nothing has exported it yet. */
function createLoadingSession(
  id: string,
  file = new File(['raw'], `${id}.dng`),
): ImageSession {
  return {
    id,
    createdAt: 1,
    sourceFile: {
      file,
      name: file.name,
      extension: 'dng',
      sizeBytes: 3,
      metadata: { width: 400, height: 300 },
      supportLevel: 'experimental',
    },
    previewBundle: {
      embeddedPreview: { status: 'idle' },
      quickDecodePreview: { status: 'idle' },
      boundedHqPreview: { status: 'idle' },
      displaySource: 'none',
      boundedHqRequiredForExport: false,
    },
    activeStyle: null,
    viewState: {
      mode: 'processed',
      compareSplit: 0.5,
      zoom: 1,
      panX: 0,
      panY: 0,
      fitMode: 'screen',
    },
    exportState: {
      status: 'idle',
      fullResCapability: { status: 'supported', width: 400, height: 300 },
      retryRecommended: false,
    },
    exportGeometry: null,
    transform: createTransformState(id),
  }
}

function createDecodedImage(): DecodedImage {
  return {
    width: 640,
    height: 480,
    channels: 4,
    bitsPerChannel: 32,
    data: new Float32Array(640 * 480 * 4),
    layout: 'rgba-float32',
    colorSpace: 'linear-prophoto-rgb',
    source: 'quick',
    metadata: { width: 640, height: 480, make: 'Fuji', model: 'X-T5' },
    renderExposure: {
      ev: 0,
      multiplier: 1,
      source: 'identity',
    },
    timings: { decodeMs: 12 },
  }
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

function applySessionUpdate(sessionRef: {
  current: ImageSession | null
}): SetImageSession {
  return (update) => {
    sessionRef.current =
      typeof update === 'function' ? update(sessionRef.current) : update
  }
}

/** A rejection that is not an Error, so it carries no message to show. */
const NON_ERROR_REJECTION = { reason: 'socket closed' }

function createRuntimeSession(
  decodeQuickRaw: RawRuntimeSession['decodeQuickRaw'],
): RawRuntimeSession {
  return {
    sourceDimensions: { width: 640, height: 480 },
    extractEmbeddedPreview: vi.fn(),
    decodeQuickRaw: vi.fn(decodeQuickRaw),
    decodeBoundedHqRaw: vi.fn(),
    dispose: vi.fn(),
  }
}

/**
 * The host's one-session slot over a test open: restore and any load that
 * replaces it take their leases from the same slot.
 */
function createHostSessions(
  openSession: (file: File, signal: AbortSignal) => Promise<RawRuntimeSession>,
) {
  const open = vi.fn(openSession)
  const slot = createRawRuntimeSessionLeases(open)
  return {
    open,
    beginSession: vi.fn(slot.begin),
    cancelSession: vi.fn(slot.cancel),
    openSignal: (call = 0) => open.mock.calls[call]?.[1],
  }
}

function renderRestore(input: {
  sessionRef: { current: ImageSession | null }
  decodedImageRef?: { current: DecodedImage | null }
  rawRenderExposureRef?: { current: DecodedImage['renderExposure'] | null }
  isMountedRef?: { current: boolean }
  runtimeWorkSessionIdRef?: { current: string | null }
  hostSessions: ReturnType<typeof createHostSessions>
  setStatus?: ReturnType<typeof vi.fn>
  setProgress?: ReturnType<typeof vi.fn>
  setDecodedImageRef?: ReturnType<typeof vi.fn>
  wrapper?: ComponentType<PropsWithChildren>
}) {
  const scheduleToast = vi.fn((notify: () => void) => notify())
  const rendered = renderHook(
    () =>
      useRestorePreviewAfterExport({
        getSession: () => input.sessionRef.current,
        decodedImageRef: input.decodedImageRef ?? { current: null },
        rawRenderExposureRef: input.rawRenderExposureRef ?? { current: null },
        isMountedRef: input.isMountedRef ?? { current: true },
        runtimeWorkSessionIdRef: input.runtimeWorkSessionIdRef ?? {
          current: null,
        },
        beginRuntimeSession: input.hostSessions.beginSession,
        setStatus: input.setStatus ?? vi.fn(),
        setProgress: input.setProgress ?? vi.fn(),
        setError: vi.fn(),
        setSession: applySessionUpdate(input.sessionRef),
        setDecodedImageRef: input.setDecodedImageRef ?? vi.fn(),
        scheduleToast,
      }),
    { wrapper: input.wrapper },
  )
  return { ...rendered, scheduleToast }
}

describe('useRestorePreviewAfterExport', () => {
  it('restores the quick preview for the active exported session on a host lease', async () => {
    const session = createSession()
    const sessionRef = { current: session as ImageSession | null }
    const runtimeWorkSessionIdRef = { current: null as string | null }
    const decoded = createDecodedImage()
    const runtimeSession = createRuntimeSession(
      async (onProgress?: ProgressCallback) => {
        onProgress?.({ phase: 'processing', progress: 42 })
        return decoded
      },
    )
    const hostSessions = createHostSessions(async () => runtimeSession)
    const setStatus = vi.fn()
    const setProgress = vi.fn()
    const setDecodedImageRef = vi.fn()

    const { result } = renderRestore({
      sessionRef,
      runtimeWorkSessionIdRef,
      hostSessions,
      setStatus,
      setProgress,
      setDecodedImageRef,
    })

    await result.current.restorePreviewAfterExport()

    // The restored source is the active session's own file, opened once on
    // the host's session slot and decoded under that lease's signal.
    expect(hostSessions.beginSession).toHaveBeenCalledTimes(1)
    expect(hostSessions.open).toHaveBeenCalledTimes(1)
    expect(hostSessions.open).toHaveBeenCalledWith(
      session.sourceFile.file,
      expect.any(AbortSignal),
    )
    expect(runtimeSession.decodeQuickRaw).toHaveBeenCalledWith(
      expect.any(Function),
      hostSessions.openSignal(),
      undefined,
    )
    expect(setStatus).toHaveBeenCalledWith('decoding')
    expect(setStatus).toHaveBeenCalledWith('processing')
    expect(setProgress).toHaveBeenCalledWith(42)
    expect(setDecodedImageRef).toHaveBeenCalledWith(decoded, {
      preserveExportResult: true,
    })
    expect(sessionRef.current?.previewBundle.quickDecodePreview).toEqual({
      status: 'ready',
      width: 640,
      height: 480,
    })
    expect(sessionRef.current?.previewBundle.displaySource).toBe('quick')
    expect(sessionRef.current?.sourceFile.metadata).toEqual(decoded.metadata)
    expect(runtimeWorkSessionIdRef.current).toBeNull()
    // Releasing the settled lease disposes its session once, without abort.
    expect(runtimeSession.dispose).toHaveBeenCalledTimes(1)
    expect(hostSessions.openSignal()?.aborted).toBe(false)
  })

  it('hands the source exposure pin back to the runtime, including an explicit 0 EV', async () => {
    const pinnedExposure = {
      ev: 0,
      multiplier: 1,
      source: 'image-statistics' as const,
    }
    const decoded = { ...createDecodedImage(), renderExposure: pinnedExposure }
    const runtimeSession = createRuntimeSession(async () => decoded)
    const setDecodedImageRef = vi.fn()
    const { result } = renderRestore({
      sessionRef: { current: createSession() },
      rawRenderExposureRef: { current: pinnedExposure },
      hostSessions: createHostSessions(async () => runtimeSession),
      setDecodedImageRef,
    })

    await result.current.restorePreviewAfterExport()

    expect(runtimeSession.decodeQuickRaw).toHaveBeenCalledWith(
      expect.any(Function),
      expect.any(AbortSignal),
      { pinnedExposure },
    )
    expect(setDecodedImageRef).toHaveBeenCalledWith(decoded, {
      preserveExportResult: true,
    })
  })

  it('keeps the pin it read at the start when the pin moves during the decode', async () => {
    const quickPin = {
      ev: 0.6,
      multiplier: 2 ** 0.6,
      source: 'image-statistics' as const,
    }
    const quickDecode = deferred<DecodedImage>()
    const runtimeSession = createRuntimeSession(() => quickDecode.promise)
    const rawRenderExposureRef = {
      current: quickPin as DecodedImage['renderExposure'] | null,
    }
    const { result } = renderRestore({
      sessionRef: { current: createSession() },
      rawRenderExposureRef,
      hostSessions: createHostSessions(async () => runtimeSession),
    })

    const restore = result.current.restorePreviewAfterExport()
    await vi.waitFor(() => {
      expect(runtimeSession.decodeQuickRaw).toHaveBeenCalled()
    })
    rawRenderExposureRef.current = {
      ev: 0.7,
      multiplier: 2 ** 0.7,
      source: 'image-statistics',
    }
    quickDecode.resolve(createDecodedImage())
    await restore

    expect(runtimeSession.decodeQuickRaw).toHaveBeenCalledWith(
      expect.any(Function),
      expect.any(AbortSignal),
      { pinnedExposure: quickPin },
    )
  })

  it('does not write a late restored frame into a newer source', async () => {
    const quickDecode = deferred<DecodedImage>()
    const runtimeSession = createRuntimeSession(() => quickDecode.promise)
    const setDecodedImageRef = vi.fn()
    const sessionRef = { current: createSession() as ImageSession | null }
    const { result } = renderRestore({
      sessionRef,
      rawRenderExposureRef: {
        current: { ev: 0.5, multiplier: 2 ** 0.5, source: 'image-statistics' },
      },
      hostSessions: createHostSessions(async () => runtimeSession),
      setDecodedImageRef,
    })

    const restore = result.current.restorePreviewAfterExport()
    await vi.waitFor(() => {
      expect(runtimeSession.decodeQuickRaw).toHaveBeenCalled()
    })
    sessionRef.current = createLoadingSession('session-next')
    quickDecode.resolve(createDecodedImage())
    await restore

    expect(setDecodedImageRef).not.toHaveBeenCalled()
    expect(sessionRef.current?.previewBundle.displaySource).toBe('none')
    expect(runtimeSession.dispose).toHaveBeenCalledTimes(1)
  })

  it('yields to a replacing load that takes the next host lease mid-restore', async () => {
    const quickDecode = deferred<DecodedImage>()
    const restored = createRuntimeSession(() => quickDecode.promise)
    const replacement = createRuntimeSession(async () => createDecodedImage())
    const hostSessions = createHostSessions(async (file) =>
      file.name === 'next.dng' ? replacement : restored,
    )
    const setDecodedImageRef = vi.fn()
    const setStatus = vi.fn()
    const toastError = freshToastError()
    const sessionRef = { current: createSession() as ImageSession | null }
    const runtimeWorkSessionIdRef = { current: null as string | null }
    const { result } = renderRestore({
      sessionRef,
      runtimeWorkSessionIdRef,
      hostSessions,
      setDecodedImageRef,
      setStatus,
    })

    const restore = result.current.restorePreviewAfterExport()
    await vi.waitFor(() => {
      expect(restored.decodeQuickRaw).toHaveBeenCalled()
    })
    expect(runtimeWorkSessionIdRef.current).toBe('session-restore')

    // A replacing load publishes its session and takes the host's slot.
    const nextFile = new File(['raw'], 'next.dng')
    sessionRef.current = createLoadingSession('session-next', nextFile)
    runtimeWorkSessionIdRef.current = 'session-next'
    const loadLease = hostSessions.beginSession()
    expect(hostSessions.openSignal(0)?.aborted).toBe(true)
    expect(restored.dispose).toHaveBeenCalledTimes(1)

    quickDecode.reject(new DOMException('aborted', 'AbortError'))
    await restore

    expect(setDecodedImageRef).not.toHaveBeenCalled()
    expect(setStatus).not.toHaveBeenCalledWith('ready')
    expect(toastError).not.toHaveBeenCalled()
    expect(sessionRef.current?.id).toBe('session-next')
    expect(sessionRef.current?.previewBundle.displaySource).toBe('none')
    // The restore's end leaves the replacement's fence and lease alone.
    expect(runtimeWorkSessionIdRef.current).toBe('session-next')
    expect(restored.dispose).toHaveBeenCalledTimes(1)
    await expect(loadLease.open(nextFile)).resolves.toBe(replacement)
    expect(loadLease.signal.aborted).toBe(false)
    expect(replacement.dispose).not.toHaveBeenCalled()
  })

  it('stops quietly when a reset cancels the host lease mid-restore', async () => {
    const quickDecode = deferred<DecodedImage>()
    const runtimeSession = createRuntimeSession(() => quickDecode.promise)
    const hostSessions = createHostSessions(async () => runtimeSession)
    const setDecodedImageRef = vi.fn()
    const toastError = freshToastError()
    const sessionRef = { current: createSession() as ImageSession | null }
    const { result } = renderRestore({
      sessionRef,
      hostSessions,
      setDecodedImageRef,
    })

    const restore = result.current.restorePreviewAfterExport()
    await vi.waitFor(() => {
      expect(runtimeSession.decodeQuickRaw).toHaveBeenCalled()
    })
    sessionRef.current = null
    hostSessions.cancelSession()
    quickDecode.resolve(createDecodedImage())
    await restore

    expect(hostSessions.openSignal()?.aborted).toBe(true)
    expect(setDecodedImageRef).not.toHaveBeenCalled()
    expect(toastError).not.toHaveBeenCalled()
    expect(sessionRef.current).toBeNull()
    expect(runtimeSession.dispose).toHaveBeenCalledTimes(1)
  })

  it('disposes a session that opens after its restore was cancelled and never decodes it', async () => {
    const lateOpen = deferred<RawRuntimeSession>()
    const runtimeSession = createRuntimeSession(async () =>
      createDecodedImage(),
    )
    const hostSessions = createHostSessions(() => lateOpen.promise)
    const toastError = freshToastError()
    const sessionRef = { current: createSession() as ImageSession | null }
    const { result } = renderRestore({ sessionRef, hostSessions })

    const restore = result.current.restorePreviewAfterExport()
    await vi.waitFor(() => {
      expect(hostSessions.open).toHaveBeenCalled()
    })
    hostSessions.cancelSession()
    lateOpen.resolve(runtimeSession)
    await restore

    expect(runtimeSession.decodeQuickRaw).not.toHaveBeenCalled()
    expect(runtimeSession.dispose).toHaveBeenCalledTimes(1)
    expect(toastError).not.toHaveBeenCalled()
  })

  it('reports a failed restore, keeps the session, and frees its lease', async () => {
    const runtimeSession = createRuntimeSession(async () => {
      throw new Error('decode failed')
    })
    const hostSessions = createHostSessions(async () => runtimeSession)
    const setStatus = vi.fn()
    const setProgress = vi.fn()
    const setDecodedImageRef = vi.fn()
    const toastError = freshToastError()
    const session = createSession()
    const sessionRef = { current: session as ImageSession | null }
    const runtimeWorkSessionIdRef = { current: null as string | null }
    const { result } = renderRestore({
      sessionRef,
      runtimeWorkSessionIdRef,
      hostSessions,
      setStatus,
      setProgress,
      setDecodedImageRef,
    })

    await result.current.restorePreviewAfterExport()

    expect(toastError).toHaveBeenCalledWith('Preview restore failed', {
      description: 'decode failed',
    })
    expect(setStatus).toHaveBeenLastCalledWith('ready')
    expect(setProgress).toHaveBeenLastCalledWith(0)
    expect(setDecodedImageRef).not.toHaveBeenCalled()
    expect(sessionRef.current).toBe(session)
    expect(runtimeWorkSessionIdRef.current).toBeNull()
    expect(runtimeSession.dispose).toHaveBeenCalledTimes(1)

    // The freed slot hands the next restore a fresh lease.
    await result.current.restorePreviewAfterExport()
    expect(hostSessions.beginSession).toHaveBeenCalledTimes(2)
    expect(hostSessions.openSignal(1)?.aborted).toBe(false)
  })

  it('reports a failed open without a session to dispose', async () => {
    const hostSessions = createHostSessions(async () => {
      throw new Error('open failed')
    })
    const toastError = freshToastError()
    const { result } = renderRestore({
      sessionRef: { current: createSession() },
      hostSessions,
    })

    await result.current.restorePreviewAfterExport()

    expect(toastError).toHaveBeenCalledWith('Preview restore failed', {
      description: 'open failed',
    })
  })

  it('describes a failed restore that carried no message of its own', async () => {
    const hostSessions = createHostSessions(() =>
      Promise.reject(NON_ERROR_REJECTION),
    )
    const toastError = freshToastError()
    const { result } = renderRestore({
      sessionRef: { current: createSession() },
      hostSessions,
    })

    await result.current.restorePreviewAfterExport()

    expect(toastError.mock.calls).toEqual([
      ['Preview restore failed', { description: 'Preview restore failed.' }],
    ])
  })

  describe('in the current locale', () => {
    afterEach(async () => {
      localStorage.clear()
      await act(() => i18n.changeLanguage('en'))
    })

    it('reports a failed restore with the runtime detail as given', async () => {
      localStorage.setItem('lumaforge.locale', 'zh-CN')
      const toastError = freshToastError()
      const { result } = renderRestore({
        sessionRef: { current: createSession() },
        hostSessions: createHostSessions(async () => {
          throw new Error('open failed')
        }),
        wrapper: I18nProvider,
      })

      await result.current.restorePreviewAfterExport()

      expect(toastError.mock.calls).toEqual([
        ['预览恢复失败', { description: 'open failed' }],
      ])
    })

    it('describes a failed restore that carried no message of its own', async () => {
      localStorage.setItem('lumaforge.locale', 'zh-CN')
      const toastError = freshToastError()
      const { result } = renderRestore({
        sessionRef: { current: createSession() },
        hostSessions: createHostSessions(() =>
          Promise.reject(NON_ERROR_REJECTION),
        ),
        wrapper: I18nProvider,
      })

      await result.current.restorePreviewAfterExport()

      expect(toastError.mock.calls).toEqual([
        ['预览恢复失败', { description: '预览恢复失败。' }],
      ])
    })

    it('uses the locale current when the decode fails, not when it began', async () => {
      const decode = deferred<DecodedImage>()
      const runtimeSession = createRuntimeSession(() => decode.promise)
      const hostSessions = createHostSessions(async () => runtimeSession)
      const toastError = freshToastError()
      await act(() => i18n.changeLanguage('en'))
      const { result } = renderRestore({
        sessionRef: { current: createSession() },
        hostSessions,
        wrapper: I18nProvider,
      })

      const restore = result.current.restorePreviewAfterExport()
      await vi.waitFor(() =>
        expect(runtimeSession.decodeQuickRaw).toHaveBeenCalled(),
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

    it('stays silent when a reset cancels the lease mid-restore', async () => {
      localStorage.setItem('lumaforge.locale', 'zh-CN')
      const decode = deferred<DecodedImage>()
      const runtimeSession = createRuntimeSession(() => decode.promise)
      const hostSessions = createHostSessions(async () => runtimeSession)
      const toastError = freshToastError()
      const { result } = renderRestore({
        sessionRef: { current: createSession() },
        hostSessions,
        wrapper: I18nProvider,
      })

      const restore = result.current.restorePreviewAfterExport()
      await vi.waitFor(() =>
        expect(runtimeSession.decodeQuickRaw).toHaveBeenCalled(),
      )
      hostSessions.cancelSession()
      decode.reject(new Error('decode failed'))
      await restore

      expect(toastError).not.toHaveBeenCalled()
    })
  })

  it('opens nothing without an active source', async () => {
    const hostSessions = createHostSessions(async () =>
      createRuntimeSession(async () => createDecodedImage()),
    )
    const { result } = renderRestore({
      sessionRef: { current: null },
      hostSessions,
    })

    await result.current.restorePreviewAfterExport()

    expect(hostSessions.beginSession).not.toHaveBeenCalled()
  })

  it('restores the source that is active when it runs, not one from an older render', async () => {
    const runtimeSession = createRuntimeSession(async () =>
      createDecodedImage(),
    )
    const hostSessions = createHostSessions(async () => runtimeSession)
    const sessionRef = { current: createSession() as ImageSession | null }
    const { result } = renderRestore({ sessionRef, hostSessions })
    const restoreFromEarlierRender = result.current.restorePreviewAfterExport

    const nextFile = new File(['raw'], 'next.dng')
    sessionRef.current = createSession('session-next', nextFile)
    await restoreFromEarlierRender()

    expect(hostSessions.open).toHaveBeenCalledWith(
      nextFile,
      expect.any(AbortSignal),
    )
    expect(sessionRef.current?.id).toBe('session-next')
    expect(sessionRef.current?.previewBundle.displaySource).toBe('quick')
  })

  it('refuses an old callback once a replacing load has started, leaving its lease alone', async () => {
    const restored = createRuntimeSession(async () => createDecodedImage())
    const replacement = createRuntimeSession(async () => createDecodedImage())
    const nextFile = new File(['raw'], 'next.dng')
    const hostSessions = createHostSessions(async (file) =>
      file === nextFile ? replacement : restored,
    )
    const setStatus = vi.fn()
    const setProgress = vi.fn()
    const setDecodedImageRef = vi.fn()
    const toastError = freshToastError()
    const sessionRef = { current: createSession() as ImageSession | null }
    const runtimeWorkSessionIdRef = { current: null as string | null }
    const { result } = renderRestore({
      sessionRef,
      runtimeWorkSessionIdRef,
      hostSessions,
      setStatus,
      setProgress,
      setDecodedImageRef,
    })
    const restoreFromReleasedRender = result.current.restorePreviewAfterExport

    // The replacing load takes the host slot, publishes its session, and
    // fences runtime work on it, all before it first yields.
    const loadLease = hostSessions.beginSession()
    sessionRef.current = createLoadingSession('session-next', nextFile)
    runtimeWorkSessionIdRef.current = 'session-next'
    await restoreFromReleasedRender()

    expect(hostSessions.beginSession).toHaveBeenCalledTimes(1)
    expect(loadLease.signal.aborted).toBe(false)
    expect(runtimeWorkSessionIdRef.current).toBe('session-next')
    expect(hostSessions.open).not.toHaveBeenCalled()
    expect(setStatus).not.toHaveBeenCalled()
    expect(setProgress).not.toHaveBeenCalled()
    expect(setDecodedImageRef).not.toHaveBeenCalled()
    expect(toastError).not.toHaveBeenCalled()
    await expect(loadLease.open(nextFile)).resolves.toBe(replacement)
    expect(replacement.dispose).not.toHaveBeenCalled()
  })

  it('refuses an old callback during an initial load without touching its lease', async () => {
    const hostSessions = createHostSessions(async () =>
      createRuntimeSession(async () => createDecodedImage()),
    )
    const setStatus = vi.fn()
    const sessionRef = { current: null as ImageSession | null }
    const runtimeWorkSessionIdRef = { current: null as string | null }
    const { result } = renderRestore({
      sessionRef,
      runtimeWorkSessionIdRef,
      hostSessions,
      setStatus,
    })

    const loadLease = hostSessions.beginSession()
    sessionRef.current = createLoadingSession('session-first')
    runtimeWorkSessionIdRef.current = 'session-first'
    await result.current.restorePreviewAfterExport()

    expect(hostSessions.beginSession).toHaveBeenCalledTimes(1)
    expect(loadLease.signal.aborted).toBe(false)
    expect(runtimeWorkSessionIdRef.current).toBe('session-first')
    expect(setStatus).not.toHaveBeenCalled()
  })

  it('refuses a source no export has released, even with no work running', async () => {
    const hostSessions = createHostSessions(async () =>
      createRuntimeSession(async () => createDecodedImage()),
    )
    const setStatus = vi.fn()
    const { result } = renderRestore({
      sessionRef: { current: createLoadingSession('session-loaded') },
      hostSessions,
      setStatus,
    })

    await result.current.restorePreviewAfterExport()

    expect(hostSessions.beginSession).not.toHaveBeenCalled()
    expect(setStatus).not.toHaveBeenCalled()
  })

  it('refuses while the export that released the preview still runs', async () => {
    const hostSessions = createHostSessions(async () =>
      createRuntimeSession(async () => createDecodedImage()),
    )
    const { result } = renderRestore({
      sessionRef: {
        current: withExportState(createSession(), {
          status: 'exporting',
          result: undefined,
        }),
      },
      hostSessions,
    })

    await result.current.restorePreviewAfterExport()

    expect(hostSessions.beginSession).not.toHaveBeenCalled()
  })

  it('refuses while a decoded frame is still live', async () => {
    const hostSessions = createHostSessions(async () =>
      createRuntimeSession(async () => createDecodedImage()),
    )
    const setDecodedImageRef = vi.fn()
    const { result } = renderRestore({
      sessionRef: { current: createSession() },
      decodedImageRef: { current: createDecodedImage() },
      hostSessions,
      setDecodedImageRef,
    })

    await result.current.restorePreviewAfterExport()

    expect(hostSessions.beginSession).not.toHaveBeenCalled()
    expect(setDecodedImageRef).not.toHaveBeenCalled()
  })

  it('refuses after the workflow unmounted', async () => {
    const hostSessions = createHostSessions(async () =>
      createRuntimeSession(async () => createDecodedImage()),
    )
    const { result } = renderRestore({
      sessionRef: { current: createSession() },
      isMountedRef: { current: false },
      hostSessions,
    })

    await result.current.restorePreviewAfterExport()

    expect(hostSessions.beginSession).not.toHaveBeenCalled()
  })

  it('refuses a second restore while the first holds the lease, and lets the first finish', async () => {
    const quickDecode = deferred<DecodedImage>()
    const runtimeSession = createRuntimeSession(() => quickDecode.promise)
    const hostSessions = createHostSessions(async () => runtimeSession)
    const setDecodedImageRef = vi.fn()
    const runtimeWorkSessionIdRef = { current: null as string | null }
    const { result } = renderRestore({
      sessionRef: { current: createSession() },
      runtimeWorkSessionIdRef,
      hostSessions,
      setDecodedImageRef,
    })

    const first = result.current.restorePreviewAfterExport()
    await vi.waitFor(() => {
      expect(runtimeSession.decodeQuickRaw).toHaveBeenCalled()
    })
    await result.current.restorePreviewAfterExport()

    expect(hostSessions.beginSession).toHaveBeenCalledTimes(1)
    expect(hostSessions.openSignal()?.aborted).toBe(false)
    const decoded = createDecodedImage()
    quickDecode.resolve(decoded)
    await first

    expect(setDecodedImageRef).toHaveBeenCalledTimes(1)
    expect(setDecodedImageRef).toHaveBeenCalledWith(decoded, {
      preserveExportResult: true,
    })
    expect(runtimeWorkSessionIdRef.current).toBeNull()
  })

  it('restores a preview a failed export released', async () => {
    const runtimeSession = createRuntimeSession(async () =>
      createDecodedImage(),
    )
    const hostSessions = createHostSessions(async () => runtimeSession)
    const setDecodedImageRef = vi.fn()
    const { result } = renderRestore({
      sessionRef: {
        current: withExportState(createSession(), {
          status: 'failed',
          result: undefined,
          lastErrorCode: 'EXPORT_RENDER_FAILED',
        }),
      },
      hostSessions,
      setDecodedImageRef,
    })

    await result.current.restorePreviewAfterExport()

    expect(hostSessions.beginSession).toHaveBeenCalledTimes(1)
    expect(setDecodedImageRef).toHaveBeenCalledTimes(1)
  })
})
