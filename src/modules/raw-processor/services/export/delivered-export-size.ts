import type { ExportGeometry } from '@lumaforge/render-engine/export'
import { planExportGeometry } from '@lumaforge/render-engine/export'

import type { FullResExportCapabilityState } from '../../model/session'

export interface DeliveredExportSize {
  width: number
  height: number
}

/**
 * The frame a full-resolution export will write: the probed source size,
 * cropped by the committed Transform geometry when there is one.
 *
 * Null while the source size is not known yet, and null when the geometry
 * would not survive the export worker's own validation, so a recap never
 * states a size the export will not deliver.
 */
export function resolveDeliveredExportSize(input: {
  fullResCapability: FullResExportCapabilityState | undefined
  exportGeometry: ExportGeometry | null | undefined
}): DeliveredExportSize | null {
  const capability = input.fullResCapability
  if (capability?.status !== 'supported') return null
  const source = { width: capability.width, height: capability.height }
  if (!input.exportGeometry) return source
  try {
    const planned = planExportGeometry(input.exportGeometry, source)
    return { width: planned.outputWidth, height: planned.outputHeight }
  } catch {
    return null
  }
}
