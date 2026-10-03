import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

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
})
