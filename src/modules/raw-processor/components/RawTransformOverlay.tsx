import { createPortal } from 'react-dom'

import { useI18n } from '~/lib/i18n'
import { TransformCanvas } from '~/modules/transform-demo/TransformCanvas'

import type { RawTransformFeature } from '../hooks/useRawTransformFeature'

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
  const { demo } = feature
  return createPortal(
    <div
      className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center overflow-hidden bg-lf-surface"
      data-transform-matrix={demo.result?.displayMatrix.join(',')}
      data-raw-transform-preview
      aria-busy={feature.busy}
    >
      {demo.source && demo.result ? (
        <TransformCanvas
          source={demo.source.frame}
          result={demo.result}
          lines={demo.analysis?.lines ?? NO_LINES}
          original={false}
          showLines={feature.showLines}
          showGrid={feature.showGrid}
        />
      ) : null}
      {feature.busy || feature.captureError || demo.error ? (
        <span
          role="status"
          className="absolute inset-x-2 bottom-2 rounded-md bg-lf-surface/90 px-3 py-2 text-center text-xs text-lf-on-surface"
        >
          {t(
            feature.captureError || demo.error
              ? 'raw.transform.unavailable'
              : 'transform.rendering',
          )}
        </span>
      ) : null}
    </div>,
    target,
  )
}
