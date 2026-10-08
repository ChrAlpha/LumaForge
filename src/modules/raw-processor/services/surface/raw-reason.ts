import type {
  ColorGraphIntentSource,
  LUTData,
} from '@lumaforge/luma-color-runtime'
import type {
  PreviewColorExecutor,
  PreviewColorPlanReason,
} from '@lumaforge/render-engine/preview'
import { resolvePreviewColorPlan } from '@lumaforge/render-engine/preview'

import type { MessageKey, Translate } from '~/lib/i18n'

import type {
  ExportCopyCapability,
  ExportCopyReasonCode,
  ExportShareReasonCode,
  FullResExportDetailReasonCode,
  FullResExportReason,
  FullResExportReasonCode,
  HqPreviewExportReasonCode,
} from '../../model/export-result'
import type { SupportLevel } from '../../model/session'

/**
 * Why a surface refuses an action: a fact of the surface policy, not of the
 * workflow. A workflow refusal (an export that cannot be reproduced, an HQ
 * preview not rendered yet) carries its own export reason, with its copy
 * below.
 */
export const RAW_REASON_CODES = [
  'no-source',
  'runtime-warming',
  'source-loading',
  'preview-decoding',
  'look-processing',
  'export-running',
  'preview-released',
  'cpu-preview',
  'transform-compare',
  'transform-pending',
  'transform-invalid',
  'transform-unavailable',
  'transform-hq-export',
  'no-lut',
] as const

export type RawReasonCode = (typeof RAW_REASON_CODES)[number]

/** Each surface reason reads as the copy the surfaces already show for it. */
export const RAW_REASON_COPY = {
  'no-source': 'raw.preview.noImage',
  'runtime-warming': 'raw.progress.warming',
  'source-loading': 'raw.progress.loading',
  'preview-decoding': 'raw.progress.decoding',
  'look-processing': 'raw.progress.processing',
  'export-running': 'raw.progress.exporting',
  'preview-released': 'raw.progress.previewReleased',
  'cpu-preview': 'raw.preview.cpuDegraded.banner',
  'transform-compare': 'raw.mobile.compare.unavailable',
  'transform-pending': 'raw.transform.preparing',
  'transform-invalid': 'transform.error.transform',
  'transform-unavailable': 'raw.transform.unavailable',
  'transform-hq-export': 'raw.transform.hqExportReason',
  'no-lut': 'raw.strength.reason',
} as const satisfies Record<RawReasonCode, MessageKey>

export function rawReasonMessageKey(code: RawReasonCode): MessageKey {
  return RAW_REASON_COPY[code]
}

/**
 * Why the processed preview does not draw the look as selected. The neutral
 * original is a view, not a look the preview leaves out, so it has no copy.
 */
export type PreviewLookReason = Exclude<
  PreviewColorPlanReason,
  'neutral-variant'
>

/**
 * The reason the processed preview reports for the selected look, or null
 * when it draws the look as selected. Read from the shared preview color
 * policy, never from export error text: the selection, its strength, and the
 * LUT stay as chosen, and only the drawn look differs.
 */
export function resolvePreviewLookReason(input: {
  intent: ColorGraphIntentSource
  lut: LUTData | null
  executor: PreviewColorExecutor
}): PreviewLookReason | null {
  const { reason } = resolvePreviewColorPlan({
    ...input,
    variant: 'processed',
  })
  return reason === 'neutral-variant' ? null : reason
}

export const PREVIEW_LOOK_REASON_COPY: Record<PreviewLookReason, MessageKey> = {
  'lut-not-loaded': 'raw.previewLook.lutNotLoaded',
  'lut-input-unconfirmed': 'raw.previewLook.lutInputUnconfirmed',
  'lut-output-unsupported': 'raw.previewLook.lutOutputUnsupported',
  'lut-output-range-unknown': 'raw.previewLook.lutOutputRangeUnknown',
  'lut-output-profile-missing': 'raw.previewLook.lutOutputProfileMissing',
  'lut-output-transfer-linear': 'raw.previewLook.lutOutputTransferLinear',
  'lut-contract-refused': 'raw.previewLook.lutContractRefused',
  'builtin-preset-missing': 'raw.previewLook.builtinPresetMissing',
  'builtin-no-ts-executor': 'raw.previewLook.builtinCpuPreview',
}

export function previewLookReasonMessageKey(
  reason: PreviewLookReason,
): MessageKey {
  return PREVIEW_LOOK_REASON_COPY[reason]
}

/**
 * The side of the LUT contract a new choice fixes, or null when choosing a
 * contract cannot bring the look back (the LUT is not loaded, or the look is
 * a built-in style).
 */
export function previewLookReasonContractSide(
  reason: PreviewLookReason | null | undefined,
): 'input' | 'output' | null {
  switch (reason) {
    case 'lut-input-unconfirmed':
    case 'lut-contract-refused': {
      return 'input'
    }
    case 'lut-output-unsupported':
    case 'lut-output-range-unknown':
    case 'lut-output-profile-missing':
    case 'lut-output-transfer-linear': {
      return 'output'
    }
    default: {
      return null
    }
  }
}

/**
 * The copy of each full-resolution export refusal. A refusal with diagnostic
 * text has no copy of its own: the text is shown as it came.
 */
export const FULL_RES_EXPORT_REASON_COPY = {
  'source-loading': 'raw.exportSourceLoading',
  'export-running': 'raw.export.reason.running',
  'quick-preview-pending': 'raw.export.reason.quickPreviewPending',
  'capability-unchecked': 'raw.export.reason.capabilityUnchecked',
  'capability-probing': 'raw.export.reason.capabilityProbing',
  'builtin-style': 'raw.export.reason.builtinStyle',
  'lut-input-unconfirmed': 'raw.export.reason.lutInputUnconfirmed',
  'lut-output-unsupported': 'raw.export.reason.lutOutputUnsupported',
  'geometry-unplannable': 'raw.export.reason.geometryUnplannable',
  'exposure-pending': 'raw.export.reason.exposurePending',
  'cannot-safely-complete': 'raw.export.reason.cannotSafelyComplete',
  'transform-pending': 'raw.export.reason.transformPending',
  'transform-invalid': 'raw.export.reason.transformInvalid',
  'transform-unavailable': 'raw.export.reason.transformUnavailable',
} as const satisfies Record<
  Exclude<FullResExportReasonCode, FullResExportDetailReasonCode>,
  MessageKey
>

export function fullResExportReasonText(
  reason: FullResExportReason,
  t: Translate,
): string {
  return 'detail' in reason
    ? reason.detail
    : t(FULL_RES_EXPORT_REASON_COPY[reason.code])
}

export const HQ_PREVIEW_EXPORT_REASON_COPY = {
  'transform-held': 'raw.transform.hqExportReason',
  'no-source': 'raw.export.previewLoadRequired',
  'preview-released': 'raw.export.previewRestoreRequired',
  'look-dropped': 'raw.export.previewLookUnavailable',
  'hq-preview-pending': 'raw.export.previewSourceLoading',
  'not-ready': 'raw.export.previewUnavailable',
} as const satisfies Record<HqPreviewExportReasonCode, MessageKey>

/** The Copy action's label for each mode that copies an image. */
export const EXPORT_COPY_LABEL_COPY = {
  'full-resolution': 'raw.export.copyFull',
  'hq-preview': 'raw.export.copyHqPreview',
  'preview-size': 'raw.export.copyPreview',
} as const satisfies Record<
  Exclude<ExportCopyCapability['mode'], 'unavailable'>,
  MessageKey
>

export const EXPORT_COPY_REASON_COPY = {
  'clipboard-unsupported': 'raw.export.copyUnsupported',
  'full-resolution-copy-unsupported': 'raw.export.copyPreviewReason',
  'hq-preview-copy-unsupported': 'raw.export.copyHqPreviewReason',
  'preview-copy-not-ready': 'raw.export.copyPreviewNotReady',
} as const satisfies Record<ExportCopyReasonCode, MessageKey>

export const EXPORT_SHARE_REASON_COPY = {
  'no-result': 'raw.export.shareNoResult',
  'share-unsupported': 'raw.export.shareUnsupported',
} as const satisfies Record<ExportShareReasonCode, MessageKey>

/** An unsupported file stays unsupported; nothing in the app certifies one. */
export function supportLevelMessageKey(level: SupportLevel): MessageKey {
  return level === 'unsupported'
    ? 'raw.support.unsupported'
    : 'raw.support.experimental'
}
