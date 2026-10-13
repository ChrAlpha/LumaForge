import type { CapabilityVector } from './capability-input'
import { deriveRuntimeResourceBudget } from './resource-budget'

export interface InteractivePolicy {
  readonly boundedHqMaxPixels: number
  readonly previewWorkerMemoryProfile: 'low-memory' | 'desktop'
}

export interface InteractivePolicyOptions {
  /** The source's preview GPU budget, which replaces the device budget. */
  readonly boundedHqMaxPixels?: number
}

export function deriveInteractivePolicy(
  cap: CapabilityVector,
  options: InteractivePolicyOptions = {},
): InteractivePolicy {
  const budget = deriveRuntimeResourceBudget(cap)

  return Object.freeze({
    boundedHqMaxPixels: options.boundedHqMaxPixels ?? budget.boundedHqMaxPixels,
    previewWorkerMemoryProfile: budget.workerMemoryProfile,
  })
}
