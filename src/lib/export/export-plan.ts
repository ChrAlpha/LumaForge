import type {
  CapabilityVector,
  ExportIntent,
  ExportPolicy,
  ExportRuntimeResources,
  PerformancePreference,
  PolicyProductCopy,
} from '@lumaforge/render-engine/policy'
import { deriveExportPolicy } from '@lumaforge/render-engine/policy'

export type ExportExecutionProfileName =
  | 'ios-safe'
  | 'mobile-balanced'
  | 'desktop-fast'

export type ExportOutputSink = ExportPolicy['outputSink']
export type ExportRuntimeMemoryProfile = 'low-memory' | 'desktop'

/** The sensor frame the export decodes; its memory cost sizes the plan. */
export type ExportPlanSource = { width: number; height: number }

/** What the last attempt on this source left behind; absent flags are false. */
export type ExportPlanHistory = {
  previousCrashLikeInterruption?: boolean
  previousResourceFailure?: boolean
}

/** The intent half of a plan: everything except the device facts. */
export type ExportPlanRequest = {
  preference: PerformancePreference
  source: ExportPlanSource
  history?: ExportPlanHistory
}

/**
 * The device half of a plan. The app gathers these; the engine policy only
 * reads them. A plan that will run must be given sampled facts.
 */
export type ExportPlanFacts = {
  capability: CapabilityVector
  runtime: ExportRuntimeResources
}

export type SelectExportPlanInput = ExportPlanRequest & ExportPlanFacts

/**
 * The plan of one export. Every attempt starts a fresh worker from the first
 * row; no export state outlives an attempt, so nothing resumes.
 */
export type ExportExecutionPlan = {
  profileName: ExportExecutionProfileName
  preferredRows: number
  concurrency: number
  runtimeMemoryProfile: ExportRuntimeMemoryProfile
  outputSink: ExportOutputSink
  productCopy: PolicyProductCopy
  derivedLabel: string
  policyVector: ExportPolicy
  /**
   * The request this plan answered, so a replacement plan can be derived for
   * the same intent from freshly sampled facts. The facts themselves are not
   * kept: a retry never reuses them.
   */
  request: {
    preference: PerformancePreference
    source: ExportPlanSource
    history: Required<ExportPlanHistory>
  }
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

/** What an attempt runs with: its strips, its workers, their memory and its sink. */
export type ExportAttemptPlan = Pick<
  ExportExecutionPlan,
  'preferredRows' | 'concurrency' | 'runtimeMemoryProfile' | 'outputSink'
>

export function toExportAttemptPlan(
  plan: ExportExecutionPlan,
): ExportAttemptPlan {
  return {
    preferredRows: plan.preferredRows,
    concurrency: plan.concurrency,
    runtimeMemoryProfile: plan.runtimeMemoryProfile,
    outputSink: plan.outputSink,
  }
}

/**
 * The one browser export plan selection. Pure: the engine policy owns rows,
 * concurrency, memory profile, sink and product copy; this maps them onto
 * the plan the worker runs. Readiness, the first attempt and every retry all
 * come through here, differing only in the facts they hand in.
 */
export function selectExportPlan(
  input: SelectExportPlanInput,
): ExportExecutionPlan {
  const history: Required<ExportPlanHistory> = {
    previousCrashLikeInterruption:
      input.history?.previousCrashLikeInterruption ?? false,
    previousResourceFailure: input.history?.previousResourceFailure ?? false,
  }
  const intent: ExportIntent = {
    performancePreference: input.preference,
    ...history,
  }
  const policy = deriveExportPolicy(
    input.capability,
    { width: input.source.width, height: input.source.height },
    intent,
    input.runtime,
  )

  return {
    profileName: chooseProfile(policy, input.capability),
    preferredRows: policy.rowSlice,
    concurrency: policy.concurrency,
    runtimeMemoryProfile: policy.workerMemoryProfile,
    outputSink: policy.outputSink,
    productCopy: policy.productCopy,
    derivedLabel: policy.derivedLabel,
    policyVector: policy,
    request: {
      preference: input.preference,
      source: { width: input.source.width, height: input.source.height },
      history,
    },
  }
}
