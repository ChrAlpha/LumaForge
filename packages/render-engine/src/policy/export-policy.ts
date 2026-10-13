import type { CapabilityVector } from './capability-input'
import type { ExportRuntimeResources } from './export-runtime-resources'
import { deriveRuntimeResourceBudget } from './resource-budget'

export type PolicyProductCopy =
  | 'high-performance'
  | 'safe-export'
  | 'resource-retry'
  | 'interrupted-retry'
  | 'non-durable-checkpoint'
  | 'cannot-safely-complete'

export type PerformancePreference = 'safe' | 'balanced' | 'max'

export interface ExportIntent {
  readonly performancePreference: PerformancePreference
  readonly previousResourceFailure: boolean
  readonly previousCrashLikeInterruption: boolean
}

export interface ExportPolicy {
  readonly rowSlice: number
  readonly concurrency: number
  readonly maxConcurrency: number
  readonly workerMemoryProfile: 'low-memory' | 'desktop'
  readonly outputSink: 'opfs-file' | 'blob-handoff'
  readonly productCopy: PolicyProductCopy
  readonly derivedLabel: string
}

const LARGE_EXPORT_MEGAPIXEL_THRESHOLD = 50

const OPFS_SAFETY_MARGIN_MB = 64
const OPFS_MB_PER_MEGAPIXEL = 4

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function preferenceWeight(preference: PerformancePreference): number {
  return preference === 'safe' ? 1 : preference === 'balanced' ? 2 : 3
}

export function deriveExportPolicy(
  cap: CapabilityVector,
  image: { width: number; height: number },
  intent: ExportIntent,
  runtime: ExportRuntimeResources,
): ExportPolicy {
  const megapixels = (image.width * image.height) / 1_000_000
  const budget = deriveRuntimeResourceBudget(cap)
  const mobileFormFactor =
    cap.deviceFormFactor === 'mobile' || cap.webKitClass === 'webkit-mobile'

  let rowSlice = 512
  if (megapixels >= 100) rowSlice /= 2
  rowSlice = Math.min(rowSlice, budget.exportRowSliceCeiling)
  if (intent.previousResourceFailure) rowSlice /= 2
  if (intent.previousCrashLikeInterruption) rowSlice /= 4
  rowSlice = clamp(Math.floor(rowSlice), 64, 2048)

  const threadBudget = Math.max(1, cap.hwConcurrency - 1)
  let maxConcurrency = cap.pthread
    ? Math.min(threadBudget, budget.exportConcurrencyCeiling)
    : 1
  if (intent.previousResourceFailure || intent.previousCrashLikeInterruption) {
    maxConcurrency = 1
  }
  maxConcurrency = Math.max(1, maxConcurrency)
  const concurrency = clamp(
    preferenceWeight(intent.performancePreference),
    1,
    maxConcurrency,
  )

  const workerMemoryProfile = budget.workerMemoryProfile

  const opfsFits =
    runtime.opfsSinkAvailable &&
    runtime.opfsAvailableMB != null &&
    runtime.opfsAvailableMB >
      megapixels * OPFS_MB_PER_MEGAPIXEL + OPFS_SAFETY_MARGIN_MB
  const outputSink: ExportPolicy['outputSink'] = opfsFits
    ? 'opfs-file'
    : 'blob-handoff'

  let productCopy: PolicyProductCopy
  if (
    megapixels > LARGE_EXPORT_MEGAPIXEL_THRESHOLD &&
    outputSink === 'blob-handoff' &&
    mobileFormFactor
  ) {
    productCopy = 'cannot-safely-complete'
  } else if (intent.previousCrashLikeInterruption) {
    productCopy = 'interrupted-retry'
  } else if (intent.previousResourceFailure) {
    productCopy = 'resource-retry'
  } else if (
    outputSink === 'blob-handoff' &&
    megapixels > LARGE_EXPORT_MEGAPIXEL_THRESHOLD
  ) {
    productCopy = 'non-durable-checkpoint'
  } else if (
    workerMemoryProfile === 'desktop' &&
    concurrency >= 2 &&
    rowSlice >= 512
  ) {
    productCopy = 'high-performance'
  } else {
    productCopy = 'safe-export'
  }

  const derivedLabel = `${workerMemoryProfile}-thr${concurrency}-rs${rowSlice}-${outputSink}-wk${cap.webKitClass}-ff${cap.deviceFormFactor}`

  return Object.freeze({
    rowSlice,
    concurrency,
    maxConcurrency,
    workerMemoryProfile,
    outputSink,
    productCopy,
    derivedLabel,
  })
}
