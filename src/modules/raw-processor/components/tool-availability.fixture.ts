import type { RawTransformFeature } from '../hooks/useRawTransformFeature'
import type {
  ToolAvailability,
  ToolSurface,
} from '../services/surface/derive-tool-availability'
import { deriveToolAvailability } from '../services/surface/derive-tool-availability'

/**
 * The facts a surface test states as flat props. A busy stage reads as
 * processing, or exporting while an export runs.
 */
interface SurfaceFacts {
  hasImage?: boolean
  isProcessing?: boolean
  isExporting?: boolean
  previewSuspended?: boolean
  /** False for the CPU preview, which has no split surface. */
  compareSupported?: boolean
  transform?: Pick<RawTransformFeature, 'active' | 'exportBlock'>
  hasAppliedLut?: boolean
  canExport?: boolean
  canPreviewExport?: boolean
  hasExportResult?: boolean
}

function availabilityFor(
  surface: ToolSurface,
  facts: SurfaceFacts,
): ToolAvailability {
  return deriveToolAvailability({
    surface,
    hasImage: facts.hasImage === true,
    status: facts.isExporting
      ? 'exporting'
      : facts.isProcessing
        ? 'processing'
        : 'ready',
    executor: facts.compareSupported === false ? 'cpu' : 'webgpu',
    previewSuspended: facts.previewSuspended === true,
    transformActive: facts.transform?.active === true,
    transformExportBlock: facts.transform?.exportBlock ?? null,
    hasAppliedLut: facts.hasAppliedLut === true,
    canExport: facts.canExport === true,
    lutContractBlocksExport: false,
    canPreviewExport: facts.canPreviewExport === true,
    hasExportResult: facts.hasExportResult === true,
  })
}

/** The provider's availability for a tool surface rendered from flat props. */
export function toolAvailabilityFixture(props: {
  hasImage?: boolean
  isProcessing?: boolean
  isExporting?: boolean
  previewSuspended?: boolean
  compareSupported?: boolean
  transform?: Pick<RawTransformFeature, 'active' | 'exportBlock'>
  currentLutName?: string | null
  canExport?: boolean
  canPreviewExport?: boolean
  exportResult?: unknown
}): Record<ToolSurface, ToolAvailability> {
  const facts: SurfaceFacts = {
    ...props,
    hasAppliedLut: Boolean(props.currentLutName),
    hasExportResult: props.exportResult != null,
  }
  return {
    desktop: availabilityFor('desktop', facts),
    mobile: availabilityFor('mobile', facts),
  }
}

/** The mobile availability for the mobile chrome rendered from flat props. */
export function mobileAvailabilityFixture(props: {
  hasImage?: boolean
  isProcessing?: boolean
  isExporting?: boolean
  previewSuspended?: boolean
  compareSupported?: boolean
  transform?: Pick<RawTransformFeature, 'active' | 'exportBlock'>
  lutBrowser?: { currentLutName?: string | null }
  canExport?: boolean
  exportResultKind?: unknown
}): ToolAvailability {
  return availabilityFor('mobile', {
    ...props,
    hasAppliedLut: Boolean(props.lutBrowser?.currentLutName),
    hasExportResult: props.exportResultKind != null,
  })
}
