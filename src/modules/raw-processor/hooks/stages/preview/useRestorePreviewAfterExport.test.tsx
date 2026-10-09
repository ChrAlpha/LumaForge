import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { DecodedImage, ProgressCallback } from '~/lib/raw/decoder'
import { createRawRuntimeSessionLeases } from '~/lib/raw/raw-runtime-host'
import type { RawRuntimeSession } from '~/lib/raw/runtime-adapter'

import type { ImageSession } from '../../../model/session'
import { createTransformState } from '../../../model/session-factory'
import type { SetImageSession } from './useRestorePreviewAfterExport'
import { useRestorePreviewAfterExport } from './useRestorePreviewAfterExport'

function createSession(
  id = 'session-restore',
  file = new File(['raw'], 'restore.dng'),
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
    renderState: { status: 'idle' },
    exportState: {
      status: 'ready',
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

function createRuntimeSession(
  decodeQuickRaw: RawRuntimeSession['decodeQuickRaw'],
): RawRuntimeSession {
  return {
    sourceDimensions: { width: 640, height: 480 },
    extractEmbeddedPreview: vi.fn(),
    decodeQuickRaw: vi.fn(decodeQuickRaw),
    decodeBoundedHqRaw: vi.fn(),
    applyCalibration: vi.fn().mockResolvedValue({ applied: true } as const),
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
  rawRenderExposureRef?: { current: DecodedImage['renderExposure'] | null }
  isMountedRef?: { current: boolean }
  runtimeWorkSessionIdRef?: { current: string | null }
  hostSessions: ReturnType<typeof createHostSessions>
  setStatus?: ReturnType<typeof vi.fn>
  setProgress?: ReturnType<typeof vi.fn>
  setDecodedImageRef?: ReturnType<typeof vi.fn>
  toastError?: ReturnType<typeof vi.fn>
}) {
  const scheduleToast = vi.fn((notify: () => void) => notify())
  const rendered = renderHook(() =>
    useRestorePreviewAfterExport({
      getSession: () => input.sessionRef.current,
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
      toast: { error: input.toastError ?? vi.fn() },
    }),
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
      timings: { decodeMs: 12 },
    })
    expect(sessionRef.current?.previewBundle.displaySource).toBe('quick')
    expect(sessionRef.current?.renderState).toEqual({
      status: 'ready',
      lastRenderSource: 'quick',
    })
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
    sessionRef.current = createSession('session-next')
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
    const toastError = vi.fn()
    const sessionRef = { current: createSession() as ImageSession | null }
    const runtimeWorkSessionIdRef = { current: null as string | null }
    const { result } = renderRestore({
      sessionRef,
      runtimeWorkSessionIdRef,
      hostSessions,
      setDecodedImageRef,
      setStatus,
      toastError,
    })

    const restore = result.current.restorePreviewAfterExport()
    await vi.waitFor(() => {
      expect(restored.decodeQuickRaw).toHaveBeenCalled()
    })
    expect(runtimeWorkSessionIdRef.current).toBe('session-restore')

    // A replacing load publishes its session and takes the host's slot.
    const nextFile = new File(['raw'], 'next.dng')
    sessionRef.current = createSession('session-next', nextFile)
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
    const toastError = vi.fn()
    const sessionRef = { current: createSession() as ImageSession | null }
    const { result } = renderRestore({
      sessionRef,
      hostSessions,
      setDecodedImageRef,
      toastError,
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
    const toastError = vi.fn()
    const sessionRef = { current: createSession() as ImageSession | null }
    const { result } = renderRestore({ sessionRef, hostSessions, toastError })

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
    const toastError = vi.fn()
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
      toastError,
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
    const toastError = vi.fn()
    const { result } = renderRestore({
      sessionRef: { current: createSession() },
      hostSessions,
      toastError,
    })

    await result.current.restorePreviewAfterExport()

    expect(toastError).toHaveBeenCalledWith('Preview restore failed', {
      description: 'open failed',
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
})
