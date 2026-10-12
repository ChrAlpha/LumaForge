import type { PreviewHistogramState } from '@lumaforge/luma-color-runtime'
import { atom } from 'jotai'

/**
 * Whether any surface shows the preview histogram. The histogram is real
 * work on the main thread (a run per look change, refined once input
 * settles), so it runs only while something draws it. The view writes this
 * from the surface in use, the preview mode, and Transform; the preview
 * stage reads it.
 */
export const previewHistogramEnabledAtom = atom(true)

/**
 * The mobile chrome's Histogram toggle (More menu). Off, no mobile surface
 * draws the histogram: neither the floating card nor the scrub HUD's.
 */
export const mobileHistogramShownAtom = atom(false)

/**
 * The desktop rail always shows the histogram (its card, or the clipping
 * counts on the card's trigger); a phone shows it only while turned on.
 * Neither shows it in the CPU preview or over an applied Transform.
 */
export function isPreviewHistogramShown(input: {
  mobileSurface: boolean
  mobileHistogramShown: boolean
  cpuPreview: boolean
  transformActive: boolean
}) {
  return (
    (!input.mobileSurface || input.mobileHistogramShown) &&
    !input.cpuPreview &&
    !input.transformActive
  )
}

/** What the histogram says while no frame is decoded. */
export const NO_IMAGE_HISTOGRAM: PreviewHistogramState = Object.freeze({
  state: 'unavailable',
  reason: 'no-image',
})

/**
 * The preview histogram as its runner last measured it. The runner sits
 * beside the stage rather than inside the workflow, so a result (one per
 * look change while a scrub moves) rerenders the surfaces that read this,
 * not the workspace above them.
 */
export const previewHistogramStateAtom =
  atom<PreviewHistogramState>(NO_IMAGE_HISTOGRAM)
