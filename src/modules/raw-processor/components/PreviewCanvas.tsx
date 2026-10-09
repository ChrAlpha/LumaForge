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
  /** Bumped whenever `imageRef` changes; it never names a frame. */
  imageVersion: number
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

export function PreviewCanvas({
  imageRef,
  imageVersion,
  decodedFrame,
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
    imageVersion,
    decodedFrame,
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
            onPipelineChange={onOriginalPreviewPipelineChange}
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
