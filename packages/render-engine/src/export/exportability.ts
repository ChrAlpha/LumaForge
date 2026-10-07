import type { LumaRawExportCapability } from '@lumaforge/luma-raw-runtime'

/**
 * One fact that keeps a source off the processed-window export path. Each
 * names a missing or malformed capability fact, not a host condition: JPEG
 * encoder availability and browser support are the host's to report.
 */
export type ProcessedExportRefusal =
  | 'source-unsupported'
  | 'invalid-dimensions'
  | 'strategy-not-processed-window'
  | 'processed-windows-unavailable'
  | 'color-facts-missing'
  | 'working-space-not-linear-prophoto'
  | 'white-balance-not-applied-by-runtime'
  | 'camera-matrix-not-applied-by-runtime'

export type ProcessedExportAssessment =
  | { exportable: true; width: number; height: number; reasons: [] }
  | { exportable: false; reasons: ProcessedExportRefusal[] }

function isPositiveDimension(value: unknown) {
  return Number.isSafeInteger(value) && (value as number) > 0
}

/**
 * Whether a probed capability can feed the full-resolution processed-window
 * export: the source is supported, has positive integer dimensions, reads
 * LibRaw processed windows, and its runtime declares linear ProPhoto output
 * with camera white balance and camera matrix already applied. Every flag
 * must be literally `true`; missing or malformed facts refuse. All refusals
 * are reported, not just the first, and the runtime's own `reasons` list is
 * not consulted.
 */
export function assessProcessedExport(
  capability: LumaRawExportCapability,
): ProcessedExportAssessment {
  const reasons: ProcessedExportRefusal[] = []

  if (capability.supported !== true) {
    reasons.push('source-unsupported')
  }

  if (
    !isPositiveDimension(capability.width) ||
    !isPositiveDimension(capability.height)
  ) {
    reasons.push('invalid-dimensions')
  }

  if (capability.strategy !== 'libraw-processed-window') {
    reasons.push('strategy-not-processed-window')
  }

  if (capability.windows?.librawProcessed !== true) {
    reasons.push('processed-windows-unavailable')
  }

  const color: unknown = capability.color
  if (typeof color !== 'object' || color === null) {
    reasons.push('color-facts-missing')
  } else {
    const facts = color as Record<string, unknown>
    if (facts.workingSpace !== 'linear-prophoto-rgb') {
      reasons.push('working-space-not-linear-prophoto')
    }
    if (facts.cameraWhiteBalanceAppliedByRuntime !== true) {
      reasons.push('white-balance-not-applied-by-runtime')
    }
    if (facts.cameraMatrixAppliedByRuntime !== true) {
      reasons.push('camera-matrix-not-applied-by-runtime')
    }
  }

  if (reasons.length > 0) {
    return { exportable: false, reasons }
  }

  return {
    exportable: true,
    width: capability.width,
    height: capability.height,
    reasons: [],
  }
}
