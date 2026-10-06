import type { ExportPolicy } from '@lumaforge/render-engine/policy'

import type {
  ExportCheckpointMode,
  ExportExecutionPlan,
  ExportExecutionProfileName,
  ExportOutputSink,
  ExportRuntimeMemoryProfile,
} from './export-plan'
import type {
  LargeResourceOwner,
  ResourceRegistryCheck,
} from './resource-registry'

export type {
  ExportCheckpointMode,
  ExportExecutionProfileName,
  ExportOutputSink,
  ExportRuntimeMemoryProfile,
} from './export-plan'

export type ExportPlanSelectedDebugPayload = {
  profile: ExportExecutionProfileName
  derivedLabel: string
  policyVector: ExportPolicy
  preferredRows: number
  concurrency: number
  runtimeMemoryProfile: ExportRuntimeMemoryProfile
  outputSink: ExportOutputSink
  checkpointMode: ExportCheckpointMode
  /** Always false: no export state outlives the tab, whatever the sink. */
  checkpointDurableExpected: false
}

export type ExportResourceEvacuatedDebugPayload = {
  profile: ExportExecutionProfileName
  requiredOwners: LargeResourceOwner[]
  disposedOwners: LargeResourceOwner[]
  registryCheck: ResourceRegistryCheck
  remainingLive: Array<{
    id: string
    owner: LargeResourceOwner
    kind: string
    estimatedBytes?: number
  }>
  estimatedBytesByOwner: Partial<Record<LargeResourceOwner, number>>
  totalEstimatedBytes: number
  evacuatedAt: string
}

export type ExportResourceCleanupReason = 'reset-session'

export type ExportResourceCleanupDebugPayload = {
  reason: ExportResourceCleanupReason
  disposedOwners: LargeResourceOwner[]
  registryCheck: ResourceRegistryCheck
  remainingLive: Array<{
    id: string
    owner: LargeResourceOwner
    kind: string
    estimatedBytes?: number
  }>
  estimatedBytesByOwner: Partial<Record<LargeResourceOwner, number>>
  totalEstimatedBytes: number
  cleanedAt: string
}

export type ExportCheckpointWrittenDebugPayload = {
  exportId: string
  completedRowsForDiagnostics: number
  totalRows: number
  updatedAt: string
}

export type ExportWorkerAttemptDebugPayload = {
  attempt: number
  profile?: ExportExecutionProfileName
  preferredRows?: number
  concurrency?: number
  phase: 'started' | 'retry-scheduled' | 'disposed'
  retryReason?: string
  previousRows?: number
  nextRows?: number
  previousConcurrency?: number
  nextConcurrency?: number
  freshWorker: boolean
  priorClientDisposed?: boolean
}

export type ExportProgressDebugPayload = {
  completedStrips: number
  totalStrips: number
  progress: number
  recordedAt: string
}

export type ExportOutputMaterializedDebugPayload = {
  action: 'download' | 'share' | 'copy' | 'manifest'
  outputKind: ExportOutputSink | 'blob' | 'file-backed' | 'bytes'
  filename: string
  byteLength: number
  materializedAt: string
  cleanup: 'scheduled' | 'not-needed' | 'completed'
}

export type ExportManifestReadyDebugPayload = {
  manifestSha256: string
  outputSha256: string
  sourceSha256: string
  filename: string
  producedAt: string
}

export type ExportManifestFailedDebugPayload = {
  reason: string
  message: string
}

/** One best-effort pass over OPFS outputs left behind by closed tabs. */
export type ExportOpfsOutputCollectionDebugPayload = {
  /** Names listed from `active/`. */
  scannedEntries: number
  /** Listed entries that cost a lock probe or storage reads. */
  examinedEntries: number
  removedEntries: string[]
  keptEntries: number
  skippedEntries: number
  /** Entries were left for a later pass. */
  truncated: boolean
  /** Swallowed storage errors; `entry` is null when `active/` itself failed. */
  failures: Array<{ entry: string | null; message: string }>
}

export type ExportOpfsOutputTabLockFailedDebugPayload = {
  message: string
}

export type ExportDebugEvent =
  | {
      type: 'export-plan-selected'
      payload: ExportPlanSelectedDebugPayload
    }
  | {
      type: 'resource-evacuated'
      payload: ExportResourceEvacuatedDebugPayload
    }
  | {
      type: 'resource-cleanup'
      payload: ExportResourceCleanupDebugPayload
    }
  | {
      type: 'checkpoint-written'
      payload: ExportCheckpointWrittenDebugPayload
    }
  | {
      type: 'export-worker-attempt'
      payload: ExportWorkerAttemptDebugPayload
    }
  | {
      type: 'export-progress'
      payload: ExportProgressDebugPayload
    }
  | {
      type: 'output-materialized'
      payload: ExportOutputMaterializedDebugPayload
    }
  | {
      type: 'export-manifest-ready'
      payload: ExportManifestReadyDebugPayload
    }
  | {
      type: 'export-manifest-failed'
      payload: ExportManifestFailedDebugPayload
    }
  | {
      type: 'opfs-output-collection'
      payload: ExportOpfsOutputCollectionDebugPayload
    }
  | {
      type: 'opfs-output-tab-lock-failed'
      payload: ExportOpfsOutputTabLockFailedDebugPayload
    }

type RecordedExportDebugEvent = {
  recordedAt: string
  event: ExportDebugEvent
}

type ExportDebugWindow = Window & {
  __LUMAFORGE_EXPORT_DEBUG_HISTORY__?: RecordedExportDebugEvent[]
}

const exportDebugEventStorageKey = 'lumaforge.exportDebugEvents.v1'
const exportDebugEventHistoryLimit = 256
const exportDebugCheckpointPersistRows = 1024

function getExportDebugWindow() {
  return window as unknown as ExportDebugWindow
}

function readStoredExportDebugEvents() {
  const debugWindow = getExportDebugWindow()
  if (Array.isArray(debugWindow.__LUMAFORGE_EXPORT_DEBUG_HISTORY__)) {
    return debugWindow.__LUMAFORGE_EXPORT_DEBUG_HISTORY__
  }

  try {
    const raw = window.localStorage.getItem(exportDebugEventStorageKey)
    if (!raw) {
      debugWindow.__LUMAFORGE_EXPORT_DEBUG_HISTORY__ = []
      return []
    }
    const parsed = JSON.parse(raw)
    const history = Array.isArray(parsed)
      ? (parsed as RecordedExportDebugEvent[])
      : []
    debugWindow.__LUMAFORGE_EXPORT_DEBUG_HISTORY__ = history
    return history
  } catch {
    debugWindow.__LUMAFORGE_EXPORT_DEBUG_HISTORY__ = []
    return []
  }
}

function persistExportDebugEvent(event: ExportDebugEvent) {
  try {
    const debugWindow = getExportDebugWindow()
    const history = readStoredExportDebugEvents()
    const next = [
      ...history,
      {
        recordedAt: new Date().toISOString(),
        event,
      },
    ].slice(-exportDebugEventHistoryLimit)
    debugWindow.__LUMAFORGE_EXPORT_DEBUG_HISTORY__ = next
    if (!shouldPersistExportDebugEvent(event)) return

    window.localStorage.setItem(
      exportDebugEventStorageKey,
      JSON.stringify(next),
    )
  } catch {
    // Diagnostics must not affect export control flow.
  }
}

function shouldPersistExportDebugEvent(event: ExportDebugEvent) {
  if (event.type === 'export-progress') return false
  if (event.type !== 'checkpoint-written') return true

  const { completedRowsForDiagnostics, totalRows } = event.payload
  if (completedRowsForDiagnostics <= 0) return true
  if (completedRowsForDiagnostics >= totalRows) return true
  return completedRowsForDiagnostics % exportDebugCheckpointPersistRows === 0
}

export function emitExportDebugEvent(event: ExportDebugEvent) {
  if (typeof window === 'undefined') return

  persistExportDebugEvent(event)
  window.dispatchEvent(
    new CustomEvent('lumaforge-export-debug', { detail: event }),
  )
}

export function toExportPlanSelectedDebugPayload(
  plan: ExportExecutionPlan,
): ExportPlanSelectedDebugPayload {
  return {
    profile: plan.profile.name,
    derivedLabel: plan.derivedLabel,
    policyVector: plan.policyVector,
    preferredRows: plan.preferredRows,
    concurrency: plan.concurrency,
    runtimeMemoryProfile: plan.runtimeMemoryProfile,
    outputSink: plan.outputSink,
    checkpointMode: plan.checkpointMode,
    checkpointDurableExpected: false,
  }
}

export function getImageMegapixels(width?: number, height?: number) {
  if (!width || !height) return 0
  return (width * height) / 1_000_000
}

type ExportModeCopyTranslator = (key: 'raw.export.highPerformance') => string

export function getExportModeCopy(
  key: ExportExecutionPlan['productCopy'],
  t?: ExportModeCopyTranslator,
) {
  const copy: Record<ExportExecutionPlan['productCopy'], string> = {
    'high-performance':
      t?.('raw.export.highPerformance') ??
      'Using high-performance full-resolution export.',
    'safe-export':
      'This device is using low-memory export mode. Export may take longer.',
    'resource-retry':
      'Export hit a browser memory limit. Retrying with a safer setting.',
    'interrupted-retry':
      'The browser interrupted the previous export. LumaForge will retry with a safer low-memory setting.',
    'interrupted-source-needed':
      'The browser interrupted the previous export. Please reselect the same RAW file so LumaForge can retry with a safer setting.',
    'non-durable-checkpoint':
      'This browser cannot store export progress. Keep the tab open while the JPEG is being written.',
    'cannot-safely-complete':
      'This browser cannot safely complete this large local full-resolution export without durable file storage. Use a secure browser URL with OPFS enabled, try a desktop browser, or export a smaller version.',
  }

  return copy[key]
}
