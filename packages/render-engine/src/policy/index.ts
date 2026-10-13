// `@lumaforge/render-engine/policy` subpath entry.

export type { CapabilityVector } from './capability-input'

// Policy decisions (migrated from src/lib/runtime)
export {
  deriveExportPolicy,
  type ExportIntent,
  type ExportPolicy,
  type PerformancePreference,
  type PolicyProductCopy,
} from './export-policy'
export type { ExportRuntimeResources } from './export-runtime-resources'
export {
  deriveInteractivePolicy,
  type InteractivePolicy,
  type InteractivePolicyOptions,
} from './interactive-policy'
export type {
  PreviewGpuBudget,
  PreviewGpuCapabilitySnapshot,
} from './preview-gpu-budget'
