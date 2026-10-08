/**
 * WebGPU canvas component for rendering processed RAW images.
 */

import './preview-canvas.css'

import type { ColorGraphIntent, LUTData } from '@lumaforge/luma-color-runtime'
import { m } from 'motion/react'
import { useCallback, useEffect, useRef } from 'react'

import { clsxm } from '~/lib/cn'
import { useI18n } from '~/lib/i18n'
import type { PreviewViewMode } from '~/lib/preview/preview-view'
import type { DecodedImage } from '~/lib/raw/decoder'
import { Spring } from '~/lib/spring'
import type { PipelineStats } from '~/lib/webgpu/raw-processing-pipeline'
import { RawProcessingPipeline } from '~/lib/webgpu/raw-processing-pipeline'

import {
  aspectFitBox,
  backingStoreSize,
  observeSettledBackingStore,
} from '../hooks/preview/backing-store-resize'
import type { PreviewPipelineHandle } from '../hooks/preview/usePreviewPipelineLifecycle'
import { usePreviewPipelineLifecycle } from '../hooks/preview/usePreviewPipelineLifecycle'
import { usePreviewViewportGestures } from '../hooks/preview/usePreviewViewportGestures'
import { useProcessedPreview } from '../hooks/preview/useProcessedPreview'
import type { DisplaySource } from '../model/session'
import type { CompareRenderMode } from '../services/compare/compare-render-mode'
import { supportsLayeredCompareCss } from '../services/compare/compare-render-mode'
import type { OriginalReferenceSnapshot } from '../services/compare/original-reference-snapshot'
import type { PreviewViewport } from '../services/preview/preview-viewport'
import {
  DEFAULT_PREVIEW_VIEWPORT,
  normalizePreviewViewport,
} from '../services/preview/preview-viewport'
import { OriginalGpuLayer } from './OriginalGpuLayer'
import { OriginalReferenceLayer } from './OriginalReferenceLayer'

export interface PreviewCanvasProps {
  imageRef: React.RefObject<DecodedImage | null>
  imageVersion: number
  /** The color the processed surface draws; it carries no view state. */
  color: ColorGraphIntent
  /** How the stage shows the photo; compare layers the original over it. */
  viewMode: PreviewViewMode
  lutDataRef: React.RefObject<LUTData | null>
  lutDataVersion: number
  embeddedPreviewUrl?: string | null
  displaySource?: DisplaySource
  originalReferenceSnapshot?: OriginalReferenceSnapshot | null
  originalReferenceFallbackReason?: string | null
  dualGpuAllowed?: boolean
  suspended?: boolean
  interactionDisabled?: boolean
  previewViewport?: PreviewViewport
  onPreviewViewportChange?: (viewport: PreviewViewport) => void
  onStatsUpdate?: (stats: PipelineStats) => void
  onPipelineChange?: (pipeline: RawProcessingPipeline | null) => void
  onOriginalPreviewPipelineChange?: (
    pipeline: PreviewPipelineHandle | null,
  ) => void
  onCompareRenderModeChange?: (mode: CompareRenderMode['kind']) => void
  onRequestOriginalReferenceFallback?: () => void
  /**
   * Callback ref that receives the interactive preview frame element.
   * Used by overlay UI (e.g. mobile chrome) to attach gesture listeners
   * to the same element that owns pinch/pan, instead of a sibling overlay
   * that would block multi-touch.
   */
  frameRef?: (element: HTMLDivElement | null) => void
  className?: string
}

function createProcessedPipeline(canvas: HTMLCanvasElement) {
  return new RawProcessingPipeline(canvas)
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

export function PreviewCanvas({
  imageRef,
  imageVersion,
  color,
  viewMode,
  lutDataRef,
  lutDataVersion,
  embeddedPreviewUrl,
  displaySource = 'none',
  originalReferenceSnapshot = null,
  originalReferenceFallbackReason = null,
  dualGpuAllowed = false,
  suspended = false,
  interactionDisabled = false,
  previewViewport = DEFAULT_PREVIEW_VIEWPORT,
  onPreviewViewportChange,
  onStatsUpdate,
  onPipelineChange,
  onOriginalPreviewPipelineChange,
  onCompareRenderModeChange,
  onRequestOriginalReferenceFallback,
  frameRef,
  className,
}: PreviewCanvasProps) {
  const { t } = useI18n()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const image = imageRef.current
  const imageWidth = image?.width ?? 0
  const imageHeight = image?.height ?? 0
  const hasImageData = Boolean(image?.data)
  const supportsCssClip = supportsLayeredCompareCss()

  const processed = useProcessedPreview<RawProcessingPipeline>({
    imageRef,
    imageVersion,
    displaySource,
    color,
    viewMode,
    lutDataRef,
    lutDataVersion,
    embeddedPreviewUrl,
    dualGpuAllowed,
    suspended,
    supportsCssClip,
    jpegSnapshotReady: Boolean(originalReferenceSnapshot),
    onStatsUpdate,
    onPipelineChange,
    onRequestOriginalReferenceFallback,
  })
  const {
    showEmbeddedPreview,
    embeddedHandoffPreviewVisible: showEmbeddedHandoffPreview,
    shouldMountOriginalGpuLayer,
    shouldDelayProcessedCompareRender,
    compareRenderMode,
    trackReady,
    markTrackReady,
    redraw,
    error,
  } = processed
  const canInteractWithPreview =
    !suspended &&
    !interactionDisabled &&
    (hasImageData || showEmbeddedPreview) &&
    Boolean(onPreviewViewportChange)
  const normalizedPreviewViewport = normalizePreviewViewport(previewViewport)
  const { isPointerPanning, isWheelInteracting, frameHandlers } =
    usePreviewViewportGestures({
      frameRef: containerRef,
      trackRef,
      viewport: normalizedPreviewViewport,
      enabled: canInteractWithPreview,
      onViewportChange: onPreviewViewportChange,
    })
  const isLayeredCompareActive =
    compareRenderMode.kind === 'dual-gpu' ||
    compareRenderMode.kind === 'embedded-fallback' ||
    compareRenderMode.kind === 'jpeg-fallback'

  const setFrameElement = useCallback(
    (element: HTMLDivElement | null) => {
      containerRef.current = element
      frameRef?.(element)
    },
    [frameRef],
  )

  useEffect(() => {
    onCompareRenderModeChange?.(compareRenderMode.kind)
  }, [compareRenderMode.kind, onCompareRenderModeChange])

  // The primary pipeline keeps a failed initialization until it is torn
  // down; its own failure report moves the preview to the CPU executor.
  const { pipelineRef } = usePreviewPipelineLifecycle({
    canvasRef,
    createPipeline: createProcessedPipeline,
    publish: processed.publishPipeline,
    onInitializationError: processed.reportInitializationError,
    suspended,
  })

  // Handle canvas resize
  useEffect(() => {
    const container = containerRef.current
    const track = trackRef.current
    const canvas = canvasRef.current
    const surface = surfaceRef.current

    if (!container || !track || !canvas || !surface) return
    if (typeof ResizeObserver === 'undefined') {
      markTrackReady()
      return
    }

    // While the size settles, CSS scales the canvas inside a track that keeps
    // the photo aspect ratio, which reads as continuous motion. Until a
    // pipeline exists there is nothing to redraw, so every size applies.
    return observeSettledBackingStore(container, canvas, {
      measure: (contentRect) => {
        const fit = aspectFitBox(contentRect, {
          width: imageWidth,
          height: imageHeight,
        })
        track.style.width = `${fit.width}px`
        track.style.height = `${fit.height}px`
        canvas.style.width = '100%'
        canvas.style.height = '100%'
        markTrackReady()
        return backingStoreSize(fit)
      },
      onApply: () => {
        const pipeline = pipelineRef.current
        if (!pipeline) return
        pipeline.resize(canvas.width, canvas.height)
        if (imageRef.current && !shouldDelayProcessedCompareRender) {
          redraw()
        }
      },
      applyImmediately: () => !pipelineRef.current,
    })
  }, [
    imageRef,
    imageVersion,
    imageWidth,
    imageHeight,
    markTrackReady,
    pipelineRef,
    redraw,
    shouldDelayProcessedCompareRender,
  ])

  return (
    <div
      ref={setFrameElement}
      data-raw-preview-frame
      data-display-source={displaySource}
      className={clsxm(
        'relative w-full h-full flex items-center justify-center bg-[var(--color-preview-mat)]',
        canInteractWithPreview &&
          (isPointerPanning
            ? 'raw-preview-frame-panning'
            : 'raw-preview-frame-interactive'),
        (isPointerPanning || isWheelInteracting) &&
          'raw-preview-frame-transforming',
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
            '--raw-preview-zoom': normalizedPreviewViewport.zoom,
            '--raw-preview-pan-x': `${normalizedPreviewViewport.panX}px`,
            '--raw-preview-pan-y': `${normalizedPreviewViewport.panY}px`,
          } as React.CSSProperties
        }
      >
        <div
          ref={surfaceRef}
          data-raw-preview-surface
          className="raw-preview-surface"
        >
          {shouldMountOriginalGpuLayer && (
            <div
              className={clsxm(
                'raw-preview-original-gpu-shell',
                compareRenderMode.kind === 'dual-gpu'
                  ? 'raw-preview-layer-clipped'
                  : 'opacity-0 pointer-events-none',
              )}
            >
              <OriginalGpuLayer
                imageRef={imageRef}
                imageVersion={imageVersion}
                generationKey={processed.originalGpuLayer.generationKey}
                onPipelineChange={onOriginalPreviewPipelineChange}
                onReady={processed.originalGpuLayer.onReady}
                onError={processed.originalGpuLayer.onError}
              />
            </div>
          )}

          {compareRenderMode.kind === 'jpeg-fallback' &&
            originalReferenceSnapshot && (
              <OriginalReferenceLayer snapshot={originalReferenceSnapshot} />
            )}

          {compareRenderMode.kind === 'embedded-fallback' &&
            embeddedPreviewUrl && (
              <EmbeddedOriginalLayer src={embeddedPreviewUrl} />
            )}

          <div
            className={clsxm(
              'raw-preview-processed-layer',
              isLayeredCompareActive && 'raw-preview-layer-clipped',
            )}
            data-compare-mode={compareRenderMode.kind}
            data-compare-fallback-reason={
              compareRenderMode.kind === 'processed-only'
                ? (originalReferenceFallbackReason ?? compareRenderMode.reason)
                : undefined
            }
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

      {!hasImageData && !error && !showEmbeddedPreview && (
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-text-tertiary text-sm">
            {t('raw.preview.noImage')}
          </span>
        </div>
      )}
    </div>
  )
}
