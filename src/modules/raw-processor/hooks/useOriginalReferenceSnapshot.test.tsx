import { act, renderHook, waitFor } from '@testing-library/react'

import type { DecodedImage } from '~/lib/raw/decoder'

import type { DisplaySource } from '../model/session'
import type { OriginalReferenceSnapshot } from '../services/compare/original-reference-snapshot'
import { useOriginalReferenceSnapshot } from './useOriginalReferenceSnapshot'

function createImage(
  source: 'quick' | 'bounded-hq',
  width = 1600,
): DecodedImage {
  return {
    width,
    height: 1000,
    channels: 3,
    bitsPerChannel: 16,
    data: new Uint16Array(width * 1000 * 3),
    layout: 'rgb-u16',
    colorSpace: 'linear-prophoto-rgb',
    source,
    metadata: { width, height: 1000 },
    renderExposure: { ev: 0, multiplier: 1, source: 'identity' },
  }
}

function createOwner() {
  return {
    trackSnapshot:
      vi.fn<(snapshot: OriginalReferenceSnapshot | null) => void>(),
    discardSnapshot: vi.fn<(snapshot: OriginalReferenceSnapshot) => void>(),
  }
}

function trackedUrls(owner: ReturnType<typeof createOwner>) {
  return owner.trackSnapshot.mock.calls.map(
    ([snapshot]) => snapshot?.objectUrl ?? null,
  )
}

describe('useOriginalReferenceSnapshot', () => {
  it('creates a snapshot and keeps it stable across style-only rerenders', async () => {
    const renderSnapshot = vi.fn().mockResolvedValue({
      key: 'key-a',
      objectUrl: 'blob:a',
      width: 100,
      height: 50,
      source: 'quick',
      mimeType: 'image/jpeg',
      estimatedBytes: 10,
    })

    const image = createImage('quick')
    const owner = createOwner()
    const { result, rerender } = renderHook(
      ({ styleVersion }) =>
        useOriginalReferenceSnapshot({
          sessionId: 'session-a',
          image,
          imageVersion: 1,
          displaySource: 'quick',
          capability: { webKitClass: 'chromium', pthread: true },
          styleVersion,
          renderSnapshot,
          ...owner,
        }),
      { initialProps: { styleVersion: 1 } },
    )

    await waitFor(() =>
      expect(result.current.snapshot?.objectUrl).toBe('blob:a'),
    )
    rerender({ styleVersion: 2 })

    expect(renderSnapshot).toHaveBeenCalledTimes(1)
    expect(trackedUrls(owner)).toEqual(['blob:a'])
  })

  it('hands a resolved snapshot to its owner before publishing it', async () => {
    const published: Array<OriginalReferenceSnapshot | null> = []
    const publishedWhenTracked: Array<OriginalReferenceSnapshot | null> = []
    const owner = createOwner()
    owner.trackSnapshot.mockImplementation(() => {
      publishedWhenTracked.push(published.at(-1) ?? null)
    })
    const renderSnapshot = vi.fn().mockResolvedValue({
      key: 'key-a',
      objectUrl: 'blob:a',
      width: 100,
      height: 50,
      source: 'quick',
      mimeType: 'image/jpeg',
      estimatedBytes: 10,
    })

    const image = createImage('quick')
    const { result } = renderHook(() => {
      const value = useOriginalReferenceSnapshot({
        sessionId: 'session-a',
        image,
        imageVersion: 1,
        displaySource: 'quick',
        capability: { webKitClass: 'chromium', pthread: true },
        renderSnapshot,
        ...owner,
      })
      published.push(value.snapshot)
      return value
    })

    await waitFor(() =>
      expect(result.current.snapshot?.objectUrl).toBe('blob:a'),
    )
    expect(trackedUrls(owner)).toEqual(['blob:a'])
    expect(publishedWhenTracked).toEqual([null])
    expect(owner.discardSnapshot).not.toHaveBeenCalled()
  })

  it('keeps the old snapshot visible until bounded HQ replacement is ready', async () => {
    let resolveSecond!: (value: unknown) => void
    const renderSnapshot = vi
      .fn()
      .mockResolvedValueOnce({
        key: 'quick-key',
        objectUrl: 'blob:quick',
        width: 100,
        height: 50,
        source: 'quick' as const,
        mimeType: 'image/jpeg',
        estimatedBytes: 10,
      })
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveSecond = resolve
        }),
      )
    const owner = createOwner()

    const { result, rerender } = renderHook(
      ({ image, displaySource, imageVersion }) =>
        useOriginalReferenceSnapshot({
          sessionId: 'session-a',
          image,
          imageVersion,
          displaySource,
          capability: { webKitClass: 'chromium', pthread: true },
          renderSnapshot,
          ...owner,
        }),
      {
        initialProps: {
          image: createImage('quick'),
          displaySource: 'quick' as DisplaySource,
          imageVersion: 1,
        },
      },
    )

    await waitFor(() =>
      expect(result.current.snapshot?.objectUrl).toBe('blob:quick'),
    )

    rerender({
      image: createImage('bounded-hq', 2400),
      displaySource: 'bounded-hq' as DisplaySource,
      imageVersion: 2,
    })

    expect(result.current.snapshot?.objectUrl).toBe('blob:quick')
    expect(trackedUrls(owner)).toEqual(['blob:quick'])
    resolveSecond({
      key: 'hq-key',
      objectUrl: 'blob:hq',
      width: 200,
      height: 100,
      source: 'bounded-hq',
      mimeType: 'image/jpeg',
      estimatedBytes: 20,
    })

    await waitFor(() =>
      expect(result.current.snapshot?.objectUrl).toBe('blob:hq'),
    )
    // Tracking the replacement is what retires the quick snapshot.
    expect(trackedUrls(owner)).toEqual(['blob:quick', 'blob:hq'])
    expect(owner.discardSnapshot).not.toHaveBeenCalled()
  })

  it('hands the replacement to its owner when the quick source changes', async () => {
    const owner = createOwner()
    const renderSnapshot = vi
      .fn()
      .mockResolvedValueOnce({
        key: 'quick-key-a',
        objectUrl: 'blob:quick-a',
        width: 100,
        height: 50,
        source: 'quick',
        mimeType: 'image/jpeg',
        estimatedBytes: 10,
      })
      .mockResolvedValueOnce({
        key: 'quick-key-b',
        objectUrl: 'blob:quick-b',
        width: 120,
        height: 60,
        source: 'quick',
        mimeType: 'image/jpeg',
        estimatedBytes: 12,
      })

    const { result, rerender } = renderHook(
      ({ image, imageVersion }) =>
        useOriginalReferenceSnapshot({
          sessionId: 'session-a',
          image,
          imageVersion,
          displaySource: 'quick',
          capability: { webKitClass: 'chromium', pthread: true },
          renderSnapshot,
          ...owner,
        }),
      {
        initialProps: {
          image: createImage('quick'),
          imageVersion: 1,
        },
      },
    )

    await waitFor(() =>
      expect(result.current.snapshot?.objectUrl).toBe('blob:quick-a'),
    )

    rerender({
      image: createImage('quick', 1800),
      imageVersion: 2,
    })

    await waitFor(() =>
      expect(result.current.snapshot?.objectUrl).toBe('blob:quick-b'),
    )
    expect(trackedUrls(owner)).toEqual(['blob:quick-a', 'blob:quick-b'])
  })

  it('hands the snapshot back and clears it when the source becomes ineligible', async () => {
    const owner = createOwner()
    const renderSnapshot = vi.fn().mockResolvedValue({
      key: 'quick-key-a',
      objectUrl: 'blob:quick-a',
      width: 100,
      height: 50,
      source: 'quick',
      mimeType: 'image/jpeg',
      estimatedBytes: 10,
    })

    const { result, rerender } = renderHook(
      ({ image, displaySource }) =>
        useOriginalReferenceSnapshot({
          sessionId: 'session-a',
          image,
          imageVersion: 1,
          displaySource,
          capability: { webKitClass: 'chromium', pthread: true },
          renderSnapshot,
          ...owner,
        }),
      {
        initialProps: {
          image: createImage('quick') as DecodedImage | null,
          displaySource: 'quick' as DisplaySource,
        },
      },
    )

    await waitFor(() =>
      expect(result.current.snapshot?.objectUrl).toBe('blob:quick-a'),
    )

    rerender({
      image: null,
      displaySource: 'none' as DisplaySource,
    })

    await waitFor(() => expect(result.current.snapshot).toBeNull())
    expect(trackedUrls(owner)).toEqual(['blob:quick-a', null])
  })

  it('hands the snapshot back and clears it when the session becomes unavailable', async () => {
    const owner = createOwner()
    const renderSnapshot = vi.fn().mockResolvedValue({
      key: 'quick-key-a',
      objectUrl: 'blob:quick-a',
      width: 100,
      height: 50,
      source: 'quick',
      mimeType: 'image/jpeg',
      estimatedBytes: 10,
    })

    const image = createImage('quick')

    const { result, rerender } = renderHook(
      ({ sessionId }) =>
        useOriginalReferenceSnapshot({
          sessionId,
          image,
          imageVersion: 1,
          displaySource: 'quick',
          capability: { webKitClass: 'chromium', pthread: true },
          renderSnapshot,
          ...owner,
        }),
      {
        initialProps: {
          sessionId: 'session-a' as string | null,
        },
      },
    )

    await waitFor(() =>
      expect(result.current.snapshot?.objectUrl).toBe('blob:quick-a'),
    )

    rerender({ sessionId: null })

    await waitFor(() => expect(result.current.snapshot).toBeNull())
    expect(trackedUrls(owner)).toEqual(['blob:quick-a', null])
  })

  it('clears the previous session snapshot while the replacement is pending', async () => {
    let resolveReplacement!: (value: OriginalReferenceSnapshot) => void
    const owner = createOwner()
    const replacementPromise = new Promise<OriginalReferenceSnapshot>(
      (resolve) => {
        resolveReplacement = resolve
      },
    )
    const renderSnapshot = vi.fn(
      ({ key }): Promise<OriginalReferenceSnapshot> => {
        if (String(key).includes('session-b')) {
          return replacementPromise
        }

        return Promise.resolve({
          key: 'quick-key-a',
          objectUrl: 'blob:quick-a',
          width: 100,
          height: 50,
          source: 'quick',
          mimeType: 'image/jpeg',
          estimatedBytes: 10,
        })
      },
    )
    const image = createImage('quick')

    const { result, rerender } = renderHook(
      ({ sessionId }) =>
        useOriginalReferenceSnapshot({
          sessionId,
          image,
          imageVersion: 1,
          displaySource: 'quick',
          capability: { webKitClass: 'chromium', pthread: true },
          renderSnapshot,
          ...owner,
        }),
      {
        initialProps: {
          sessionId: 'session-a',
        },
      },
    )

    await waitFor(() =>
      expect(result.current.snapshot?.objectUrl).toBe('blob:quick-a'),
    )

    rerender({ sessionId: 'session-b' })

    expect(result.current.snapshot).toBeNull()
    expect(trackedUrls(owner)).toEqual(['blob:quick-a', null])

    resolveReplacement({
      key: 'quick-key-b',
      objectUrl: 'blob:quick-b',
      width: 120,
      height: 60,
      source: 'quick',
      mimeType: 'image/jpeg',
      estimatedBytes: 12,
    })

    await waitFor(() =>
      expect(result.current.snapshot?.objectUrl).toBe('blob:quick-b'),
    )
    expect(trackedUrls(owner)).toEqual(['blob:quick-a', null, 'blob:quick-b'])
  })

  it('discards a cancelled replacement snapshot when it resolves late', async () => {
    let resolveReplacement!: (value: unknown) => void
    const owner = createOwner()
    const renderSnapshot = vi
      .fn()
      .mockResolvedValueOnce({
        key: 'quick-key',
        objectUrl: 'blob:quick',
        width: 100,
        height: 50,
        source: 'quick',
        mimeType: 'image/jpeg',
        estimatedBytes: 10,
      })
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveReplacement = resolve
        }),
      )

    const { result, rerender } = renderHook(
      ({ image, displaySource, imageVersion }) =>
        useOriginalReferenceSnapshot({
          sessionId: 'session-a',
          image,
          imageVersion,
          displaySource,
          capability: { webKitClass: 'chromium', pthread: true },
          renderSnapshot,
          ...owner,
        }),
      {
        initialProps: {
          image: createImage('quick') as DecodedImage | null,
          displaySource: 'quick' as DisplaySource,
          imageVersion: 1,
        },
      },
    )

    await waitFor(() =>
      expect(result.current.snapshot?.objectUrl).toBe('blob:quick'),
    )

    rerender({
      image: createImage('bounded-hq', 2400),
      displaySource: 'bounded-hq' as DisplaySource,
      imageVersion: 2,
    })
    rerender({
      image: null,
      displaySource: 'none' as DisplaySource,
      imageVersion: 2,
    })

    await waitFor(() => expect(result.current.snapshot).toBeNull())

    resolveReplacement({
      key: 'hq-key',
      objectUrl: 'blob:hq',
      width: 200,
      height: 100,
      source: 'bounded-hq',
      mimeType: 'image/jpeg',
      estimatedBytes: 20,
    })

    await waitFor(() =>
      expect(owner.discardSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({ objectUrl: 'blob:hq' }),
      ),
    )
    expect(owner.discardSnapshot).toHaveBeenCalledTimes(1)
    expect(trackedUrls(owner)).toEqual(['blob:quick', null])
    expect(result.current.snapshot).toBeNull()
  })

  it('discards a snapshot that completes after unmount', async () => {
    let resolveLate!: (value: OriginalReferenceSnapshot) => void
    const owner = createOwner()
    const renderSnapshot = vi.fn().mockReturnValue(
      new Promise<OriginalReferenceSnapshot>((resolve) => {
        resolveLate = resolve
      }),
    )

    const { unmount } = renderHook(() =>
      useOriginalReferenceSnapshot({
        sessionId: 'session-a',
        image: createImage('quick'),
        imageVersion: 1,
        displaySource: 'quick',
        capability: { webKitClass: 'chromium', pthread: true },
        renderSnapshot,
        ...owner,
      }),
    )

    await waitFor(() => expect(renderSnapshot).toHaveBeenCalledTimes(1))
    const signal = renderSnapshot.mock.calls[0]?.[0]?.signal as AbortSignal
    unmount()
    expect(signal.aborted).toBe(true)

    resolveLate({
      key: 'quick-key',
      objectUrl: 'blob:late',
      width: 100,
      height: 50,
      source: 'quick',
      mimeType: 'image/jpeg',
      estimatedBytes: 10,
    })

    await waitFor(() =>
      expect(owner.discardSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({ objectUrl: 'blob:late' }),
      ),
    )
    expect(owner.trackSnapshot).not.toHaveBeenCalled()
  })

  it('clears pending render notifications by key so stale renders cannot clear newer work', async () => {
    let resolveQuick!: (value: OriginalReferenceSnapshot) => void
    let resolveHq!: (value: OriginalReferenceSnapshot) => void
    const pendingChanges: Array<{
      key: string | null
      clearKey: string | null
      dispose?: () => Promise<void>
    }> = []
    const renderSnapshot = vi
      .fn()
      .mockReturnValueOnce(
        new Promise<OriginalReferenceSnapshot>((resolve) => {
          resolveQuick = resolve
        }),
      )
      .mockReturnValueOnce(
        new Promise<OriginalReferenceSnapshot>((resolve) => {
          resolveHq = resolve
        }),
      )
    const owner = createOwner()

    const { rerender } = renderHook(
      ({ image, displaySource, imageVersion }) =>
        useOriginalReferenceSnapshot({
          sessionId: 'session-a',
          image,
          imageVersion,
          displaySource,
          capability: { webKitClass: 'chromium', pthread: true },
          renderSnapshot,
          ...owner,
          onPendingRenderChange: (pending, clearKey) => {
            pendingChanges.push({
              key: pending?.key ?? null,
              clearKey: clearKey ?? null,
              dispose: pending?.dispose,
            })
          },
        }),
      {
        initialProps: {
          image: createImage('quick'),
          displaySource: 'quick' as DisplaySource,
          imageVersion: 1,
        },
      },
    )

    await waitFor(() => expect(pendingChanges[0]?.key).toContain('quick'))
    const quickKey = pendingChanges[0]?.key
    expect(quickKey).toBeTruthy()

    rerender({
      image: createImage('bounded-hq', 2400),
      displaySource: 'bounded-hq' as DisplaySource,
      imageVersion: 2,
    })

    await waitFor(() =>
      expect(
        pendingChanges.some((change) => change.key?.includes('bounded-hq')),
      ).toBe(true),
    )
    const boundedKey = pendingChanges.find((change) =>
      change.key?.includes('bounded-hq'),
    )?.key
    expect(boundedKey).toBeTruthy()

    await act(async () => {
      resolveQuick({
        key: quickKey ?? 'quick-key',
        objectUrl: 'blob:quick',
        width: 100,
        height: 50,
        source: 'quick',
        mimeType: 'image/jpeg',
        estimatedBytes: 10,
      })
    })

    await waitFor(() =>
      expect(
        pendingChanges.some(
          (change) => change.key === null && change.clearKey?.includes('quick'),
        ),
      ).toBe(true),
    )
    expect(
      pendingChanges.some(
        (change) => change.key === null && change.clearKey === boundedKey,
      ),
    ).toBe(false)

    await act(async () => {
      resolveHq({
        key: boundedKey ?? 'hq-key',
        objectUrl: 'blob:hq',
        width: 200,
        height: 100,
        source: 'bounded-hq',
        mimeType: 'image/jpeg',
        estimatedBytes: 20,
      })
    })
  })

  it('reports fallback when generation fails', async () => {
    const owner = createOwner()
    const { result } = renderHook(() =>
      useOriginalReferenceSnapshot({
        sessionId: 'session-a',
        image: createImage('quick'),
        imageVersion: 1,
        displaySource: 'quick',
        capability: { webKitClass: 'chromium', pthread: true },
        renderSnapshot: vi
          .fn()
          .mockRejectedValue(
            new Error('ORIGINAL_REFERENCE_SNAPSHOT_ENCODE_FAILED'),
          ),
        ...owner,
      }),
    )

    await waitFor(() =>
      expect(result.current.fallbackReason).toBe(
        'ORIGINAL_REFERENCE_SNAPSHOT_ENCODE_FAILED',
      ),
    )
  })

  it('uses a generic fallback reason when generation fails without a message', async () => {
    const emptyMessageError = new Error('snapshot failed without a message')
    emptyMessageError.message = ''
    const owner = createOwner()

    const { result } = renderHook(() =>
      useOriginalReferenceSnapshot({
        sessionId: 'session-a',
        image: createImage('quick'),
        imageVersion: 1,
        displaySource: 'quick',
        capability: { webKitClass: 'chromium', pthread: true },
        renderSnapshot: vi.fn().mockRejectedValue(emptyMessageError),
        ...owner,
      }),
    )

    await waitFor(() =>
      expect(result.current.fallbackReason).toBe(
        'ORIGINAL_REFERENCE_SNAPSHOT_FAILED',
      ),
    )
  })

  it('uses an Error-like rejection message as the fallback reason', async () => {
    const owner = createOwner()
    const { result } = renderHook(() =>
      useOriginalReferenceSnapshot({
        sessionId: 'session-a',
        image: createImage('quick'),
        imageVersion: 1,
        displaySource: 'quick',
        capability: { webKitClass: 'chromium', pthread: true },
        renderSnapshot: vi.fn().mockRejectedValue({
          message: 'ORIGINAL_REFERENCE_SNAPSHOT_TIMEOUT',
        }),
        ...owner,
      }),
    )

    await waitFor(() =>
      expect(result.current.fallbackReason).toBe(
        'ORIGINAL_REFERENCE_SNAPSHOT_TIMEOUT',
      ),
    )
  })

  it('hands the current snapshot back on unmount', async () => {
    const owner = createOwner()
    const renderSnapshot = vi.fn().mockResolvedValue({
      key: 'key-a',
      objectUrl: 'blob:a',
      width: 100,
      height: 50,
      source: 'quick',
      mimeType: 'image/jpeg',
      estimatedBytes: 10,
    })

    const image = createImage('quick')

    const { result, unmount } = renderHook(() =>
      useOriginalReferenceSnapshot({
        sessionId: 'session-a',
        image,
        imageVersion: 1,
        displaySource: 'quick',
        capability: { webKitClass: 'chromium', pthread: true },
        renderSnapshot,
        ...owner,
      }),
    )

    await waitFor(() =>
      expect(result.current.snapshot?.objectUrl).toBe('blob:a'),
    )

    unmount()

    expect(trackedUrls(owner)).toEqual(['blob:a', null])
    expect(owner.discardSnapshot).not.toHaveBeenCalled()
  })
})
