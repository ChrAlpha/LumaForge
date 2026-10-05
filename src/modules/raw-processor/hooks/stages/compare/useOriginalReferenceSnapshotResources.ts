import type { MutableRefObject } from 'react'
import { useCallback, useEffect, useRef } from 'react'

import type {
  ResourceRegistry,
  TrackedLargeResource,
} from '~/lib/export/resource-registry'

import type { OriginalReferenceSnapshot } from '../../../services/compare/original-reference-snapshot'
import { releaseOriginalReferenceSnapshot } from '../../../services/compare/original-reference-snapshot'
import type { PendingOriginalReferenceSnapshotRender } from '../../useOriginalReferenceSnapshot'

type UseOriginalReferenceSnapshotResourcesInput = {
  resourceRegistryRef: MutableRefObject<ResourceRegistry | null>
  releaseSnapshot?: typeof releaseOriginalReferenceSnapshot
}

type OwnedOriginalReferenceSnapshot = {
  objectUrl: string
  release: () => void
  resource: TrackedLargeResource | null
}

// Release succeeds at most once per snapshot, whichever of replacement,
// evacuation, discard or unmount reaches it first; a release that throws stays
// retryable.
function ownOriginalReferenceSnapshot(
  snapshot: OriginalReferenceSnapshot,
  releaseSnapshot: typeof releaseOriginalReferenceSnapshot,
): OwnedOriginalReferenceSnapshot {
  let released = false
  return {
    objectUrl: snapshot.objectUrl,
    release: () => {
      if (released) return
      releaseSnapshot(snapshot)
      released = true
    },
    resource: null,
  }
}

function warnSnapshotCleanupFailure(error: unknown) {
  console.warn('Failed to clean up original reference snapshot:', error)
}

// Registered snapshots release through the registry so its live set stays in
// step and a failed release stays visible to export evacuation.
function retireOriginalReferenceSnapshot(
  owned: OwnedOriginalReferenceSnapshot,
) {
  if (owned.resource) {
    void owned.resource.dispose().catch(warnSnapshotCleanupFailure)
    return
  }
  try {
    owned.release()
  } catch (error) {
    warnSnapshotCleanupFailure(error)
  }
}

// Sole owner of original reference snapshot URLs: every resolved snapshot is
// tracked here before it is published, or discarded here if it never will be.
export function useOriginalReferenceSnapshotResources({
  resourceRegistryRef,
  releaseSnapshot = releaseOriginalReferenceSnapshot,
}: UseOriginalReferenceSnapshotResourcesInput) {
  const snapshotResourceIdRef = useRef(0)
  const pendingResourceIdRef = useRef(0)
  const ownedSnapshotRef = useRef<OwnedOriginalReferenceSnapshot | null>(null)
  const pendingResourceRef = useRef<TrackedLargeResource | null>(null)
  const pendingResourceKeyRef = useRef<string | null>(null)

  const setPendingOriginalReferenceSnapshotRender = useCallback(
    (
      pending: PendingOriginalReferenceSnapshotRender | null,
      clearKey?: string,
    ) => {
      const previous = pendingResourceRef.current
      const previousKey = pendingResourceKeyRef.current

      const disposePrevious = (resource: TrackedLargeResource) => {
        pendingResourceRef.current = null
        pendingResourceKeyRef.current = null
        void resource.dispose().catch((error) => {
          console.warn(
            'Failed to clean up pending original reference snapshot:',
            error,
          )
        })
      }

      if (!pending) {
        if (!previous) {
          return
        }
        if (clearKey && previousKey !== clearKey) {
          return
        }
        disposePrevious(previous)
        return
      }

      if (previous && previousKey === pending.key) {
        return
      }

      if (previous) {
        disposePrevious(previous)
      }

      const registry = resourceRegistryRef.current
      if (!registry) {
        return
      }

      let tracked: TrackedLargeResource | null = null
      tracked = registry.register({
        id: `original-reference-snapshot-render-${++pendingResourceIdRef.current}`,
        owner: 'preview',
        kind: 'gpu-pipeline',
        dispose: () => {
          if (pendingResourceRef.current === tracked) {
            pendingResourceRef.current = null
            pendingResourceKeyRef.current = null
          }
          return pending.dispose()
        },
      })
      pendingResourceRef.current = tracked
      pendingResourceKeyRef.current = pending.key
    },
    [resourceRegistryRef],
  )

  // Takes ownership synchronously and retires the previous snapshot unless it
  // shares the URL; `null` retires the current one. An evacuation that runs
  // before React commits the published snapshot therefore still releases it.
  const trackOriginalReferenceSnapshot = useCallback(
    (snapshot: OriginalReferenceSnapshot | null) => {
      const current = ownedSnapshotRef.current
      if (current && current.objectUrl === snapshot?.objectUrl) {
        return
      }

      ownedSnapshotRef.current = null
      if (current) {
        retireOriginalReferenceSnapshot(current)
      }
      if (!snapshot) {
        return
      }

      const owned = ownOriginalReferenceSnapshot(snapshot, releaseSnapshot)
      const registry = resourceRegistryRef.current
      if (registry) {
        owned.resource = registry.register({
          id: `original-reference-snapshot-${++snapshotResourceIdRef.current}`,
          owner: 'preview',
          kind: 'object-url',
          estimatedBytes: snapshot.estimatedBytes,
          dispose: owned.release,
        })
      }
      ownedSnapshotRef.current = owned
    },
    [releaseSnapshot, resourceRegistryRef],
  )

  // Releases a cancelled render's result, including one that settles after
  // unmount, without registering it. A result carrying the owned URL is left
  // to its current owner.
  const discardOriginalReferenceSnapshot = useCallback(
    (snapshot: OriginalReferenceSnapshot) => {
      if (ownedSnapshotRef.current?.objectUrl === snapshot.objectUrl) {
        return
      }
      retireOriginalReferenceSnapshot(
        ownOriginalReferenceSnapshot(snapshot, releaseSnapshot),
      )
    },
    [releaseSnapshot],
  )

  useEffect(() => {
    return () => {
      const pendingResource = pendingResourceRef.current
      pendingResourceRef.current = null
      pendingResourceKeyRef.current = null
      void pendingResource?.dispose().catch((error) => {
        console.warn(
          'Failed to clean up pending original reference snapshot:',
          error,
        )
      })

      const owned = ownedSnapshotRef.current
      ownedSnapshotRef.current = null
      if (owned) {
        retireOriginalReferenceSnapshot(owned)
      }
    }
  }, [])

  return {
    setPendingOriginalReferenceSnapshotRender,
    trackOriginalReferenceSnapshot,
    discardOriginalReferenceSnapshot,
  }
}
