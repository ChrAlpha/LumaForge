import { resolveUnsupportedLUTOutputReason } from '@lumaforge/luma-color-runtime'

import type { ImageSession, PreviewBundle, StyleAsset } from './session'

/**
 * Full resolution reproduces the geometry; the bounded HQ preview cannot, so
 * only that path still refuses.
 */
export const PREVIEW_TRANSFORM_HQ_EXPORT_REASON =
  'Export at full resolution to keep Transform, or reset Transform for an HQ preview JPEG.'

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

function deriveUnsupportedExportPipelineReason(
  session: ImageSession,
): string | undefined {
  const activeStyle = session.activeStyle
  if (!activeStyle) {
    return undefined
  }

  if (activeStyle.kind === 'builtin') {
    return 'Built-in styles are not supported by full-resolution JPEG export.'
  }

  return deriveLutContractExportReason(activeStyle)
}

/**
 * Why a custom LUT's colour contract keeps full-resolution export from
 * reproducing it (an input to choose, an output to choose, or an output this
 * build cannot deliver); undefined when the contract is exportable. Choosing
 * a different contract is the fix for every one of these.
 */
export function deriveLutContractExportReason(
  activeStyle: StyleAsset | null | undefined,
): string | undefined {
  if (activeStyle?.kind !== 'custom') return undefined

  const profileResolution = activeStyle.lutAsset?.profileResolution
  if (!profileResolution) {
    return undefined
  }

  if (profileResolution.kind === 'confirmed') {
    return resolveUnsupportedLUTOutputReason(profileResolution.profile)
  }

  if (profileResolution.kind === 'unsupported-output') {
    return 'This LUT output transfer is not supported by full-resolution JPEG export.'
  }

  return 'Choose a LUT input profile before full-resolution export.'
}

export function deriveCanExport(session: ImageSession): boolean {
  return (
    session.previewBundle.quickDecodePreview.status === 'ready' &&
    session.exportState.fullResCapability.status === 'supported' &&
    session.exportState.status !== 'exporting' &&
    !deriveUnsupportedExportPipelineReason(session)
  )
}

export function deriveExportDisabledReason(
  session: ImageSession,
): string | undefined {
  if (session.exportState.status === 'exporting') {
    return 'Full-resolution export is already running.'
  }

  if (session.previewBundle.quickDecodePreview.status !== 'ready') {
    return 'Quick preview is still being prepared.'
  }

  switch (session.exportState.fullResCapability.status) {
    case 'unknown':
      return 'Full-resolution export support has not been checked yet.'
    case 'probing':
      return 'Checking full-resolution export support for this RAW file.'
    case 'unsupported':
      return session.exportState.fullResCapability.reason
    case 'supported':
      return deriveUnsupportedExportPipelineReason(session)
  }
}
