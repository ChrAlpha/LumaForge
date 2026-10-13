import type { RawRenderExposure } from '@lumaforge/luma-color-runtime'
import type { ExportGeometry } from '@lumaforge/render-engine/export'
import { planExportGeometry } from '@lumaforge/render-engine/export'
import type { PerformancePreference } from '@lumaforge/render-engine/policy'

import type {
  ExportExecutionPlan,
  ExportPlanFacts,
  ExportPlanRequest,
  ExportPlanSource,
} from '~/lib/export/export-plan'
import { selectExportPlan } from '~/lib/export/export-plan'
import {
  classifyDeviceFormFactor,
  classifyUserAgent,
  getCapabilityVectorSnapshot,
} from '~/lib/runtime/capability-vector'

import { deriveExportRefusal } from '../../model/derive-session'
import type {
  ExportResultKind,
  FullResExportReason,
  HqPreviewExportReasonCode,
} from '../../model/export-result'
import type { ImageSession } from '../../model/session'
import type { TransformExportBlock } from '../transform/transform-state'
import { deriveTransformStatus } from '../transform/transform-state'
import type { ExportInterruptionHint } from './export-interruption'

const TRANSFORM_EXPORT_REFUSAL: Record<
  TransformExportBlock,
  FullResExportReason
> = {
  pending: { code: 'transform-pending' },
  invalid: { code: 'transform-invalid' },
  unavailable: { code: 'transform-unavailable' },
}

function isOpfsAvailableForReadiness() {
  if (typeof navigator === 'undefined') return false

  return Boolean(
    (navigator.storage as { getDirectory?: () => unknown } | undefined)
      ?.getDirectory,
  )
}

type SupportedFullResCapability = Extract<
  ImageSession['exportState']['fullResCapability'],
  { status: 'supported' }
>

export type FullResExportReadiness =
  | {
      canExport: true
      sourceFile: File
      session: ImageSession
      rawRenderExposure: RawRenderExposure
      fullResCapability: SupportedFullResCapability
      /** The frame the export delivers: the sensor, or the geometry's crop. */
      deliveredSize: { width: number; height: number }
    }
  | {
      canExport: false
      refusal: FullResExportReason
    }

/**
 * The plan request a full-resolution export of a ready source makes: the
 * sensor frame the worker decodes (Transform crops only the delivered frame),
 * how hard it may push the device, and what the last attempt on this source
 * left behind. The hint must already be the one read for this source; no
 * hint asks for nothing. Device facts are not part of a request, and the
 * JPEG quality is fixed elsewhere.
 */
export function planFullResExportRequest(input: {
  source: ExportPlanSource
  performancePreference?: PerformancePreference
  interruption?: ExportInterruptionHint | null
}): ExportPlanRequest {
  return {
    preference: input.performancePreference ?? 'balanced',
    source: { width: input.source.width, height: input.source.height },
    history: {
      previousCrashLikeInterruption:
        input.interruption?.previousCrashLikeInterruption ?? false,
      previousResourceFailure:
        input.interruption?.previousResourceFailure ?? false,
    },
  }
}

export type FullResExportPlanDecision =
  | { kind: 'run'; plan: ExportExecutionPlan }
  | {
      kind: 'refuse'
      refusal: { code: 'cannot-safely-complete' }
    }

/**
 * Plans a request over the device facts handed in, through the one browser
 * plan entry, and refuses a plan the policy says cannot safely complete.
 * Pure: it samples nothing, so whether the plan may run depends on where
 * its facts came from. Only facts sampled for the export that is about to
 * start may feed a plan that runs.
 */
export function planFullResExport(
  request: ExportPlanRequest,
  facts: ExportPlanFacts,
): FullResExportPlanDecision {
  const plan = selectExportPlan({ ...request, ...facts })
  return plan.productCopy === 'cannot-safely-complete'
    ? { kind: 'refuse', refusal: { code: plan.productCopy } }
    : { kind: 'run', plan }
}

/**
 * Optimistic facts for readiness only. Readiness runs synchronously on every
 * render, so it cannot sample storage: it assumes any reachable OPFS has room
 * and refuses only what no storage estimate could rescue. The export samples
 * real facts before it plans, and nothing planned from these ever runs.
 */
function optimisticReadinessPlanFacts(): ExportPlanFacts {
  const opfsAvailable = isOpfsAvailableForReadiness()
  const touch =
    typeof globalThis.navigator?.maxTouchPoints === 'number' &&
    globalThis.navigator.maxTouchPoints > 0
  const userAgent = globalThis.navigator?.userAgent ?? ''
  const capability =
    getCapabilityVectorSnapshot() ??
    Object.freeze({
      coi: Boolean(globalThis.crossOriginIsolated),
      pthread: Boolean(globalThis.crossOriginIsolated),
      deviceMemoryGB: null,
      hwConcurrency: Math.max(
        1,
        Math.floor(globalThis.navigator?.hardwareConcurrency ?? 1),
      ),
      webKitClass: classifyUserAgent(userAgent, touch),
      deviceFormFactor: classifyDeviceFormFactor(userAgent, touch),
      maybeOpfsSupported: opfsAvailable,
    })

  return {
    capability,
    runtime: {
      opfsSinkAvailable: opfsAvailable,
      opfsAvailableMB: opfsAvailable ? Number.POSITIVE_INFINITY : null,
    },
  }
}

/**
 * Why no storage could let this source export here, or undefined. The plan
 * is made from optimistic facts, so only its refusal leaves this function:
 * it is never handed to a worker.
 */
function getUnsafeFullResExportRefusal(source: ExportPlanSource) {
  const decision = planFullResExport(
    planFullResExportRequest({ source }),
    optimisticReadinessPlanFacts(),
  )
  return decision.kind === 'refuse' ? decision.refusal : undefined
}

function refuseFullResExport(
  refusal: FullResExportReason,
): FullResExportReadiness {
  return { canExport: false, refusal }
}

/**
 * The frame a committed geometry delivers, or null when the engine would
 * refuse to plan it. Planning is cheap and synchronous, so a malformed or
 * folding geometry is refused here, before any export resource is touched,
 * rather than being sized as the sensor frame. The engine still validates
 * the geometry itself and stays the final authority.
 */
function planDeliveredSize(
  geometry: ExportGeometry | null | undefined,
  source: { width: number; height: number },
) {
  if (!geometry) return source
  try {
    const planned = planExportGeometry(geometry, source)
    return { width: planned.outputWidth, height: planned.outputHeight }
  } catch {
    return null
  }
}

export function deriveFullResExportReadiness(input: {
  sourceFile: File | null
  session: ImageSession | null
  rawRenderExposure: RawRenderExposure | null | undefined
}): FullResExportReadiness {
  if (!input.sourceFile || !input.session) {
    return refuseFullResExport({ code: 'source-loading' })
  }

  const sessionRefusal = deriveExportRefusal(input.session)
  if (sessionRefusal) {
    return refuseFullResExport(sessionRefusal)
  }

  const fullResCapability = input.session.exportState.fullResCapability
  if (fullResCapability.status !== 'supported') {
    return refuseFullResExport({ code: 'capability-unchecked' })
  }

  const deliveredSize = planDeliveredSize(input.session.exportGeometry, {
    width: fullResCapability.width,
    height: fullResCapability.height,
  })
  if (!deliveredSize) {
    return refuseFullResExport({ code: 'geometry-unplannable' })
  }

  if (!input.rawRenderExposure) {
    return refuseFullResExport({ code: 'exposure-pending' })
  }

  const unsafeRefusal = getUnsafeFullResExportRefusal({
    width: fullResCapability.width,
    height: fullResCapability.height,
  })
  if (unsafeRefusal) {
    return refuseFullResExport(unsafeRefusal)
  }

  return {
    canExport: true,
    sourceFile: input.sourceFile,
    session: input.session,
    rawRenderExposure: input.rawRenderExposure,
    fullResCapability,
    deliveredSize,
  }
}

/**
 * Why the Transform the session asks for right now keeps an export from
 * starting, or undefined when it does not. Exports read it from the live
 * session when they run, so an action captured before an edit still refuses.
 * Full resolution reproduces only a neutral Transform or the accepted answer
 * to the newest request. The HQ preview JPEG never applies Transform, so it
 * starts only while nothing is asked and no geometry is held.
 */
export function deriveTransformExportRefusalReason(
  session: ImageSession,
  kind: 'full-resolution',
): FullResExportReason | undefined
export function deriveTransformExportRefusalReason(
  session: ImageSession,
  kind: 'hq-preview',
): HqPreviewExportReasonCode | undefined
export function deriveTransformExportRefusalReason(
  session: ImageSession,
  kind: ExportResultKind,
): FullResExportReason | HqPreviewExportReasonCode | undefined
export function deriveTransformExportRefusalReason(
  session: ImageSession,
  kind: ExportResultKind,
): FullResExportReason | HqPreviewExportReasonCode | undefined {
  const status = deriveTransformStatus(session.transform)
  if (kind === 'hq-preview') {
    return status !== 'neutral' || session.exportGeometry
      ? 'transform-held'
      : undefined
  }
  return status === 'neutral' || status === 'accepted'
    ? undefined
    : TRANSFORM_EXPORT_REFUSAL[status]
}
