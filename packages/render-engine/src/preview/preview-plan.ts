// Preview-resolution thresholds (engine copy; src/lib/raw/decoder.ts keeps an app-side copy)
export const QUICK_PREVIEW_MAX_PIXELS = 2_500_000
export const BOUNDED_HQ_PREVIEW_MAX_PIXELS = 12_000_000
export const BOUNDED_HQ_PREVIEW_LOW_MEMORY_MAX_PIXELS = 8_000_000

export type QuickPreviewTarget = {
  readonly source: 'quick'
  readonly maxOutputPixels: number
  readonly purpose: 'first-interactive-preview'
}

export type BoundedHqPreviewTarget = {
  readonly source: 'bounded-hq'
  readonly maxOutputPixels: number
  readonly purpose: 'detail-upgrade'
  readonly upgradesFrom: 'quick'
}

export type BoundedHqPreviewDecision =
  | { kind: 'decode'; target: BoundedHqPreviewTarget }
  | { kind: 'skip'; reason: string }

export type ProgressivePreviewPlan = {
  readonly quick: QuickPreviewTarget
  readonly boundedHq: BoundedHqPreviewDecision
}

export function createProgressivePreviewPlan({
  sourceWidth,
  sourceHeight,
  boundedHqMaxPixels = BOUNDED_HQ_PREVIEW_MAX_PIXELS,
}: {
  sourceWidth: number
  sourceHeight: number
  boundedHqMaxPixels?: number
}): ProgressivePreviewPlan {
  return {
    quick: {
      source: 'quick',
      maxOutputPixels: QUICK_PREVIEW_MAX_PIXELS,
      purpose: 'first-interactive-preview',
    },
    boundedHq: decideBoundedHqPreview({
      sourceWidth,
      sourceHeight,
      boundedHqMaxPixels,
    }),
  }
}

export function decideBoundedHqPreview({
  sourceWidth,
  sourceHeight,
  boundedHqMaxPixels = BOUNDED_HQ_PREVIEW_MAX_PIXELS,
}: {
  sourceWidth: number
  sourceHeight: number
  boundedHqMaxPixels?: number
}): BoundedHqPreviewDecision {
  const sourcePixels = sourceWidth * sourceHeight
  if (sourcePixels <= QUICK_PREVIEW_MAX_PIXELS) {
    return {
      kind: 'skip',
      reason: `Source fits within quick preview cap ${QUICK_PREVIEW_MAX_PIXELS}.`,
    }
  }

  return {
    kind: 'decode',
    target: {
      source: 'bounded-hq',
      maxOutputPixels: boundedHqMaxPixels,
      purpose: 'detail-upgrade',
      upgradesFrom: 'quick',
    },
  }
}
