import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createResourceRegistry } from '~/lib/export/resource-registry'

import type { OriginalReferenceSnapshot } from '../../../services/compare/original-reference-snapshot'
import { useOriginalReferenceSnapshotResources } from './useOriginalReferenceSnapshotResources'

function createSnapshot(key: string): OriginalReferenceSnapshot {
  return {
    key,
    objectUrl: `blob:${key}`,
    width: 1600,
    height: 1200,
    source: 'bounded-hq',
    mimeType: 'image/jpeg',
    estimatedBytes: 240_000,
  }
}

describe('useOriginalReferenceSnapshotResources', () => {
  const revokeObjectURL = vi.fn()

  beforeEach(() => {
    revokeObjectURL.mockReset()
    vi.stubGlobal(
      'URL',
      Object.assign(class extends URL {}, { revokeObjectURL }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('registers the active original reference snapshot as a preview resource', async () => {
    const registry = createResourceRegistry()
    const snapshot = createSnapshot('snapshot-a')
    const releaseSnapshot = vi.fn()

    const { result } = renderHook(() =>
      useOriginalReferenceSnapshotResources({
        resourceRegistryRef: { current: registry },
        releaseSnapshot,
      }),
    )

    act(() => {
      result.current.trackOriginalReferenceSnapshot(snapshot)
    })

    expect(registry.snapshot().live).toEqual([
      {
        id: 'original-reference-snapshot-1',
        owner: 'preview',
        kind: 'object-url',
        estimatedBytes: 240_000,
      },
    ])

    await registry.disposeOwners(['preview'])

    expect(releaseSnapshot).toHaveBeenCalledWith(snapshot)
  })

  it('disposes the previous snapshot resource when the snapshot key changes', async () => {
    const registry = createResourceRegistry()
    const snapshotA = createSnapshot('snapshot-a')
    const snapshotB = createSnapshot('snapshot-b')
    const releaseSnapshot = vi.fn()

    const hook = renderHook(() =>
      useOriginalReferenceSnapshotResources({
        resourceRegistryRef: { current: registry },
        releaseSnapshot,
      }),
    )

    act(() => {
      hook.result.current.trackOriginalReferenceSnapshot(snapshotA)
    })
    act(() => {
      hook.result.current.trackOriginalReferenceSnapshot(snapshotB)
    })

    await waitFor(() => {
      expect(releaseSnapshot).toHaveBeenCalledWith(snapshotA)
      expect(registry.snapshot().live).toEqual([
        {
          id: 'original-reference-snapshot-2',
          owner: 'preview',
          kind: 'object-url',
          estimatedBytes: 240_000,
        },
      ])
    })

    await registry.disposeOwners(['preview'])

    expect(releaseSnapshot).toHaveBeenCalledWith(snapshotB)
  })

  it('tracks pending original-reference renders and clears them by key', async () => {
    const registry = createResourceRegistry()
    const pendingDispose = vi.fn().mockResolvedValue(undefined)

    const { result } = renderHook(() =>
      useOriginalReferenceSnapshotResources({
        resourceRegistryRef: { current: registry },
      }),
    )

    act(() => {
      result.current.setPendingOriginalReferenceSnapshotRender({
        key: 'pending-a',
        dispose: pendingDispose,
      })
    })

    expect(registry.snapshot().live).toEqual([
      {
        id: 'original-reference-snapshot-render-1',
        owner: 'preview',
        kind: 'gpu-pipeline',
      },
    ])

    act(() => {
      result.current.setPendingOriginalReferenceSnapshotRender(
        null,
        'other-key',
      )
    })
    expect(pendingDispose).not.toHaveBeenCalled()

    act(() => {
      result.current.setPendingOriginalReferenceSnapshotRender(
        null,
        'pending-a',
      )
    })
    await vi.waitFor(() => expect(pendingDispose).toHaveBeenCalledTimes(1))
    expect(registry.snapshot().live).toEqual([])
  })

  it('revokes each owned snapshot URL exactly once across evacuation, replacement and unmount', async () => {
    const registry = createResourceRegistry()
    const snapshotA = createSnapshot('idempotent-a')
    const snapshotB = createSnapshot('idempotent-b')

    const { result, unmount } = renderHook(() =>
      useOriginalReferenceSnapshotResources({
        resourceRegistryRef: { current: registry },
      }),
    )

    act(() => {
      result.current.trackOriginalReferenceSnapshot(snapshotA)
    })
    await registry.disposeOwners(['preview'])
    await registry.disposeOwners(['preview'])
    expect(revokeObjectURL.mock.calls).toEqual([[snapshotA.objectUrl]])

    act(() => {
      result.current.trackOriginalReferenceSnapshot(snapshotA)
      result.current.discardOriginalReferenceSnapshot(snapshotA)
      result.current.trackOriginalReferenceSnapshot(snapshotB)
    })
    await waitFor(() =>
      expect(registry.snapshot().live).toEqual([
        expect.objectContaining({
          id: 'original-reference-snapshot-2',
          kind: 'object-url',
        }),
      ]),
    )
    expect(revokeObjectURL.mock.calls).toEqual([[snapshotA.objectUrl]])

    act(() => {
      result.current.trackOriginalReferenceSnapshot(null)
      result.current.trackOriginalReferenceSnapshot(null)
    })
    unmount()
    await registry.disposeOwners(['preview'])

    expect(revokeObjectURL.mock.calls).toEqual([
      [snapshotA.objectUrl],
      [snapshotB.objectUrl],
    ])
    expect(registry.assertZeroLive(['preview'])).toEqual({ ok: true })
  })

  it('keeps a snapshot tracked again under the same URL as one owned resource', async () => {
    const registry = createResourceRegistry()
    const snapshot = createSnapshot('same-url')

    const { result } = renderHook(() =>
      useOriginalReferenceSnapshotResources({
        resourceRegistryRef: { current: registry },
      }),
    )

    act(() => {
      result.current.trackOriginalReferenceSnapshot(snapshot)
      result.current.trackOriginalReferenceSnapshot({
        ...snapshot,
        key: 'same-url-next-key',
      })
      result.current.discardOriginalReferenceSnapshot({
        ...snapshot,
        key: 'same-url-stale-key',
      })
    })

    expect(revokeObjectURL).not.toHaveBeenCalled()
    expect(registry.snapshot().live).toEqual([
      expect.objectContaining({ id: 'original-reference-snapshot-1' }),
    ])

    await registry.disposeOwners(['preview'])

    expect(revokeObjectURL.mock.calls).toEqual([[snapshot.objectUrl]])
  })

  it('owns tracked snapshots without a resource registry', () => {
    const snapshotA = createSnapshot('no-registry-a')
    const snapshotB = createSnapshot('no-registry-b')

    const { result, unmount } = renderHook(() =>
      useOriginalReferenceSnapshotResources({
        resourceRegistryRef: { current: null },
      }),
    )

    act(() => {
      result.current.trackOriginalReferenceSnapshot(snapshotA)
      result.current.trackOriginalReferenceSnapshot(snapshotB)
    })
    expect(revokeObjectURL.mock.calls).toEqual([[snapshotA.objectUrl]])

    unmount()

    expect(revokeObjectURL.mock.calls).toEqual([
      [snapshotA.objectUrl],
      [snapshotB.objectUrl],
    ])
  })

  it('discards results that were never tracked, with or without a registry', () => {
    const registryRef = {
      current: null as ReturnType<typeof createResourceRegistry> | null,
    }
    const unpublishedA = createSnapshot('unpublished-a')
    const unpublishedB = createSnapshot('unpublished-b')

    const { result, unmount } = renderHook(() =>
      useOriginalReferenceSnapshotResources({
        resourceRegistryRef: registryRef,
      }),
    )

    act(() => {
      result.current.discardOriginalReferenceSnapshot(unpublishedA)
    })
    unmount()
    registryRef.current = createResourceRegistry()
    act(() => {
      result.current.discardOriginalReferenceSnapshot(unpublishedB)
    })

    expect(revokeObjectURL.mock.calls).toEqual([
      [unpublishedA.objectUrl],
      [unpublishedB.objectUrl],
    ])
    expect(registryRef.current.snapshot().live).toEqual([])
  })

  it('keeps a snapshot resource live when its release throws so evacuation can fail closed', async () => {
    const registry = createResourceRegistry()
    const snapshot = createSnapshot('release-throws')
    const releaseSnapshot = vi.fn().mockImplementationOnce(() => {
      throw new Error('snapshot release failed')
    })

    const { result, unmount } = renderHook(() =>
      useOriginalReferenceSnapshotResources({
        resourceRegistryRef: { current: registry },
        releaseSnapshot,
      }),
    )

    act(() => {
      result.current.trackOriginalReferenceSnapshot(snapshot)
    })

    await expect(registry.disposeOwners(['preview'])).rejects.toThrow(
      'snapshot release failed',
    )
    expect(registry.snapshot().live).toEqual([
      expect.objectContaining({ id: 'original-reference-snapshot-1' }),
    ])

    await registry.disposeOwners(['preview'])
    unmount()

    expect(releaseSnapshot).toHaveBeenCalledTimes(2)
    expect(registry.assertZeroLive(['preview'])).toEqual({ ok: true })
  })
})
