import type {
  CapabilityVector,
  ExportIntent,
  ExportOrchestrationCopy,
  ExportPolicy,
  ExportRuntimeResources,
  PerformancePreference,
} from '@lumaforge/render-engine/policy'
import { deriveExportPolicy } from '@lumaforge/render-engine/policy'

import type {
  ExportCheckpointMode,
  ExportExecutionProfileName,
  ExportOutputSink,
  ExportRuntimeMemoryProfile,
} from './execution-profile'

/** The sensor frame the export decodes; its memory cost sizes the plan. */
export type ExportPlanSource = { width: number; height: number }

/** What the last attempt on this source left behind; absent flags are false. */
export type ExportPlanHistory = {
  previousCrashLikeInterruption?: boolean
  previousResourceFailure?: boolean
  previousUserInterrupted?: boolean
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
    // Every retry is a fresh worker from the first row; nothing resumes.
    checkpointMode: 'safe-retry',
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
    previousUserInterrupted: input.history?.previousUserInterrupted ?? false,
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
  const profile = synthesizeProfile(
    chooseProfile(policy, input.capability),
    policy,
  )

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
    request: {
      preference: input.preference,
      source: { width: input.source.width, height: input.source.height },
      history,
    },
  }
}
