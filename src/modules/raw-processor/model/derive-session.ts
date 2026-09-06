import { resolveUnsupportedLUTOutputReason } from '@lumaforge/luma-color-runtime'

import type { ImageSession, PreviewBundle } from './session'

export const PREVIEW_TRANSFORM_EXPORT_REASON =
  'Transform changes support preview JPEG only. Reset Transform before exporting a standard JPEG.'

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
  if (session.previewTransformActive) return PREVIEW_TRANSFORM_EXPORT_REASON

  const activeStyle = session.activeStyle
  if (!activeStyle) {
    return undefined
  }

  if (activeStyle.kind === 'builtin') {
    return 'Built-in styles are not supported by full-resolution JPEG export.'
  }

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
