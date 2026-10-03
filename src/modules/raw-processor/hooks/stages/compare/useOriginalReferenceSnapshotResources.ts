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

export function useOriginalReferenceSnapshotResources({
  resourceRegistryRef,
  releaseSnapshot = releaseOriginalReferenceSnapshot,
}: UseOriginalReferenceSnapshotResourcesInput) {
  const snapshotResourceIdRef = useRef(0)
  const pendingResourceIdRef = useRef(0)
  const snapshotResourceRef = useRef<TrackedLargeResource | null>(null)
  const snapshotResourceKeyRef = useRef<string | null>(null)
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

  const trackOriginalReferenceSnapshot = useCallback(
    (snapshot: OriginalReferenceSnapshot | null) => {
      const currentResource = snapshotResourceRef.current
      const currentResourceKey = snapshotResourceKeyRef.current

      if (currentResource && currentResourceKey !== snapshot?.key) {
        snapshotResourceRef.current = null
        snapshotResourceKeyRef.current = null
        void currentResource.dispose().catch((error) => {
          console.warn('Failed to clean up original reference snapshot:', error)
        })
      }

      if (!snapshot || currentResourceKey === snapshot.key) {
        return
      }

      const registry = resourceRegistryRef.current
      if (!registry) {
        return
      }

      let tracked: TrackedLargeResource | null = null
      tracked = registry.register({
        id: `original-reference-snapshot-${++snapshotResourceIdRef.current}`,
        owner: 'preview',
        kind: 'object-url',
        estimatedBytes: snapshot.estimatedBytes,
        dispose: () => {
          if (snapshotResourceRef.current === tracked) {
            snapshotResourceRef.current = null
            snapshotResourceKeyRef.current = null
          }
          releaseSnapshot(snapshot)
        },
      })
      snapshotResourceRef.current = tracked
      snapshotResourceKeyRef.current = snapshot.key
    },
    [releaseSnapshot, resourceRegistryRef],
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

      const resource = snapshotResourceRef.current
      snapshotResourceRef.current = null
      snapshotResourceKeyRef.current = null
      void resource?.dispose().catch((error) => {
        console.warn('Failed to clean up original reference snapshot:', error)
      })
    }
  }, [])

  return {
    setPendingOriginalReferenceSnapshotRender,
    trackOriginalReferenceSnapshot,
  }
}
