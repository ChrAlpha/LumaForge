import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DecodedImage } from '~/lib/raw/decoder'

import type { ImageSession } from '../../../model/session'
import {
  getCurrentSession,
  setCurrentSession,
} from '../../../state/session.atoms'
import { rawWorkflowStore } from '../../../state/workflow.atoms'
import {
  createTestDecodedImage,
  createTestSession,
} from '../../../test-support/builders'
import { resetToDefaults } from '../../../test-support/workflow-store'
import { useEmbeddedPreviewUrlLifecycle } from '../preview/useEmbeddedPreviewUrlLifecycle'
import { useRawProcessorLifecycle } from './useRawProcessorLifecycle'

beforeEach(() => {
  resetToDefaults()
  setCurrentSession(null)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function withEmbeddedPreview(id: string, objectUrl: string): ImageSession {
  const session = createTestSession({ id })
  return {
    ...session,
    previewBundle: {
      ...session.previewBundle,
      embeddedPreview: { status: 'ready', objectUrl },
      displaySource: 'embedded',
    },
  }
}

/** The processor state a departure clears, as the store's setters see it. */
function spyOnProcessorState() {
  return {
    setStatus: vi.spyOn(rawWorkflowStore, 'setStatus'),
    setError: vi.spyOn(rawWorkflowStore, 'setError'),
    setProgress: vi.spyOn(rawWorkflowStore, 'setProgress'),
    setStats: vi.spyOn(rawWorkflowStore, 'setStats'),
    setSession: vi.spyOn(rawWorkflowStore, 'setSession'),
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
  setCurrentSession(refs.session ?? null)
  const runtime = {
    isMountedRef: { current: false },
    runtimeWorkSessionIdRef: { current: 'runtime-work' as string | null },
    pendingLoadSessionIdRef: { current: refs.pendingLoadSessionId ?? null },
    // The mount owns the session it published: the pending load, or the
    // session the test names, or else the one the store starts with.
    ownedSessionIdRef: {
      current:
        refs.ownedSessionId !== undefined
          ? refs.ownedSessionId
          : (refs.pendingLoadSessionId ?? refs.session?.id ?? null),
    },
    decodedImageRef: {
      current: createTestDecodedImage() as DecodedImage | null,
    },
    previewCopyCanvasRef: {
      current: document.createElement('canvas') as HTMLCanvasElement | null,
    },
  }
  const calls = {
    abortExportWork: vi.fn(),
    abortRuntimeWork: vi.fn(),
    queueExportResultResourceDisposal: vi.fn(),
    revokeCurrentEmbeddedPreviewUrl: vi.fn(),
  }
  const state = spyOnProcessorState()
  const rendered = renderHook(
    () => useRawProcessorLifecycle({ ...runtime, ...calls }),
    options,
  )
  return { ...rendered, ...runtime, calls, state }
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

const ONCE = { abortExportWork: 1, abortRuntimeWork: 1, dispose: 1, revoke: 1 }

describe('useRawProcessorLifecycle', () => {
  it('marks the processor mounted and drops a pending load at once on unmount', () => {
    const lifecycle = renderLifecycle({
      pendingLoadSessionId: 'pending-session',
      session: createTestSession({ id: 'pending-session' }),
    })
    expect(lifecycle.isMountedRef.current).toBe(true)

    lifecycle.unmount()

    expect(lifecycle.isMountedRef.current).toBe(false)
    expect(lifecycle.runtimeWorkSessionIdRef.current).toBeNull()
    expect(lifecycle.pendingLoadSessionIdRef.current).toBeNull()
    expect(lifecycle.previewCopyCanvasRef.current).toBeNull()
    expect(lifecycle.decodedImageRef.current).toBeNull()
    expect(releaseCounts(lifecycle.calls)).toEqual(ONCE)
    expect(lifecycle.state.setStatus).toHaveBeenCalledExactlyOnceWith('idle')
    expect(lifecycle.state.setError).toHaveBeenCalledExactlyOnceWith(null)
    expect(lifecycle.state.setProgress).toHaveBeenCalledExactlyOnceWith(0)
    expect(lifecycle.state.setStats).toHaveBeenCalledExactlyOnceWith(null)
    expect(getCurrentSession()).toBeNull()
  })

  it('clears only its own pending load, leaving a session a newer load put in the store and its status', async () => {
    const lifecycle = renderLifecycle({
      pendingLoadSessionId: 'pending-session',
      session: createTestSession({ id: 'pending-session' }),
    })
    const newer = createTestSession({ id: 'newer-session' })
    setCurrentSession(newer)
    lifecycle.state.setSession.mockClear()

    lifecycle.unmount()
    await settleDeparture()

    expect(getCurrentSession()).toBe(newer)
    expect(lifecycle.state.setSession).not.toHaveBeenCalled()
    // Its own decoded frame goes; the status and progress are the newer
    // load's, so they stay.
    expect(lifecycle.decodedImageRef.current).toBeNull()
    expect(lifecycle.state.setStatus).not.toHaveBeenCalled()
    expect(lifecycle.state.setProgress).not.toHaveBeenCalled()
  })

  it('ends the loaded session it owns once the mount has really departed', async () => {
    const lifecycle = renderLifecycle({
      session: createTestSession({ id: 'loaded-session' }),
    })

    lifecycle.unmount()
    // Departure is confirmed only after the commit: a StrictMode replay
    // would have mounted the workflow again by then.
    expect(getCurrentSession()?.id).toBe('loaded-session')
    expect(releaseCounts(lifecycle.calls)).toEqual(ONCE)

    await settleDeparture()

    expect(getCurrentSession()).toBeNull()
    expect(lifecycle.ownedSessionIdRef.current).toBeNull()
    expect(lifecycle.decodedImageRef.current).toBeNull()
    expect(lifecycle.state.setStatus).toHaveBeenCalledExactlyOnceWith('idle')
    expect(releaseCounts(lifecycle.calls)).toEqual(ONCE)
  })

  it.each([
    ['a session it did not publish', 'loaded-session'],
    ['any session when it published none', null],
  ])('leaves %s, and its status, when it departs', async (_, ownedId) => {
    const other = createTestSession({ id: 'other-mount-session' })
    const lifecycle = renderLifecycle({
      ownedSessionId: ownedId,
      session: other,
    })

    lifecycle.unmount()
    await settleDeparture()

    expect(getCurrentSession()).toBe(other)
    expect(lifecycle.state.setSession).not.toHaveBeenCalled()
    expect(lifecycle.state.setStatus).not.toHaveBeenCalled()
  })

  it('leaves a session a new mount publishes before the departure settles', async () => {
    const lifecycle = renderLifecycle({
      session: createTestSession({ id: 'loaded-session' }),
    })

    lifecycle.unmount()
    // An immediate new mount loads in the same tick as the departure.
    const acquired = createTestSession({ id: 'new-mount-session' })
    setCurrentSession(acquired)
    lifecycle.state.setSession.mockClear()
    await settleDeparture()

    expect(getCurrentSession()).toBe(acquired)
    expect(lifecycle.state.setSession).not.toHaveBeenCalled()
    expect(lifecycle.state.setStatus).not.toHaveBeenCalled()
  })

  describe('with the real embedded preview URL owner', () => {
    /**
     * The lifecycle wired to the URL owner the workflow uses, over the
     * store, so a departure revokes and clears through the real cleanup.
     */
    function renderWithUrlOwner(refs: {
      ownedSessionId: string | null
      embeddedPreviewUrl: string | null
      session: ImageSession | null
    }) {
      setCurrentSession(refs.session)
      const revokeObjectURL = vi.fn()
      vi.stubGlobal(
        'URL',
        Object.assign(class extends URL {}, { revokeObjectURL }),
      )
      const embeddedPreviewUrlRef = { current: refs.embeddedPreviewUrl }
      const state = spyOnProcessorState()
      const rendered = renderHook(() => {
        const { revokeCurrentEmbeddedPreviewUrl } =
          useEmbeddedPreviewUrlLifecycle({
            embeddedPreviewUrlRef,
            ...rawWorkflowStore,
          })
        useRawProcessorLifecycle({
          isMountedRef: { current: false },
          runtimeWorkSessionIdRef: { current: null },
          pendingLoadSessionIdRef: { current: null },
          ownedSessionIdRef: { current: refs.ownedSessionId },
          decodedImageRef: { current: createTestDecodedImage() },
          previewCopyCanvasRef: { current: null },
          abortExportWork: vi.fn(),
          abortRuntimeWork: vi.fn(),
          queueExportResultResourceDisposal: vi.fn(),
          revokeCurrentEmbeddedPreviewUrl,
        })
      })
      const revokedUrls = () =>
        revokeObjectURL.mock.calls.map(([url]) => url as string)
      return { ...rendered, embeddedPreviewUrlRef, revokedUrls, state }
    }

    it("revokes only its own URL and leaves another mount's session, URL and preview whole", async () => {
      const other = withEmbeddedPreview(
        'other-mount-session',
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
      expect(getCurrentSession()).toBe(other)
      expect(lifecycle.state.setStatus).not.toHaveBeenCalled()
    })

    it('touches no session URL when it departs without having published one', async () => {
      const other = withEmbeddedPreview(
        'other-mount-session',
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
      expect(getCurrentSession()).toBe(other)
    })

    it('revokes and ends its own session with its preview URL', async () => {
      const lifecycle = renderWithUrlOwner({
        ownedSessionId: 'loaded-session',
        embeddedPreviewUrl: 'blob:own-mount',
        session: withEmbeddedPreview('loaded-session', 'blob:own-mount'),
      })

      lifecycle.unmount()
      // The URL goes with the cleanup; the session once departure settles.
      expect(lifecycle.revokedUrls()).toEqual(['blob:own-mount'])
      expect(getCurrentSession()?.previewBundle.embeddedPreview).toEqual({
        status: 'idle',
      })
      await settleDeparture()

      expect(getCurrentSession()).toBeNull()
    })
  })

  describe('under StrictMode replay', () => {
    it('runs its cleanup once on mount and ends mounted with the loaded session untouched', async () => {
      const loaded = createTestSession({ id: 'loaded-session' })
      const lifecycle = renderLifecycle(
        { session: loaded },
        { reactStrictMode: true },
      )
      // The replay's cleanup deferred a departure the replayed setup cancels.
      await settleDeparture()

      expect(lifecycle.isMountedRef.current).toBe(true)
      expect(releaseCounts(lifecycle.calls)).toEqual(ONCE)
      expect(lifecycle.state.setSession).not.toHaveBeenCalled()
      expect(getCurrentSession()).toBe(loaded)

      // A rerender with the same inputs replays nothing.
      lifecycle.rerender()
      expect(releaseCounts(lifecycle.calls).dispose).toBe(1)
      expect(lifecycle.isMountedRef.current).toBe(true)
    })

    it('drops a pending load once, and the repeated cleanup leaves a replacement source', async () => {
      const lifecycle = renderLifecycle(
        {
          pendingLoadSessionId: 'pending-session',
          session: createTestSession({ id: 'pending-session' }),
        },
        { reactStrictMode: true },
      )

      // The replay's cleanup dropped the pending load it found.
      expect(lifecycle.state.setSession).toHaveBeenCalledTimes(1)
      expect(getCurrentSession()).toBeNull()
      expect(lifecycle.pendingLoadSessionIdRef.current).toBeNull()

      // Another owner's source lands in the store before the real unmount.
      const replacement = createTestSession({ id: 'replacement-session' })
      setCurrentSession(replacement)
      lifecycle.decodedImageRef.current = createTestDecodedImage()

      lifecycle.unmount()
      await settleDeparture()

      expect(releaseCounts(lifecycle.calls).dispose).toBe(2)
      // The repeated cleanup finds no pending load and owns no session.
      expect(lifecycle.state.setStatus).toHaveBeenCalledTimes(1)
      expect(getCurrentSession()).toBe(replacement)
    })

    it('runs its cleanup again on the real unmount after the replay and ends its session once', async () => {
      const lifecycle = renderLifecycle(
        { session: createTestSession({ id: 'loaded-session' }) },
        { reactStrictMode: true },
      )
      await settleDeparture()
      expect(lifecycle.state.setSession).not.toHaveBeenCalled()

      lifecycle.unmount()
      await settleDeparture()

      expect(lifecycle.isMountedRef.current).toBe(false)
      expect(releaseCounts(lifecycle.calls)).toEqual({
        abortExportWork: 2,
        abortRuntimeWork: 2,
        dispose: 2,
        revoke: 2,
      })
      expect(lifecycle.state.setSession).toHaveBeenCalledTimes(1)
      expect(getCurrentSession()).toBeNull()
    })
  })
})
