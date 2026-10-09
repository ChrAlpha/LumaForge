import type { ColorGraphIntent, LUTData } from '@lumaforge/luma-color-runtime'

import type { PreviewLookReason } from '../surface/raw-reason'
import { resolvePreviewLookReason } from '../surface/raw-reason'

/**
 * Why an HQ preview JPEG would not carry the selected look, or null when it
 * would. The WebGPU preview renders that JPEG, so it draws exactly what the
 * WebGPU preview policy resolves. A look the policy leaves out would leave
 * the JPEG without the look its name and recap claim, so the HQ export
 * refuses instead of writing it.
 */
export function resolveHqPreviewLookRefusal(input: {
  intent: ColorGraphIntent
  lut: LUTData | null
}): PreviewLookReason | null {
  return resolvePreviewLookReason({ ...input, executor: 'webgpu' })
}
