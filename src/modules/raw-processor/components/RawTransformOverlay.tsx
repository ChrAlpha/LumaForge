import { createPortal } from 'react-dom'

import { useI18n } from '~/lib/i18n'

import type { RawTransformFeature } from '../hooks/useRawTransformFeature'
import { TransformCanvas } from './TransformCanvas'

const NO_LINES: [] = []

export function RawTransformOverlay({
  feature,
  target,
}: {
  feature: RawTransformFeature
  target: HTMLDivElement | null
}) {
  const { t } = useI18n()
  if (!feature.showOverlay || !target) return null
  const { preview } = feature
  return createPortal(
    <div
      className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center overflow-hidden bg-lf-surface"
      data-transform-matrix={preview.result?.displayMatrix.join(',')}
      data-raw-transform-preview
      aria-busy={feature.busy}
    >
      {preview.source && preview.result ? (
        <TransformCanvas
          source={preview.source.frame}
          result={preview.result}
          lines={preview.analysis?.lines ?? NO_LINES}
          original={false}
          showLines={feature.showLines}
          showGrid={feature.showGrid}
        />
      ) : null}
      {feature.busy || feature.captureError || preview.error ? (
        <span
          role="status"
          className="absolute inset-x-2 bottom-2 rounded-md bg-lf-surface/90 px-3 py-2 text-center text-xs text-lf-on-surface"
        >
          {t(
            feature.captureError || preview.error
              ? 'raw.transform.unavailable'
              : 'transform.rendering',
          )}
        </span>
      ) : null}
    </div>,
    target,
  )
}
