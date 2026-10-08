/**
 * Markup of the WebGPU preview stage: the input frame, the zoom track, the
 * surface with its compare layers, and the stage overlays. It renders what
 * its caller decided; rendering, gestures, and compare policy stay there.
 */

import { m } from 'motion/react'
import type { ReactNode, RefCallback, RefObject } from 'react'

import { clsxm } from '~/lib/cn'
import { useI18n } from '~/lib/i18n'
import { Spring } from '~/lib/spring'

import type { PreviewViewportGestures } from '../hooks/preview/usePreviewViewportGestures'
import type { DisplaySource } from '../model/session'
import type { CompareRenderMode } from '../services/compare/compare-render-mode'
import type { PreviewViewport } from '../services/preview/preview-viewport'

export interface PreviewStageFrameProps {
  /** Receives the frame element, which owns pointer and wheel input. */
  frameRef: RefCallback<HTMLDivElement>
  /** The aspect-fit box the compare split and zoom/pan anchor to. */
  trackRef: RefObject<HTMLDivElement | null>
  surfaceRef: RefObject<HTMLDivElement | null>
  /** The processed surface's canvas. */
  canvasRef: RefObject<HTMLCanvasElement | null>
  frameHandlers: PreviewViewportGestures['frameHandlers']
  displaySource: DisplaySource
  interactive: boolean
  panning: boolean
  transforming: boolean
  /** A normalized viewport; the track carries it as CSS variables. */
  viewport: PreviewViewport
  trackReady: boolean
  compareMode: CompareRenderMode['kind']
  /** Shown on the processed layer while compare is processed-only. */
  compareFallbackReason?: string
  /** The original GPU layer, mounted while it warms or draws compare. */
  originalGpuLayer?: ReactNode
  /** The JPEG original reference layer under jpeg-fallback compare. */
  originalReferenceLayer?: ReactNode
  /** The camera's embedded JPEG standing in as the compare original. */
  embeddedOriginalSrc?: string | null
  embeddedPreviewUrl?: string | null
  /** The embedded JPEG stands in for the processed canvas. */
  showEmbeddedPreview: boolean
  /** The embedded JPEG covers the stage while the decoded frame catches up. */
  showEmbeddedHandoffPreview: boolean
  hasImage: boolean
  error: string | null
  className?: string
}

function EmbeddedOriginalLayer({ src }: { src: string }) {
  return (
    <div
      className="raw-preview-original-layer"
      aria-hidden="true"
      data-original-reference-source="embedded"
    >
      <img
        src={src}
        alt=""
        aria-hidden="true"
        draggable={false}
        className="raw-preview-original-image"
        decoding="async"
      />
    </div>
  )
}

export function PreviewStageFrame({
  frameRef,
  trackRef,
  surfaceRef,
  canvasRef,
  frameHandlers,
  displaySource,
  interactive,
  panning,
  transforming,
  viewport,
  trackReady,
  compareMode,
  compareFallbackReason,
  originalGpuLayer,
  originalReferenceLayer,
  embeddedOriginalSrc,
  embeddedPreviewUrl,
  showEmbeddedPreview,
  showEmbeddedHandoffPreview,
  hasImage,
  error,
  className,
}: PreviewStageFrameProps) {
  const { t } = useI18n()
  const isLayeredCompareActive =
    compareMode === 'dual-gpu' ||
    compareMode === 'embedded-fallback' ||
    compareMode === 'jpeg-fallback'

  return (
    <div
      ref={frameRef}
      data-raw-preview-frame
      data-display-source={displaySource}
      className={clsxm(
        'relative w-full h-full flex items-center justify-center bg-[var(--color-preview-mat)]',
        interactive &&
          (panning
            ? 'raw-preview-frame-panning'
            : 'raw-preview-frame-interactive'),
        transforming && 'raw-preview-frame-transforming',
        className,
      )}
      {...frameHandlers}
    >
      <div
        ref={trackRef}
        data-raw-compare-track="image"
        data-preview-track-ready={trackReady ? 'true' : 'false'}
        className="raw-preview-track"
        style={
          {
            '--raw-preview-zoom': viewport.zoom,
            '--raw-preview-pan-x': `${viewport.panX}px`,
            '--raw-preview-pan-y': `${viewport.panY}px`,
          } as React.CSSProperties
        }
      >
        <div
          ref={surfaceRef}
          data-raw-preview-surface
          className="raw-preview-surface"
        >
          {originalGpuLayer && (
            <div
              className={clsxm(
                'raw-preview-original-gpu-shell',
                compareMode === 'dual-gpu'
                  ? 'raw-preview-layer-clipped'
                  : 'opacity-0 pointer-events-none',
              )}
            >
              {originalGpuLayer}
            </div>
          )}

          {originalReferenceLayer}

          {embeddedOriginalSrc && (
            <EmbeddedOriginalLayer src={embeddedOriginalSrc} />
          )}

          <div
            className={clsxm(
              'raw-preview-processed-layer',
              isLayeredCompareActive && 'raw-preview-layer-clipped',
            )}
            data-compare-mode={compareMode}
            data-compare-fallback-reason={compareFallbackReason}
          >
            <canvas
              ref={canvasRef}
              className={clsxm(
                'raw-preview-canvas',
                showEmbeddedPreview && 'opacity-0',
              )}
            />
          </div>

          {showEmbeddedPreview && (
            <img
              src={embeddedPreviewUrl ?? undefined}
              alt={t('raw.preview.embeddedAlt')}
              className="raw-preview-embedded"
            />
          )}
        </div>
      </div>

      {showEmbeddedHandoffPreview && (
        <img
          src={embeddedPreviewUrl ?? undefined}
          alt=""
          aria-hidden="true"
          draggable={false}
          className="raw-preview-handoff-preview"
          data-raw-preview-handoff-preview
        />
      )}

      {error && (
        <m.div
          className="absolute inset-0 z-[4] flex items-center justify-center bg-background/80"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={Spring.presets.smooth}
        >
          <div className="flex flex-col items-center gap-4 text-center p-8">
            <div className="size-16 rounded-full bg-[var(--color-progress)]/15 flex items-center justify-center">
              <i className="i-mingcute-warning-line text-3xl text-[var(--color-progress)]" />
            </div>
            <div>
              <h3 className="text-lg font-medium text-text">
                {t('raw.preview.unavailable')}
              </h3>
              <p className="text-sm text-text-secondary mt-1">{error}</p>
            </div>
          </div>
        </m.div>
      )}

      {!hasImage && !error && !showEmbeddedPreview && (
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-text-tertiary text-sm">
            {t('raw.preview.noImage')}
          </span>
        </div>
      )}
    </div>
  )
}
