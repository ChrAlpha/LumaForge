import type {
  ColorGraphIntentSource,
  LUTData,
} from '@lumaforge/luma-color-runtime'
import type {
  PreviewColorExecutor,
  PreviewColorPlanReason,
} from '@lumaforge/render-engine/preview'
import { resolvePreviewColorPlan } from '@lumaforge/render-engine/preview'

import type { MessageKey } from '~/lib/i18n'

import type { SupportLevel } from '../../model/session'

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

/** An unsupported file stays unsupported; nothing in the app certifies one. */
export function supportLevelMessageKey(level: SupportLevel): MessageKey {
  return level === 'unsupported'
    ? 'raw.support.unsupported'
    : 'raw.support.experimental'
}
