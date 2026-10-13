/**
 * WebGPU canvas component for rendering processed RAW images.
 */

import './preview-canvas.css'

import type { ColorGraphIntent, LUTData } from '@lumaforge/luma-color-runtime'
import { useCallback, useEffect, useRef } from 'react'

import type { DecodedPreviewFrame } from '~/lib/preview/preview-frame'
import type { PreviewViewMode } from '~/lib/preview/preview-view'
import type { DecodedImage } from '~/lib/raw/decoder'
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
import { PreviewStageFrame } from './PreviewStageFrame'

export interface PreviewCanvasProps {
  imageRef: React.RefObject<DecodedImage | null>
  /**
   * The workflow's accepted descriptor of the frame `imageRef` holds; null
   * while no decoded frame is live (before a decode, with only the embedded
   * preview, and once the preview is released). Both GPU layers key their
   * uploads, draws, and readiness on it, and draw no decoded pixels without
   * one.
   */
  decodedFrame: DecodedPreviewFrame | null
  /** The color the processed surface draws; it carries no view state. */
  color: ColorGraphIntent
  /** How the stage shows the photo; compare layers the original over it. */
  viewMode: PreviewViewMode
  /**
   * The LUT record the processed surface draws through; a new record is a
   * new object, which uploads and draws again.
   */
  lutData: LUTData | null
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

export function PreviewCanvas({
  imageRef,
  decodedFrame,
  color,
  viewMode,
  lutData,
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
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const image = imageRef.current
  const imageWidth = image?.width ?? 0
  const imageHeight = image?.height ?? 0
  const hasImageData = decodedFrame !== null && Boolean(image?.data)
  const supportsCssClip = supportsLayeredCompareCss()

  const processed = useProcessedPreview<RawProcessingPipeline>({
    imageRef,
    decodedFrame,
    displaySource,
    color,
    viewMode,
    lutData,
    embeddedPreviewUrl,
    dualGpuAllowed,
    suspended,
    supportsCssClip,
    jpegSnapshotReady: Boolean(originalReferenceSnapshot),
    onStatsUpdate,
    onPipelineChange,
    onOriginalPipelineChange: onOriginalPreviewPipelineChange,
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

  // The resize observer reads the compare delay when a size applies, so a
  // readiness change alone never rebuilds the observer: the draw effect is
  // the one owner of the draw that lifting the delay starts.
  const delayProcessedRenderRef = useRef(shouldDelayProcessedCompareRender)
  useEffect(() => {
    delayProcessedRenderRef.current = shouldDelayProcessedCompareRender
  }, [shouldDelayProcessedCompareRender])
  // The canvas backing store size the processed surface last drew on. It is
  // recorded whether or not a pipeline exists yet: a pipeline published later
  // draws on that same store through the draw effect. Only a changed size
  // clears the canvas, so a rebuilt observer reporting its box again on
  // observe() neither resizes nor draws a second time.
  const appliedBackingStoreRef = useRef<{
    canvas: HTMLCanvasElement
    width: number
    height: number
  } | null>(null)

  // Handle canvas resize. The observer is rebuilt for every accepted frame,
  // because a frame without a retained predecessor hides the track until it
  // is measured again; it redraws only for a changed backing store. The draw
  // effect owns every draw an image, color, or readiness change starts.
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
        const applied = appliedBackingStoreRef.current
        const unchanged =
          applied?.canvas === canvas &&
          applied.width === canvas.width &&
          applied.height === canvas.height
        appliedBackingStoreRef.current = {
          canvas,
          width: canvas.width,
          height: canvas.height,
        }
        const pipeline = pipelineRef.current
        if (!pipeline || unchanged) return
        pipeline.resize(canvas.width, canvas.height)
        if (imageRef.current && !delayProcessedRenderRef.current) {
          redraw()
        }
      },
      applyImmediately: () => !pipelineRef.current,
    })
  }, [
    decodedFrame,
    imageRef,
    imageWidth,
    imageHeight,
    markTrackReady,
    pipelineRef,
    redraw,
  ])

  return (
    <PreviewStageFrame
      frameRef={setFrameElement}
      trackRef={trackRef}
      surfaceRef={surfaceRef}
      canvasRef={canvasRef}
      frameHandlers={frameHandlers}
      displaySource={displaySource}
      interactive={canInteractWithPreview}
      panning={isPointerPanning}
      transforming={isPointerPanning || isWheelInteracting}
      viewport={normalizedPreviewViewport}
      trackReady={trackReady}
      compareMode={compareRenderMode.kind}
      compareFallbackReason={
        compareRenderMode.kind === 'processed-only'
          ? (originalReferenceFallbackReason ?? compareRenderMode.reason)
          : undefined
      }
      originalGpuLayer={
        shouldMountOriginalGpuLayer ? (
          <OriginalGpuLayer
            imageRef={imageRef}
            decodedFrame={decodedFrame}
            generationKey={processed.originalGpuLayer.generationKey}
            onPipelineChange={processed.originalGpuLayer.onPipelineChange}
            onReady={processed.originalGpuLayer.onReady}
            onError={processed.originalGpuLayer.onError}
          />
        ) : null
      }
      originalReferenceLayer={
        compareRenderMode.kind === 'jpeg-fallback' &&
        originalReferenceSnapshot ? (
          <OriginalReferenceLayer snapshot={originalReferenceSnapshot} />
        ) : null
      }
      embeddedOriginalSrc={
        compareRenderMode.kind === 'embedded-fallback'
          ? embeddedPreviewUrl
          : null
      }
      embeddedPreviewUrl={embeddedPreviewUrl}
      showEmbeddedPreview={showEmbeddedPreview}
      showEmbeddedHandoffPreview={showEmbeddedHandoffPreview}
      hasImage={hasImageData}
      error={error}
      className={className}
    />
  )
}
