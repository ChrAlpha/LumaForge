import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { DecodedImage } from '~/lib/raw/decoder'

import type { ImageSession } from '../../../model/session'
import { useEmbeddedPreviewUrlLifecycle } from '../preview/useEmbeddedPreviewUrlLifecycle'
import type { SetImageSession } from './useRawProcessorLifecycle'
import { useRawProcessorLifecycle } from './useRawProcessorLifecycle'

function createSession(id = 'pending-session'): ImageSession {
  return {
    id,
    createdAt: 1,
    sourceFile: {
      name: 'frame.dng',
      extension: 'dng',
      sizeBytes: 3,
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
      status: 'idle',
      fullResCapability: { status: 'unknown' },
      retryRecommended: false,
    },
  }
}

function createDecodedImage(): DecodedImage {
  return {
    width: 1,
    height: 1,
    channels: 4,
    bitsPerChannel: 32,
    data: new Float32Array(4),
    layout: 'rgba-float32',
    colorSpace: 'linear-prophoto-rgb',
    source: 'quick',
    metadata: { width: 1, height: 1 },
    renderExposure: { ev: 0, multiplier: 1, source: 'identity' },
  }
}

function withEmbeddedPreview(
  session: ImageSession,
  objectUrl: string,
): ImageSession {
  return {
    ...session,
    previewBundle: {
      ...session.previewBundle,
      embeddedPreview: {
        status: 'ready',
        objectUrl,
        width: 1600,
        height: 1200,
        mimeType: 'image/jpeg',
      },
      displaySource: 'embedded',
    },
  }
}

function applySessionUpdate(store: {
  session: ImageSession | null
}): SetImageSession {
  return (update) => {
    store.session =
      typeof update === 'function' ? update(store.session) : update
  }
}

function renderLifecycle(
  refs: {
    pendingLoadSessionId?: string | null
    ownedSessionId?: string | null
    session?: ImageSession | null
  },
  options: { reactStrictMode?: boolean } = {},
) {
  const isMountedRef = { current: false }
  const runtimeWorkSessionIdRef = {
    current: 'runtime-work' as string | null,
  }
  const pendingLoadSessionIdRef = {
    current: refs.pendingLoadSessionId ?? null,
  }
  const decodedImageRef = {
    current: createDecodedImage() as DecodedImage | null,
  }
  const previewCopyCanvasRef = { current: null as HTMLCanvasElement | null }
  // The mount owns the session it published: the pending load, or the
  // session the test names, or else the one the store starts with.
  const ownedSessionIdRef = {
    current:
      refs.ownedSessionId !== undefined
        ? refs.ownedSessionId
        : (refs.pendingLoadSessionId ?? refs.session?.id ?? null),
  }
  const store = { session: refs.session ?? null }
  // A stable store reader, as the workflow's is.
  const getSession = () => store.session
  const calls = {
    abortExportWork: vi.fn(),
    abortRuntimeWork: vi.fn(),
    queueExportResultResourceDisposal: vi.fn(),
    revokeCurrentEmbeddedPreviewUrl: vi.fn(),
    setStatus: vi.fn(),
    setError: vi.fn(),
    setProgress: vi.fn(),
    setStats: vi.fn(),
    setSession: vi.fn<SetImageSession>((update) => {
      store.session =
        typeof update === 'function' ? update(store.session) : update
    }),
  }
  const rendered = renderHook(
    () =>
      useRawProcessorLifecycle({
        isMountedRef,
        runtimeWorkSessionIdRef,
        pendingLoadSessionIdRef,
        decodedImageRef,
        previewCopyCanvasRef,
        ownedSessionIdRef,
        getSession,
        ...calls,
      }),
    options,
  )
  return {
    ...rendered,
    isMountedRef,
    runtimeWorkSessionIdRef,
    pendingLoadSessionIdRef,
    ownedSessionIdRef,
    decodedImageRef,
    store,
    calls,
  }
}

/** Lets a departure the cleanup deferred settle. */
async function settleDeparture() {
  await Promise.resolve()
}

function releaseCounts(calls: ReturnType<typeof renderLifecycle>['calls']) {
  return {
    abortExportWork: calls.abortExportWork.mock.calls.length,
    abortRuntimeWork: calls.abortRuntimeWork.mock.calls.length,
    dispose: calls.queueExportResultResourceDisposal.mock.calls.length,
    revoke: calls.revokeCurrentEmbeddedPreviewUrl.mock.calls.length,
  }
}

describe('useRawProcessorLifecycle', () => {
  it('marks the processor mounted and cleans up pending load state on unmount', () => {
    const isMountedRef = { current: false }
    const runtimeWorkSessionIdRef = { current: 'runtime-work' }
    const pendingLoadSessionIdRef = { current: 'pending-session' }
    const decodedImageRef = { current: createDecodedImage() }
    const previewCopyCanvasRef = {
      current: document.createElement('canvas') as HTMLCanvasElement | null,
    }
    const store = { session: createSession() as ImageSession | null }
    const abortExportWork = vi.fn()
    const abortRuntimeWork = vi.fn()
    const queueExportResultResourceDisposal = vi.fn()
    const revokeCurrentEmbeddedPreviewUrl = vi.fn()
    const setStatus = vi.fn()
    const setError = vi.fn()
    const setProgress = vi.fn()
    const setStats = vi.fn()

    const { unmount } = renderHook(() =>
      useRawProcessorLifecycle({
        isMountedRef,
        runtimeWorkSessionIdRef,
        pendingLoadSessionIdRef,
        decodedImageRef,
        previewCopyCanvasRef,
        ownedSessionIdRef: { current: 'pending-session' },
        getSession: () => store.session,
        abortExportWork,
        abortRuntimeWork,
        queueExportResultResourceDisposal,
        revokeCurrentEmbeddedPreviewUrl,
        setStatus,
        setError,
        setProgress,
        setStats,
        setSession: applySessionUpdate(store),
      }),
    )

    expect(isMountedRef.current).toBe(true)

    unmount()

    expect(isMountedRef.current).toBe(false)
    expect(runtimeWorkSessionIdRef.current).toBeNull()
    expect(pendingLoadSessionIdRef.current).toBeNull()
    expect(abortExportWork).toHaveBeenCalledTimes(1)
    expect(abortRuntimeWork).toHaveBeenCalledTimes(1)
    expect(queueExportResultResourceDisposal).toHaveBeenCalledTimes(1)
    expect(revokeCurrentEmbeddedPreviewUrl).toHaveBeenCalledTimes(1)
    expect(previewCopyCanvasRef.current).toBeNull()
    expect(decodedImageRef.current).toBeNull()
    expect(setStatus).toHaveBeenCalledWith('idle')
    expect(setError).toHaveBeenCalledWith(null)
    expect(setProgress).toHaveBeenCalledWith(0)
    expect(setStats).toHaveBeenCalledWith(null)
    expect(store.session).toBeNull()
  })

  it('clears only its own pending load, leaving a session a newer load put in the store and its status', async () => {
    const newer = createSession('newer-session')
    const lifecycle = renderLifecycle({
      pendingLoadSessionId: 'pending-session',
      session: createSession(),
    })
    // A newer load took the store's slot before this mount departs.
    lifecycle.store.session = newer

    lifecycle.unmount()
    await settleDeparture()

    expect(lifecycle.store.session).toBe(newer)
    expect(lifecycle.calls.setSession).not.toHaveBeenCalled()
    // Its own decoded frame goes; the status and progress are the newer
    // load's, so they stay.
    expect(lifecycle.decodedImageRef.current).toBeNull()
    expect(lifecycle.calls.setStatus).not.toHaveBeenCalled()
    expect(lifecycle.calls.setProgress).not.toHaveBeenCalled()
  })

  it("releases a loaded session's resources once on unmount", () => {
    const lifecycle = renderLifecycle({
      session: createSession('loaded-session'),
    })

    lifecycle.unmount()

    expect(releaseCounts(lifecycle.calls)).toEqual({
      abortExportWork: 1,
      abortRuntimeWork: 1,
      dispose: 1,
      revoke: 1,
    })
    expect(lifecycle.isMountedRef.current).toBe(false)
    expect(lifecycle.runtimeWorkSessionIdRef.current).toBeNull()
    // Unmounting is not a reset, so the result owner gets no cleanup reason.
    expect(
      lifecycle.calls.queueExportResultResourceDisposal,
    ).toHaveBeenCalledExactlyOnceWith()
  })

  it('drops its fences before it cancels, so work settling meanwhile writes nothing', () => {
    const lifecycle = renderLifecycle({
      session: createSession('loaded-session'),
    })
    const settled = vi.fn()
    // Outgoing runtime work settles while its owner is being cancelled; it
    // checks the fence the shared release has already dropped.
    lifecycle.calls.abortRuntimeWork.mockImplementation(() => {
      if (lifecycle.runtimeWorkSessionIdRef.current === 'runtime-work') {
        settled()
      }
    })

    lifecycle.unmount()

    expect(settled).not.toHaveBeenCalled()
    expect(lifecycle.pendingLoadSessionIdRef.current).toBeNull()
  })

  it('fences stale work and releases resources before it drops its pending load', () => {
    const order: string[] = []
    const lifecycle = renderLifecycle({
      pendingLoadSessionId: 'pending-session',
      session: createSession(),
    })
    const fenced = () =>
      `mounted=${String(lifecycle.isMountedRef.current)}:runtime=${String(lifecycle.runtimeWorkSessionIdRef.current)}:pending=${String(lifecycle.pendingLoadSessionIdRef.current)}`
    lifecycle.calls.abortExportWork.mockImplementation(() => {
      order.push(`abortExportWork:${fenced()}`)
    })
    lifecycle.calls.abortRuntimeWork.mockImplementation(() => {
      order.push('abortRuntimeWork')
    })
    lifecycle.calls.queueExportResultResourceDisposal.mockImplementation(() => {
      order.push('dispose')
    })
    lifecycle.calls.revokeCurrentEmbeddedPreviewUrl.mockImplementation(() => {
      order.push('revoke')
    })
    lifecycle.calls.setStatus.mockImplementation(() => {
      order.push(
        `setStatus:decoded=${lifecycle.decodedImageRef.current ? 'set' : 'null'}`,
      )
    })
    const applyUpdate = lifecycle.calls.setSession.getMockImplementation()!
    lifecycle.calls.setSession.mockImplementation((update) => {
      order.push('setSession')
      applyUpdate(update)
    })

    lifecycle.unmount()

    expect(order).toEqual([
      'abortExportWork:mounted=false:runtime=null:pending=null',
      'abortRuntimeWork',
      'dispose',
      'revoke',
      'setStatus:decoded=null',
      'setSession',
    ])
    expect(lifecycle.store.session).toBeNull()
  })

  it('ends the loaded session it owns once the mount has really departed', async () => {
    const lifecycle = renderLifecycle({
      session: createSession('loaded-session'),
    })

    lifecycle.unmount()
    // Departure is confirmed only after the commit: a StrictMode replay
    // would have mounted the workflow again by then.
    expect(lifecycle.store.session?.id).toBe('loaded-session')

    await settleDeparture()

    expect(lifecycle.store.session).toBeNull()
    expect(lifecycle.calls.setSession).toHaveBeenCalledTimes(1)
    expect(lifecycle.decodedImageRef.current).toBeNull()
    expect(lifecycle.calls.setStatus).toHaveBeenCalledExactlyOnceWith('idle')
    expect(lifecycle.calls.setError).toHaveBeenCalledExactlyOnceWith(null)
    expect(lifecycle.calls.setProgress).toHaveBeenCalledExactlyOnceWith(0)
    expect(lifecycle.calls.setStats).toHaveBeenCalledExactlyOnceWith(null)
    // Its resources were released once, in the cleanup itself.
    expect(releaseCounts(lifecycle.calls)).toEqual({
      abortExportWork: 1,
      abortRuntimeWork: 1,
      dispose: 1,
      revoke: 1,
    })
  })

  it('leaves a session it did not publish, and its status, when it departs', async () => {
    const other = createSession('other-mount-session')
    const lifecycle = renderLifecycle({
      ownedSessionId: 'loaded-session',
      session: other,
    })

    lifecycle.unmount()
    await settleDeparture()

    expect(lifecycle.store.session).toBe(other)
    expect(lifecycle.calls.setSession).not.toHaveBeenCalled()
    expect(lifecycle.calls.setStatus).not.toHaveBeenCalled()
  })

  it('leaves a session a new mount publishes before the departure settles', async () => {
    const lifecycle = renderLifecycle({
      session: createSession('loaded-session'),
    })

    lifecycle.unmount()
    // An immediate new mount loads in the same tick as the departure.
    const acquired = createSession('new-mount-session')
    lifecycle.store.session = acquired
    await settleDeparture()

    expect(lifecycle.store.session).toBe(acquired)
    expect(lifecycle.calls.setSession).not.toHaveBeenCalled()
    expect(lifecycle.calls.setStatus).not.toHaveBeenCalled()
  })

  it('ends nothing when it departs without having published a session', async () => {
    const lifecycle = renderLifecycle({ ownedSessionId: null })

    lifecycle.unmount()
    await settleDeparture()

    expect(lifecycle.calls.setSession).not.toHaveBeenCalled()
    expect(lifecycle.calls.setStatus).not.toHaveBeenCalled()
  })

  describe('with the real embedded preview URL owner', () => {
    /**
     * The lifecycle wired to the URL owner the workflow uses, over one store,
     * so a departure revokes and clears through the real cleanup.
     */
    function renderWithUrlOwner(refs: {
      ownedSessionId: string | null
      embeddedPreviewUrl: string | null
      session: ImageSession | null
    }) {
      const store = { session: refs.session }
      const getSession = () => store.session
      const setSession = applySessionUpdate(store)
      const revokeObjectUrls = vi.fn()
      const embeddedPreviewUrlRef = { current: refs.embeddedPreviewUrl }
      const ownedSessionIdRef = { current: refs.ownedSessionId }
      const decodedImageRef = {
        current: createDecodedImage() as DecodedImage | null,
      }
      const setStatus = vi.fn()
      const rendered = renderHook(() => {
        const { revokeCurrentEmbeddedPreviewUrl } =
          useEmbeddedPreviewUrlLifecycle({
            embeddedPreviewUrlRef,
            getSession,
            setSession,
            revokeObjectUrls,
          })
        useRawProcessorLifecycle({
          isMountedRef: { current: false },
          runtimeWorkSessionIdRef: { current: null },
          pendingLoadSessionIdRef: { current: null },
          ownedSessionIdRef,
          decodedImageRef,
          previewCopyCanvasRef: { current: null },
          getSession,
          abortExportWork: vi.fn(),
          abortRuntimeWork: vi.fn(),
          queueExportResultResourceDisposal: vi.fn(),
          revokeCurrentEmbeddedPreviewUrl,
          setStatus,
          setError: vi.fn(),
          setProgress: vi.fn(),
          setStats: vi.fn(),
          setSession,
        })
      })
      const revokedUrls = () =>
        revokeObjectUrls.mock.calls.flatMap(([urls]) =>
          Array.from(urls as Iterable<string>),
        )
      return {
        ...rendered,
        store,
        embeddedPreviewUrlRef,
        revokedUrls,
        setStatus,
      }
    }

    it("revokes only its own URL and leaves another mount's session, URL and preview whole", async () => {
      const other = withEmbeddedPreview(
        createSession('other-mount-session'),
        'blob:other-mount',
      )
      const lifecycle = renderWithUrlOwner({
        ownedSessionId: 'loaded-session',
        embeddedPreviewUrl: 'blob:own-mount',
        session: other,
      })

      lifecycle.unmount()
      await settleDeparture()

      expect(lifecycle.revokedUrls()).toEqual(['blob:own-mount'])
      expect(lifecycle.embeddedPreviewUrlRef.current).toBeNull()
      expect(lifecycle.store.session).toBe(other)
      expect(
        lifecycle.store.session?.previewBundle.embeddedPreview,
      ).toMatchObject({ objectUrl: 'blob:other-mount' })
      expect(lifecycle.setStatus).not.toHaveBeenCalled()
    })

    it('touches no session URL when it departs without having published one', async () => {
      const other = withEmbeddedPreview(
        createSession('other-mount-session'),
        'blob:other-mount',
      )
      const lifecycle = renderWithUrlOwner({
        ownedSessionId: null,
        embeddedPreviewUrl: null,
        session: other,
      })

      lifecycle.unmount()
      await settleDeparture()

      expect(lifecycle.revokedUrls()).toEqual([])
      expect(lifecycle.store.session).toBe(other)
    })

    it('revokes and ends its own session with its preview URL', async () => {
      const own = withEmbeddedPreview(
        createSession('loaded-session'),
        'blob:own-mount',
      )
      const lifecycle = renderWithUrlOwner({
        ownedSessionId: 'loaded-session',
        embeddedPreviewUrl: 'blob:own-mount',
        session: own,
      })

      lifecycle.unmount()
      // The URL goes with the cleanup; the session once departure settles.
      expect(lifecycle.revokedUrls()).toEqual(['blob:own-mount'])
      expect(lifecycle.store.session?.previewBundle.embeddedPreview).toEqual({
        status: 'idle',
      })
      await settleDeparture()

      expect(lifecycle.store.session).toBeNull()
    })
  })

  describe('under StrictMode replay', () => {
    it('runs its cleanup once on mount and ends mounted with the loaded session untouched', async () => {
      const loaded = createSession('loaded-session')
      const lifecycle = renderLifecycle(
        { session: loaded },
        { reactStrictMode: true },
      )
      // The replay's cleanup deferred a departure the replayed setup cancels.
      await settleDeparture()

      expect(lifecycle.isMountedRef.current).toBe(true)
      expect(releaseCounts(lifecycle.calls)).toEqual({
        abortExportWork: 1,
        abortRuntimeWork: 1,
        dispose: 1,
        revoke: 1,
      })
      expect(lifecycle.calls.setSession).not.toHaveBeenCalled()
      expect(lifecycle.store.session).toBe(loaded)

      // A rerender with the same inputs replays nothing.
      lifecycle.rerender()
      expect(releaseCounts(lifecycle.calls).dispose).toBe(1)
      expect(lifecycle.isMountedRef.current).toBe(true)
    })

    it('drops a pending load once, and the repeated cleanup leaves a replacement source', async () => {
      const lifecycle = renderLifecycle(
        {
          pendingLoadSessionId: 'pending-session',
          session: createSession(),
        },
        { reactStrictMode: true },
      )

      // The replay's cleanup dropped the pending load it found.
      expect(lifecycle.calls.setSession).toHaveBeenCalledTimes(1)
      expect(lifecycle.store.session).toBeNull()
      expect(lifecycle.pendingLoadSessionIdRef.current).toBeNull()

      // Another owner's source lands in the store before the real unmount.
      const replacement = createSession('replacement-session')
      lifecycle.store.session = replacement
      lifecycle.decodedImageRef.current = createDecodedImage()

      lifecycle.unmount()
      await settleDeparture()

      expect(releaseCounts(lifecycle.calls).dispose).toBe(2)
      // The repeated cleanup finds no pending load and owns no session.
      expect(lifecycle.calls.setSession).toHaveBeenCalledTimes(1)
      expect(lifecycle.calls.setStatus).toHaveBeenCalledTimes(1)
      expect(lifecycle.store.session).toBe(replacement)
    })

    it('runs its cleanup again on the real unmount after the replay and ends its session once', async () => {
      const lifecycle = renderLifecycle(
        { session: createSession('loaded-session') },
        { reactStrictMode: true },
      )
      await settleDeparture()
      expect(lifecycle.calls.setSession).not.toHaveBeenCalled()

      lifecycle.unmount()
      await settleDeparture()

      expect(lifecycle.isMountedRef.current).toBe(false)
      expect(releaseCounts(lifecycle.calls)).toEqual({
        abortExportWork: 2,
        abortRuntimeWork: 2,
        dispose: 2,
        revoke: 2,
      })
      expect(lifecycle.calls.setSession).toHaveBeenCalledTimes(1)
      expect(lifecycle.store.session).toBeNull()
    })
  })
})
