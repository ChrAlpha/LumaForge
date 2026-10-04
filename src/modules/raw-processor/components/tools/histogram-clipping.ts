import type { ReadyPreviewHistogram } from '@lumaforge/luma-color-runtime'

import type { Translate } from '~/lib/i18n'

/**
 * Share of sampled pixels, kept honest at the edges: only a true zero reads
 * "0%", a sliver reads "<0.1%", and a near-total share never rounds up to a
 * full "100%".
 */
export function formatClippingPercent(count: number, sampledPixels: number) {
  if (count <= 0 || sampledPixels <= 0) return '0%'
  if (count >= sampledPixels) return '100%'
  const percent = (count / sampledPixels) * 100
  if (percent < 0.1) return '<0.1%'
  if (percent < 10) return `${percent.toFixed(1)}%`
  if (percent > 99) return '>99%'
  return `${Math.round(percent)}%`
}

export function histogramClippingLabels(
  histogram: ReadyPreviewHistogram,
  t: Translate,
) {
  const { clipping, sampledPixels } = histogram
  return {
    shadows: t('raw.histogram.shadows', {
      percent: formatClippingPercent(clipping.shadowAnyChannel, sampledPixels),
    }),
    highlights: t('raw.histogram.highlights', {
      percent: formatClippingPercent(
        clipping.highlightAnyChannel,
        sampledPixels,
      ),
    }),
  }
}
