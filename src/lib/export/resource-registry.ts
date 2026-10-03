export type LargeResourceOwner =
  | 'preview'
  | 'bounded-hq'
  | 'gpu'
  | 'export-result'
  | 'export-worker'
  | 'lut-fetch'

export type LargeResourceKind =
  | 'worker'
  | 'raw-session'
  | 'gpu-pipeline'
  | 'array-buffer'
  | 'blob'
  | 'object-url'
  | 'abort-controller'

export type LargeResourceRecord = {
  id: string
  owner: LargeResourceOwner
  kind: LargeResourceKind
  estimatedBytes?: number
  dispose: () => void | Promise<void>
}

export type LiveLargeResource = {
  id: string
  owner: LargeResourceOwner
  kind: LargeResourceKind
  estimatedBytes?: number
}

export type TrackedLargeResource = Omit<LargeResourceRecord, 'dispose'> & {
  readonly disposed: boolean
  dispose: () => Promise<void>
}

export type ResourceRegistrySnapshot = {
  live: LiveLargeResource[]
  liveByOwner: Partial<Record<LargeResourceOwner, number>>
  estimatedBytesByOwner: Partial<Record<LargeResourceOwner, number>>
  totalEstimatedBytes: number
}

export type ResourceRegistryCheck =
  | { ok: true }
  | {
      ok: false
      live: Array<Pick<LiveLargeResource, 'id' | 'owner' | 'kind'>>
    }

function compareLiveResources(
  left: Pick<LiveLargeResource, 'id' | 'owner' | 'kind'>,
  right: Pick<LiveLargeResource, 'id' | 'owner' | 'kind'>,
) {
  return (
    left.id.localeCompare(right.id) ||
    left.owner.localeCompare(right.owner) ||
    left.kind.localeCompare(right.kind)
  )
}

function toLiveResource(resource: TrackedLargeResource): LiveLargeResource {
  return {
    id: resource.id,
    owner: resource.owner,
    kind: resource.kind,
    estimatedBytes: resource.estimatedBytes,
  }
}

export function createResourceRegistry() {
  const resources = new Map<string, TrackedLargeResource>()

  return {
    register(record: LargeResourceRecord): TrackedLargeResource {
      if (resources.has(record.id)) {
        throw new Error(`RESOURCE_REGISTRY_DUPLICATE_ID:${record.id}`)
      }

      let disposed = false
      let disposing: Promise<void> | null = null
      const tracked: TrackedLargeResource = {
        id: record.id,
        owner: record.owner,
        kind: record.kind,
        estimatedBytes: record.estimatedBytes,
        get disposed() {
          return disposed
        },
        async dispose() {
          if (disposed) return
          if (disposing) return disposing

          disposing = (async () => {
            await record.dispose()
            disposed = true
            resources.delete(record.id)
          })()

          try {
            await disposing
          } finally {
            if (!disposed) {
              disposing = null
            }
          }
        },
      }

      resources.set(record.id, tracked)
      return tracked
    },

    snapshot(): ResourceRegistrySnapshot {
      const live = Array.from(resources.values(), toLiveResource).sort(
        compareLiveResources,
      )
      const liveByOwner: Partial<Record<LargeResourceOwner, number>> = {}
      const estimatedBytesByOwner: Partial<Record<LargeResourceOwner, number>> =
        {}
      let totalEstimatedBytes = 0

      for (const resource of live) {
        liveByOwner[resource.owner] = (liveByOwner[resource.owner] ?? 0) + 1

        const estimatedBytes = resource.estimatedBytes ?? 0
        if (estimatedBytes > 0) {
          estimatedBytesByOwner[resource.owner] =
            (estimatedBytesByOwner[resource.owner] ?? 0) + estimatedBytes
          totalEstimatedBytes += estimatedBytes
        }
      }

      return {
        live,
        liveByOwner,
        estimatedBytesByOwner,
        totalEstimatedBytes,
      }
    },

    async disposeOwners(owners: LargeResourceOwner[]) {
      const ownerSet = new Set(owners)
      const matches = [...resources.values()]
        .filter((resource) => ownerSet.has(resource.owner))
        .sort(compareLiveResources)

      for (const resource of matches) {
        await resource.dispose()
      }
    },

    assertZeroLive(owners: LargeResourceOwner[]): ResourceRegistryCheck {
      const ownerSet = new Set(owners)
      const live = [...resources.values()]
        .filter((resource) => ownerSet.has(resource.owner))
        .map(({ id, owner, kind }) => ({ id, owner, kind }))
        .sort(compareLiveResources)

      if (live.length === 0) {
        return { ok: true }
      }

      return { ok: false, live }
    },
  }
}

export type ResourceRegistry = ReturnType<typeof createResourceRegistry>
