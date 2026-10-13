import type {
  ExportResourceCleanupDebugPayload,
  ExportResourceCleanupReason,
  ExportResourceEvacuatedDebugPayload,
} from '~/lib/export/execution-profile'
import type { ExportExecutionProfileName } from '~/lib/export/export-plan'
import type {
  LargeResourceOwner,
  ResourceRegistry,
  ResourceRegistryCheck,
  ResourceRegistrySnapshot,
} from '~/lib/export/resource-registry'

/** Every owner a full-resolution export releases before its worker starts. */
const EXPORT_EVACUATION_OWNERS: readonly LargeResourceOwner[] = [
  'preview',
  'bounded-hq',
  'gpu',
  'export-result',
  'lut-fetch',
]

/** What the registry still holds, without its internals or dispose hooks. */
function reportRegistry(
  check: ResourceRegistryCheck,
  snapshot: ResourceRegistrySnapshot,
): Pick<
  ExportResourceEvacuatedDebugPayload,
  | 'registryCheck'
  | 'remainingLive'
  | 'estimatedBytesByOwner'
  | 'totalEstimatedBytes'
> {
  return {
    registryCheck: check,
    remainingLive: snapshot.live.map(({ id, owner, kind, estimatedBytes }) => ({
      id,
      owner,
      kind,
      estimatedBytes,
    })),
    estimatedBytesByOwner: snapshot.estimatedBytesByOwner,
    totalEstimatedBytes: snapshot.totalEstimatedBytes,
  }
}

export function toResourceCleanupDebugPayload(input: {
  reason: ExportResourceCleanupReason
  disposedOwners: LargeResourceOwner[]
  registryCheck: ResourceRegistryCheck
  snapshot: ResourceRegistrySnapshot
  cleanedAt?: string
}): ExportResourceCleanupDebugPayload {
  return {
    reason: input.reason,
    disposedOwners: input.disposedOwners,
    ...reportRegistry(input.registryCheck, input.snapshot),
    cleanedAt: input.cleanedAt ?? new Date().toISOString(),
  }
}

/**
 * Stops the preview's work, drops the previous result, and disposes every
 * evacuated owner, then reports what is still live. The export starts its
 * worker only when that report's registry check passes; a dispose that
 * throws fails the export with `EXPORT_RESOURCE_EVICTION_INCOMPLETE`.
 */
export async function evacuateBeforeExport(input: {
  registry: ResourceRegistry
  profile: ExportExecutionProfileName
  stopPreview: () => void
  releasePreviousExportResult: () => void
}): Promise<ExportResourceEvacuatedDebugPayload> {
  const owners = [...EXPORT_EVACUATION_OWNERS]
  try {
    input.stopPreview()
    input.releasePreviousExportResult()
    await input.registry.disposeOwners(owners)
  } catch (error) {
    throw Object.assign(
      new Error(
        'Export resources could not be evacuated before worker start.',
        {
          cause: error,
        },
      ),
      { code: 'EXPORT_RESOURCE_EVICTION_INCOMPLETE' },
    )
  }
  return {
    profile: input.profile,
    requiredOwners: owners,
    disposedOwners: owners,
    ...reportRegistry(
      input.registry.assertZeroLive(owners),
      input.registry.snapshot(),
    ),
    evacuatedAt: new Date().toISOString(),
  }
}
