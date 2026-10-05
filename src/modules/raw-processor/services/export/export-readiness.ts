import type { RawRenderExposure } from '@lumaforge/luma-color-runtime'
import type { ExportGeometry } from '@lumaforge/render-engine/export'
import { planExportGeometry } from '@lumaforge/render-engine/export'

import {
  getExportModeCopy,
  selectExportExecutionPlan,
} from '~/lib/export/execution-profile'
import {
  classifyDeviceFormFactor,
  classifyUserAgent,
  getCapabilityVectorSnapshot,
} from '~/lib/runtime/capability-vector'

import { deriveExportDisabledReason } from '../../model/derive-session'
import type { ImageSession } from '../../model/session'

const MISSING_RAW_RENDER_EXPOSURE_EXPORT_REASON =
  'RAW preview exposure is still being prepared.'
const INVALID_EXPORT_GEOMETRY_REASON =
  'This Transform cannot be reproduced at full resolution. Adjust or reset Transform to export.'

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

function getUnsafeFullResExportReason(input: {
  session: ImageSession
  fidelity?: 'safe' | 'balanced' | 'max'
}) {
  const capability = input.session.exportState.fullResCapability
  if (capability.status !== 'supported') return undefined
  const opfsAvailable = isOpfsAvailableForReadiness()

  const cap =
    getCapabilityVectorSnapshot() ??
    Object.freeze({
      coi: Boolean(globalThis.crossOriginIsolated),
      pthread: Boolean(globalThis.crossOriginIsolated),
      deviceMemoryGB: null,
      hwConcurrency: Math.max(
        1,
        Math.floor(globalThis.navigator?.hardwareConcurrency ?? 1),
      ),
      webKitClass: classifyUserAgent(
        globalThis.navigator?.userAgent ?? '',
        typeof globalThis.navigator?.maxTouchPoints === 'number' &&
          globalThis.navigator.maxTouchPoints > 0,
      ),
      deviceFormFactor: classifyDeviceFormFactor(
        globalThis.navigator?.userAgent ?? '',
        typeof globalThis.navigator?.maxTouchPoints === 'number' &&
          globalThis.navigator.maxTouchPoints > 0,
      ),
      maybeOpfsSupported: opfsAvailable,
    })

  const plan = selectExportExecutionPlan({
    performancePreference: input.fidelity ?? 'balanced',
    sourceWidth: capability.width,
    sourceHeight: capability.height,
    capability: cap,
    runtime: {
      opfsSinkAvailable: opfsAvailable,
      opfsAvailableMB: opfsAvailable ? Number.POSITIVE_INFINITY : null,
      streamingSinkAvailable: false,
    },
  })

  return plan.productCopy === 'cannot-safely-complete'
    ? getExportModeCopy(plan.productCopy)
    : undefined
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
  fidelity?: 'safe' | 'balanced' | 'max'
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
    session: input.session,
    fidelity: input.fidelity,
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
