/**
 * How the app shows the photo, apart from the color the user asked for and
 * from the executor that draws it. The mode and compare split live on the
 * session (or on the detached sample view before a source loads); zoom and
 * pan stay with the preview viewport. Executors never own this state: each
 * one receives only the output selection a mode maps to.
 */

export type PreviewViewMode = 'processed' | 'original' | 'compare'

export const PREVIEW_VIEW_MODES: readonly PreviewViewMode[] = Object.freeze([
  'processed',
  'original',
  'compare',
])

export interface PreviewView {
  readonly mode: PreviewViewMode
  /** Frame-anchored split position in 0..1, read only in `compare`. */
  readonly compareSplit: number
}

export const DEFAULT_PREVIEW_VIEW: PreviewView = Object.freeze({
  mode: 'compare',
  compareSplit: 0.5,
})

/**
 * What a single preview surface draws. `technical-original` is the RAW render
 * with its exposure but without the user's color or look; it is an executor
 * selection, never a color intent.
 */
export type PreviewSurfaceOutput = 'processed' | 'technical-original'

/**
 * The processed surface's output for a view mode. Compare draws the processed
 * photo; the stage layers the original over it at the frame-anchored split.
 */
export function previewSurfaceOutputForViewMode(
  mode: PreviewViewMode,
): PreviewSurfaceOutput {
  return mode === 'original' ? 'technical-original' : 'processed'
}

/**
 * The CPU preview frame for a view mode. The CPU preview has no split
 * surface, so compare shows the processed frame; original shows the neutral
 * frame, which keeps the RAW render exposure.
 */
export function cpuPreviewVariantForViewMode(
  mode: PreviewViewMode,
): 'processed' | 'neutral' {
  return mode === 'original' ? 'neutral' : 'processed'
}
