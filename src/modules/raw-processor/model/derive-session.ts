import { resolveUnsupportedLUTOutputReason } from '@lumaforge/luma-color-runtime'

import { getExportModeCopy } from '~/lib/export/execution-profile'

import type {
  FullResExportDetailReasonCode,
  FullResExportReason,
  FullResExportReasonCode,
} from './export-result'
import type { ImageSession, PreviewBundle, StyleAsset } from './session'

/**
 * Full resolution reproduces the geometry; the bounded HQ preview cannot, so
 * only that path still refuses.
 */
export const PREVIEW_TRANSFORM_HQ_EXPORT_REASON =
  'Export at full resolution to keep Transform, or reset Transform for an HQ preview JPEG.'

/**
 * The English sentence each full-resolution refusal is still carried as,
 * beside its code, until every reader takes the code.
 */
const FULL_RES_EXPORT_REASON_SENTENCE: Record<
  Exclude<FullResExportReasonCode, FullResExportDetailReasonCode>,
  string
> = {
  'source-loading': 'Full-resolution export source is still loading.',
  'export-running': 'Full-resolution export is already running.',
  'quick-preview-pending': 'Quick preview is still being prepared.',
  'capability-unchecked':
    'Full-resolution export support has not been checked yet.',
  'capability-probing':
    'Checking full-resolution export support for this RAW file.',
  'builtin-style':
    'Built-in styles are not supported by full-resolution JPEG export.',
  'lut-input-unconfirmed':
    'Choose a LUT input profile before full-resolution export.',
  'lut-output-unsupported':
    'This LUT output transfer is not supported by full-resolution JPEG export.',
  'geometry-unplannable':
    'This Transform cannot be reproduced at full resolution. Adjust or reset Transform to export.',
  'exposure-pending': 'RAW preview exposure is still being prepared.',
  'cannot-safely-complete': getExportModeCopy('cannot-safely-complete'),
  'transform-pending':
    'Transform is still preparing the current photo. Export once the preview shows it.',
  'transform-invalid':
    'This Transform leaves too little usable image. Reduce the adjustment or reset Transform to export.',
  'transform-unavailable':
    'The processed preview is unavailable. Wait for it or reset Transform to export.',
}

/** The English sentence a refusal's code stands for; diagnostics read as given. */
export function fullResExportReasonSentence(
  reason: FullResExportReason,
): string {
  return 'detail' in reason
    ? reason.detail
    : FULL_RES_EXPORT_REASON_SENTENCE[reason.code]
}

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
    const detail = resolveUnsupportedLUTOutputReason(profileResolution.profile)
    return detail ? { code: 'lut-output-refused', detail } : undefined
  }

  if (profileResolution.kind === 'unsupported-output') {
    return { code: 'lut-output-unsupported' }
  }

  return { code: 'lut-input-unconfirmed' }
}

/** The sentence `deriveLutContractExportRefusal` stands for. */
export function deriveLutContractExportReason(
  activeStyle: StyleAsset | null | undefined,
): string | undefined {
  const refusal = deriveLutContractExportRefusal(activeStyle)
  return refusal && fullResExportReasonSentence(refusal)
}

export function deriveCanExport(session: ImageSession): boolean {
  return (
    session.previewBundle.quickDecodePreview.status === 'ready' &&
    session.exportState.fullResCapability.status === 'supported' &&
    session.exportState.status !== 'exporting' &&
    !deriveUnsupportedExportPipelineRefusal(session)
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

/** The sentence `deriveExportRefusal` stands for. */
export function deriveExportDisabledReason(
  session: ImageSession,
): string | undefined {
  const refusal = deriveExportRefusal(session)
  return refusal && fullResExportReasonSentence(refusal)
}
