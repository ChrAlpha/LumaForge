import type { RawRenderExposure } from '@lumaforge/luma-color-runtime'
import type { ExportGeometry } from '@lumaforge/render-engine/export'
import { planExportGeometry } from '@lumaforge/render-engine/export'
import type { PerformancePreference } from '@lumaforge/render-engine/policy'

import { getExportModeCopy } from '~/lib/export/execution-profile'
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

import {
  deriveExportDisabledReason,
  PREVIEW_TRANSFORM_HQ_EXPORT_REASON,
} from '../../model/derive-session'
import type { ImageSession } from '../../model/session'
import type { TransformExportBlock } from '../transform/transform-state'
import { deriveTransformStatus } from '../transform/transform-state'
import type { ExportInterruptionHint } from './export-interruption'

const MISSING_RAW_RENDER_EXPOSURE_EXPORT_REASON =
  'RAW preview exposure is still being prepared.'
const INVALID_EXPORT_GEOMETRY_REASON =
  'This Transform cannot be reproduced at full resolution. Adjust or reset Transform to export.'

const TRANSFORM_EXPORT_REFUSAL: Record<TransformExportBlock, string> = {
  pending:
    'Transform is still preparing the current photo. Export once the preview shows it.',
  invalid:
    'This Transform leaves too little usable image. Reduce the adjustment or reset Transform to export.',
  unavailable:
    'The processed preview is unavailable. Wait for it or reset Transform to export.',
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
      disabledReason?: undefined
    }
  | {
      canExport: false
      disabledReason: string
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
      previousUserInterrupted: false,
    },
  }
}

export type FullResExportPlanDecision =
  | { kind: 'run'; plan: ExportExecutionPlan }
  | { kind: 'refuse'; reason: string }

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
    ? { kind: 'refuse', reason: getExportModeCopy(plan.productCopy) }
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
      streamingSinkAvailable: false,
    },
  }
}

/**
 * Why no storage could let this source export here, or undefined. The plan
 * is made from optimistic facts, so only its refusal leaves this function:
 * it is never handed to a worker.
 */
function getUnsafeFullResExportReason(source: ExportPlanSource) {
  const decision = planFullResExport(
    planFullResExportRequest({ source }),
    optimisticReadinessPlanFacts(),
  )
  return decision.kind === 'refuse' ? decision.reason : undefined
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
    return {
      canExport: false,
      disabledReason: 'Full-resolution export source is still loading.',
    }
  }

  const sessionReason = deriveExportDisabledReason(input.session)
  if (sessionReason) {
    return { canExport: false, disabledReason: sessionReason }
  }

  const fullResCapability = input.session.exportState.fullResCapability
  if (fullResCapability.status !== 'supported') {
    return {
      canExport: false,
      disabledReason:
        'Full-resolution export support has not been checked yet.',
    }
  }

  const deliveredSize = planDeliveredSize(input.session.exportGeometry, {
    width: fullResCapability.width,
    height: fullResCapability.height,
  })
  if (!deliveredSize) {
    return { canExport: false, disabledReason: INVALID_EXPORT_GEOMETRY_REASON }
  }

  if (!input.rawRenderExposure) {
    return {
      canExport: false,
      disabledReason: MISSING_RAW_RENDER_EXPOSURE_EXPORT_REASON,
    }
  }

  const unsafeReason = getUnsafeFullResExportReason({
    width: fullResCapability.width,
    height: fullResCapability.height,
  })
  if (unsafeReason) {
    return { canExport: false, disabledReason: unsafeReason }
  }

  return {
    canExport: true,
    sourceFile: input.sourceFile,
    session: input.session,
    rawRenderExposure: input.rawRenderExposure,
    fullResCapability,
    deliveredSize,
    disabledReason: undefined,
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
export function deriveTransformExportRefusal(
  session: ImageSession,
  kind: 'full-resolution' | 'hq-preview',
): string | undefined {
  // A session built before it carried a Transform asks for none.
  const status = session.transform
    ? deriveTransformStatus(session.transform)
    : 'neutral'
  if (kind === 'hq-preview') {
    return status !== 'neutral' || session.exportGeometry
      ? PREVIEW_TRANSFORM_HQ_EXPORT_REASON
      : undefined
  }
  return status === 'neutral' || status === 'accepted'
    ? undefined
    : TRANSFORM_EXPORT_REFUSAL[status]
}
