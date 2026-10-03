import type { ExportColorGraphDescriptor } from '@lumaforge/luma-color-runtime'

import type {
  ExportExecutionProfileName,
  ExportResourceCleanupDebugPayload,
  ExportResourceCleanupReason,
  ExportResourceEvacuatedDebugPayload,
} from '~/lib/export/execution-profile'
import type {
  LargeResourceOwner,
  ResourceRegistry,
  ResourceRegistryCheck,
  ResourceRegistrySnapshot,
} from '~/lib/export/resource-registry'

export type PreExportSnapshot = {
  file: File
  metadata: unknown
  graph?: ExportColorGraphDescriptor
  graphFingerprint: string
  lutTitle?: string
  quickPreviewReady: boolean
  tone: unknown
  color?: unknown
  style: unknown
}

export function createPreExportSnapshot(
  input: PreExportSnapshot,
): PreExportSnapshot {
  return { ...input }
}

export class ExportEvacuationError extends Error {
  readonly code = 'EXPORT_RESOURCE_EVICTION_INCOMPLETE'

  constructor(
    message = 'Export resources could not be evacuated.',
    cause?: unknown,
  ) {
    super(message, { cause })
    this.name = 'ExportEvacuationError'
  }
}

const PRE_EXPORT_DISPOSABLE_OWNERS: LargeResourceOwner[] = [
  'preview',
  'bounded-hq',
  'gpu',
  'export-result',
  'lut-fetch',
]

export function getPreExportEvacuationOwners(
  _profile: ExportExecutionProfileName,
): LargeResourceOwner[] {
  return [...PRE_EXPORT_DISPOSABLE_OWNERS]
}

export type ExportEvacuationResult = {
  snapshot: PreExportSnapshot
  registryCheck: ResourceRegistryCheck
  requiredOwners: LargeResourceOwner[]
  disposedOwners: LargeResourceOwner[]
  remainingLive: ResourceRegistrySnapshot['live']
  estimatedBytesByOwner: ResourceRegistrySnapshot['estimatedBytesByOwner']
  totalEstimatedBytes: number
  evacuatedAt: string
}

function toDebugRegistryCheck(
  check: ResourceRegistryCheck,
): ResourceRegistryCheck {
  if (check.ok) return { ok: true }

  return {
    ok: false,
    live: check.live.map(({ id, owner, kind }) => ({
      id,
      owner,
      kind,
    })),
  }
}

export function toResourceEvacuatedDebugPayload(input: {
  profile: ExportExecutionProfileName
  evacuation: ExportEvacuationResult
}): ExportResourceEvacuatedDebugPayload {
  return {
    profile: input.profile,
    requiredOwners: input.evacuation.requiredOwners,
    disposedOwners: input.evacuation.disposedOwners,
    registryCheck: toDebugRegistryCheck(input.evacuation.registryCheck),
    remainingLive: input.evacuation.remainingLive.map(
      ({ id, owner, kind, estimatedBytes }) => ({
        id,
        owner,
        kind,
        estimatedBytes,
      }),
    ),
    estimatedBytesByOwner: input.evacuation.estimatedBytesByOwner,
    totalEstimatedBytes: input.evacuation.totalEstimatedBytes,
    evacuatedAt: input.evacuation.evacuatedAt,
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
    registryCheck: toDebugRegistryCheck(input.registryCheck),
    remainingLive: input.snapshot.live.map(
      ({ id, owner, kind, estimatedBytes }) => ({
        id,
        owner,
        kind,
        estimatedBytes,
      }),
    ),
    estimatedBytesByOwner: input.snapshot.estimatedBytesByOwner,
    totalEstimatedBytes: input.snapshot.totalEstimatedBytes,
    cleanedAt: input.cleanedAt ?? new Date().toISOString(),
  }
}

function hasOwner(owners: LargeResourceOwner[], owner: LargeResourceOwner) {
  return owners.includes(owner)
}

export async function evacuateBeforeExport(input: {
  registry: ResourceRegistry
  snapshot: PreExportSnapshot
  owners: LargeResourceOwner[]
  abortPreview?: () => void
  abortBoundedHq?: () => void
  releasePreviousExportResult?: () => void
  stopLutFetches?: () => void
}): Promise<ExportEvacuationResult> {
  const owners = [...input.owners]

  try {
    if (hasOwner(owners, 'preview') || hasOwner(owners, 'gpu')) {
      input.abortPreview?.()
    }
    if (hasOwner(owners, 'bounded-hq')) {
      input.abortBoundedHq?.()
    }
    if (hasOwner(owners, 'export-result')) {
      input.releasePreviousExportResult?.()
    }
    if (hasOwner(owners, 'lut-fetch')) {
      input.stopLutFetches?.()
    }

    await input.registry.disposeOwners(owners)
  } catch (error) {
    throw new ExportEvacuationError(
      'Export resources could not be evacuated before worker start.',
      error,
    )
  }

  const registryCheck = input.registry.assertZeroLive(owners)
  const snapshot = input.registry.snapshot()

  return {
    snapshot: input.snapshot,
    registryCheck,
    requiredOwners: owners,
    disposedOwners: owners,
    remainingLive: snapshot.live,
    estimatedBytesByOwner: snapshot.estimatedBytesByOwner,
    totalEstimatedBytes: snapshot.totalEstimatedBytes,
    evacuatedAt: new Date().toISOString(),
  }
}
