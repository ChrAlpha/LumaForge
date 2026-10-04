// `@lumaforge/render-engine/policy` subpath entry.

export type { CapabilityVector } from './capability-input'
export { NODE_DEFAULT_CAPABILITY } from './capability-input'
export type { ExportFidelity } from './export-fidelity'
export type { RenderBudget } from './render-budget'

// Policy decisions (migrated from src/lib/runtime)
export {
  deriveExportPolicy,
  type ExportIntent,
  type ExportOrchestrationCopy,
  type ExportPolicy,
  LARGE_EXPORT_MEGAPIXEL_THRESHOLD,
  type PerformancePreference,
  type PolicyProductCopy,
} from './export-policy'
export type {
  ExportRuntimeResources,
  ExportRuntimeResourcesInput,
} from './export-runtime-resources'
export {
  deriveInteractivePolicy,
  type InteractivePolicy,
  type InteractivePolicyOptions,
} from './interactive-policy'
export type {
  PreviewGpuBudget,
  PreviewGpuCapabilitySnapshot,
} from './preview-gpu-budget'
export { deriveRuntimeResourceBudget } from './resource-budget'
