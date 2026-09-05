import type {
  ExportOrchestrationCopy,
  ExportPolicy,
  PerformancePreference,
} from '@lumaforge/render-engine/policy'
import { deriveExportPolicy } from '@lumaforge/render-engine/policy'

import type { ExportFidelity } from '~/lib/gl/export'
import type { CapabilityVector } from '~/lib/runtime/capability-vector'
import type { ExportRuntimeResources } from '~/lib/runtime/export-runtime-resources'

import type {
  LargeResourceOwner,
  ResourceRegistryCheck,
} from './resource-registry'

export type ExportExecutionProfileName =
  | 'ios-safe'
  | 'mobile-balanced'
  | 'desktop-fast'

export type ExportCheckpointMode = 'safe-retry' | 'row-resume'
export type ExportOutputSink = 'opfs-file' | 'streaming' | 'blob-handoff'
export type ExportRuntimeMemoryProfile = 'low-memory' | 'desktop'

export type ExportPlanSelectedDebugPayload = {
  profile: ExportExecutionProfileName
  derivedLabel: string
  policyVector: ExportPolicy
  preferredRows: number
  concurrency: number
  runtimeMemoryProfile: ExportRuntimeMemoryProfile
  outputSink: ExportOutputSink
  checkpointMode: ExportCheckpointMode
  checkpointDurableExpected: boolean
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

export type ExportExecutionProfile = {
  name: ExportExecutionProfileName
  minRows: number
  maxRows: number
  preferredRowsFor100Mp: number
  preferredRowsBelow100Mp: number
  rowBandRows: number
  initialConcurrency: number
  maxConcurrency: number
  releasePreviewPipelineBeforeExport: boolean
  releaseBoundedHqBufferBeforeExport: boolean
  releasePreviousExportResultBeforeExport: boolean
  checkpointOutput: boolean
  checkpointMode: ExportCheckpointMode
}

export type ExportExecutionPlan = {
  profile: ExportExecutionProfile
  preferredRows: number
  concurrency: number
  maxConcurrency: number
  runtimeMemoryProfile: ExportRuntimeMemoryProfile
  outputSink: ExportOutputSink
  checkpointMode: ExportCheckpointMode
  productCopy: ExportOrchestrationCopy
  derivedLabel: string
  policyVector: ExportPolicy
  sourceWidth?: number
  sourceHeight?: number
  capabilitySnapshot?: CapabilityVector
  runtimeSnapshot?: ExportRuntimeResources
}

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
  checkpointDurableExpected: boolean,
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
    checkpointDurableExpected,
  }
}

export function getImageMegapixels(width?: number, height?: number) {
  if (!width || !height) return 0
  return (width * height) / 1_000_000
}

function chooseProfile(
  derivedPolicy: ExportPolicy,
  capability: CapabilityVector,
): ExportExecutionProfileName {
  if (
    derivedPolicy.workerMemoryProfile === 'desktop' &&
    derivedPolicy.concurrency >= 2 &&
    derivedPolicy.rowSlice >= 512
  ) {
    return 'desktop-fast'
  }
  if (capability.webKitClass === 'webkit-mobile') return 'ios-safe'
  return 'mobile-balanced'
}

type SelectExportExecutionPlanInput = {
  performancePreference?: PerformancePreference
  fidelity?: ExportFidelity
  sourceWidth?: number
  sourceHeight?: number
  previousInterrupted?: boolean
  previousCrashLikeInterruption?: boolean
  previousUserInterrupted?: boolean
  previousResourceFailure?: boolean
  capability: CapabilityVector
  runtime: ExportRuntimeResources
}

function synthesizeProfile(
  profileName: ExportExecutionProfileName,
  policy: ExportPolicy,
): ExportExecutionProfile {
  return {
    name: profileName,
    minRows: 64,
    maxRows: Math.max(64, policy.rowSlice),
    preferredRowsFor100Mp: policy.rowSlice,
    preferredRowsBelow100Mp: policy.rowSlice,
    rowBandRows: 64,
    initialConcurrency: policy.concurrency,
    maxConcurrency: policy.maxConcurrency,
    releasePreviewPipelineBeforeExport: true,
    releaseBoundedHqBufferBeforeExport: true,
    releasePreviousExportResultBeforeExport: true,
    checkpointOutput: true,
    checkpointMode: 'safe-retry',
  }
}

export function selectExportExecutionPlan(
  input: SelectExportExecutionPlanInput,
): ExportExecutionPlan {
  const performancePreference =
    input.performancePreference ?? input.fidelity ?? 'balanced'
  const capability = input.capability
  const runtime = input.runtime
  const policy = deriveExportPolicy(
    capability,
    {
      width: input.sourceWidth ?? 0,
      height: input.sourceHeight ?? 0,
    },
    {
      performancePreference,
      previousResourceFailure: input.previousResourceFailure ?? false,
      previousCrashLikeInterruption:
        input.previousCrashLikeInterruption ??
        input.previousInterrupted ??
        false,
      previousUserInterrupted: input.previousUserInterrupted ?? false,
    },
    runtime,
  )
  const profileName = chooseProfile(policy, capability)
  const profile = synthesizeProfile(profileName, policy)

  return {
    profile,
    preferredRows: policy.rowSlice,
    concurrency: policy.concurrency,
    maxConcurrency: policy.maxConcurrency,
    runtimeMemoryProfile: policy.workerMemoryProfile,
    outputSink: policy.outputSink,
    checkpointMode: profile.checkpointMode,
    productCopy: policy.productCopy,
    derivedLabel: policy.derivedLabel,
    policyVector: policy,
    sourceWidth: input.sourceWidth,
    sourceHeight: input.sourceHeight,
    capabilitySnapshot: capability,
    runtimeSnapshot: runtime,
  }
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
