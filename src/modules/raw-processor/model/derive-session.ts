import {
  lutHasHdrRendition,
  resolveUnsupportedLUTOutputReason,
} from '@lumaforge/luma-color-runtime'

import type { FullResExportReason } from './export-result'
import type { ImageSession, PreviewBundle, StyleAsset } from './session'

export function selectDisplaySource(
  preview: PreviewBundle,
): 'embedded' | 'quick' | 'bounded-hq' | 'none' {
  if (preview.boundedHqPreview.status === 'ready') return 'bounded-hq'
  if (preview.quickDecodePreview.status === 'ready') return 'quick'
  if (preview.embeddedPreview.status === 'ready') return 'embedded'
  return 'none'
}

export function deriveCanEdit(session: ImageSession): boolean {
  return selectDisplaySource(session.previewBundle) !== 'none'
}

function deriveUnsupportedExportPipelineRefusal(
  session: ImageSession,
): FullResExportReason | undefined {
  const activeStyle = session.activeStyle
  if (!activeStyle) {
    return undefined
  }

  if (activeStyle.kind === 'builtin') {
    return { code: 'builtin-style' }
  }

  return deriveLutContractExportRefusal(activeStyle)
}

/**
 * Why a custom LUT's colour contract keeps full-resolution export from
 * reproducing it (an input to choose, an output to choose, or an output this
 * build cannot deliver); undefined when the contract is exportable. Choosing
 * a different contract is the fix for every one of these. A confirmed
 * contract's output refusal keeps the color runtime's reason as its detail.
 */
export function deriveLutContractExportRefusal(
  activeStyle: StyleAsset | null | undefined,
): FullResExportReason | undefined {
  if (activeStyle?.kind !== 'custom') return undefined

  const profileResolution = activeStyle.lutAsset?.profileResolution
  if (!profileResolution) {
    return undefined
  }

  if (profileResolution.kind === 'confirmed') {
    const detail = resolveUnsupportedLUTOutputReason(
      profileResolution.profile,
    )?.message
    return detail ? { code: 'lut-output-refused', detail } : undefined
  }

  if (profileResolution.kind === 'unsupported-output') {
    return { code: 'lut-output-unsupported' }
  }

  return { code: 'lut-input-unconfirmed' }
}

/**
 * Whether the session's look has the HDR rendition a gain map stores: no
 * look, or a LUT whose confirmed contract keeps the scene (the color
 * runtime's `lutHasHdrRendition`). The export resolves its graph and asks
 * the color runtime again before any work.
 */
export function styleHasHdrRendition(
  activeStyle: StyleAsset | null | undefined,
): boolean {
  if (!activeStyle) return true
  if (activeStyle.kind !== 'custom') return false
  const profileResolution = activeStyle.lutAsset?.profileResolution
  return (
    profileResolution?.kind === 'confirmed' &&
    lutHasHdrRendition(profileResolution.profile)
  )
}

/**
 * Why the session keeps a full-resolution export from starting. The runtime's
 * verdict decides an unsupported source; its reasons are only the detail.
 */
export function deriveExportRefusal(
  session: ImageSession,
): FullResExportReason | undefined {
  if (session.exportState.status === 'exporting') {
    return { code: 'export-running' }
  }

  if (session.previewBundle.quickDecodePreview.status !== 'ready') {
    return { code: 'quick-preview-pending' }
  }

  const capability = session.exportState.fullResCapability
  switch (capability.status) {
    case 'unknown':
      return { code: 'capability-unchecked' }
    case 'probing':
      return { code: 'capability-probing' }
    case 'unsupported':
      return { code: 'runtime-unsupported', detail: capability.reason }
    case 'supported':
      return deriveUnsupportedExportPipelineRefusal(session)
  }
}
