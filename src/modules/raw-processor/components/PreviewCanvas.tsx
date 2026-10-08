/**
 * WebGPU canvas component for rendering processed RAW images.
 */

import './preview-canvas.css'

import type { ColorGraphIntent, LUTData } from '@lumaforge/luma-color-runtime'
import {
  COLOR_GRAPH_INTENT_KEYS,
  pickColorGraphIntent,
} from '@lumaforge/luma-color-runtime'
import { m } from 'motion/react'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import { clsxm } from '~/lib/cn'
import { useI18n } from '~/lib/i18n'
import type { PreviewViewMode } from '~/lib/preview/preview-view'
import { previewSurfaceOutputForViewMode } from '~/lib/preview/preview-view'
import type { DecodedImage } from '~/lib/raw/decoder'
import { Spring } from '~/lib/spring'
import type { PipelineStats } from '~/lib/webgpu/raw-processing-pipeline'
import { RawProcessingPipeline } from '~/lib/webgpu/raw-processing-pipeline'
import { gpuPreviewInputParams } from '~/lib/webgpu/uniforms'

import {
  aspectFitBox,
  backingStoreSize,
  observeSettledBackingStore,
} from '../hooks/preview/backing-store-resize'
import type { PreviewPipelineHandle } from '../hooks/preview/usePreviewPipelineLifecycle'
import { usePreviewPipelineLifecycle } from '../hooks/preview/usePreviewPipelineLifecycle'
import { usePreviewViewportGestures } from '../hooks/preview/usePreviewViewportGestures'
import type { DisplaySource } from '../model/session'
import type { CompareRenderMode } from '../services/compare/compare-render-mode'
import {
  selectCompareRenderMode,
  supportsLayeredCompareCss,
} from '../services/compare/compare-render-mode'
import type { OriginalReferenceSnapshot } from '../services/compare/original-reference-snapshot'
import type { PreviewFrameStatus } from '../services/preview/preview-compare-readiness'
import {
  derivePreviewCompareReadiness,
  derivePreviewFrameStatusTransition,
  derivePreviewTrackReadinessTransition,
  EMPTY_ORIGINAL_GPU_FRAME_STATUS,
  EMPTY_PREVIEW_FRAME_STATUS,
} from '../services/preview/preview-compare-readiness'
import type { PreviewViewport } from '../services/preview/preview-viewport'
import {
  DEFAULT_PREVIEW_VIEWPORT,
  normalizePreviewViewport,
} from '../services/preview/preview-viewport'
import { OriginalGpuLayer } from './OriginalGpuLayer'
import { OriginalReferenceLayer } from './OriginalReferenceLayer'
import {
  createRawUploadInput,
  syncRawUploadInput,
} from './preview-canvas-helpers'

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

/**
 * The color intent, kept by reference while no field changes, so a render
 * that changes only the view never redraws the processed surface.
 */
function useStableColorIntent(color: ColorGraphIntent): ColorGraphIntent {
  const stableRef = useRef<ColorGraphIntent | null>(null)
  const picked = pickColorGraphIntent(color)
  const previous = stableRef.current
  if (
    previous &&
    COLOR_GRAPH_INTENT_KEYS.every((key) =>
      Object.is(previous[key], picked[key]),
    )
  ) {
    return previous
  }
  stableRef.current = picked
  return picked
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
  const suspendedRef = useRef(suspended)
  const processedUploadGenerationKeyRef = useRef('')
  const processedGenerationKeyRef = useRef('')
  const processedRenderRequestRef = useRef(0)
  const lutUploadFailedRef = useRef(false)
  const firstFrameWaitRef = useRef<{
    pipeline: RawProcessingPipeline
    generationKey: string
    completion: Promise<void>
  } | null>(null)
  const processedFrameStatusRef = useRef<PreviewFrameStatus>(
    EMPTY_PREVIEW_FRAME_STATUS,
  )
  const renderProcessedPreviewRef = useRef<(() => Promise<boolean>) | null>(
    null,
  )
  const [trackReady, setTrackReady] = useState(false)
  const [originalGpuStatus, setOriginalGpuStatus] = useState(
    EMPTY_ORIGINAL_GPU_FRAME_STATUS,
  )
  const [processedFrameStatus, setProcessedFrameStatus] =
    useState<PreviewFrameStatus>(EMPTY_PREVIEW_FRAME_STATUS)
  const [error, setError] = useState<string | null>(null)
  const showEmbeddedPreview =
    displaySource === 'embedded' && Boolean(embeddedPreviewUrl)
  const image = imageRef.current
  const imageWidth = image?.width ?? 0
  const imageHeight = image?.height ?? 0
  const hasImageData = Boolean(image?.data)
  const supportsCssClip = supportsLayeredCompareCss()

  const previewCompareReadiness = derivePreviewCompareReadiness({
    imageVersion,
    displaySource,
    imageSource: image?.source,
    imageWidth,
    imageHeight,
    hasImageData,
    trackReady,
    embeddedPreviewUrl,
    viewMode,
    dualGpuAllowed,
    suspended,
    supportsCssClip,
    originalGpuStatus,
    processedFrameStatus,
  })
  const {
    processedImageGenerationKey,
    currentProcessedFrameReady,
    processedPreviewVisible,
    originalGpuGenerationKey,
    originalGpuReady,
    originalGpuFailed,
    retainedProcessedFrameReady,
    compareFrameBridgeReady,
    embeddedPreviewFallbackReady,
    shouldMountOriginalGpuLayer,
    shouldDelayProcessedCompareRender,
  } = previewCompareReadiness
  processedGenerationKeyRef.current = processedImageGenerationKey
  const showEmbeddedHandoffPreview =
    displaySource === 'quick' &&
    Boolean(embeddedPreviewUrl) &&
    hasImageData &&
    !showEmbeddedPreview &&
    !processedPreviewVisible
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
  const processedTrackIdentity = [imageVersion, imageWidth, imageHeight].join(
    ':',
  )
  const retainedTrackIdentityRef = useRef('')

  useLayoutEffect(() => {
    const transition = derivePreviewTrackReadinessTransition({
      retainedTrackIdentity: retainedTrackIdentityRef.current,
      processedTrackIdentity,
      retainedProcessedFrameReady,
      handoffPreviewVisible: showEmbeddedHandoffPreview,
    })

    retainedTrackIdentityRef.current = transition.nextRetainedTrackIdentity
    if (transition.resetTrackReady) {
      setTrackReady(false)
    }
  }, [
    processedTrackIdentity,
    retainedProcessedFrameReady,
    showEmbeddedHandoffPreview,
  ])
  const compareRenderMode: CompareRenderMode = selectCompareRenderMode({
    requestedViewMode: showEmbeddedPreview ? 'processed' : viewMode,
    supportsCssClip,
    dualGpuAllowed,
    originalGpuReady: originalGpuReady && currentProcessedFrameReady,
    retainedCompareFrameReady: compareFrameBridgeReady,
    originalGpuFailed,
    embeddedPreviewReady: embeddedPreviewFallbackReady,
    jpegSnapshotReady: Boolean(originalReferenceSnapshot),
  })
  const isLayeredCompareActive =
    compareRenderMode.kind === 'dual-gpu' ||
    compareRenderMode.kind === 'embedded-fallback' ||
    compareRenderMode.kind === 'jpeg-fallback'
  const stableColor = useStableColorIntent(color)
  const processedSurfaceOutput = previewSurfaceOutputForViewMode(viewMode)
  const processedCanvasParams = useMemo(
    () =>
      gpuPreviewInputParams({
        color: stableColor,
        output: processedSurfaceOutput,
      }),
    [processedSurfaceOutput, stableColor],
  )
  suspendedRef.current = suspended

  const setFrameElement = useCallback(
    (element: HTMLDivElement | null) => {
      containerRef.current = element
      frameRef?.(element)
    },
    [frameRef],
  )

  const commitProcessedFrameStatus = useCallback(
    (nextStatus: PreviewFrameStatus) => {
      const transition = derivePreviewFrameStatusTransition({
        currentStatus: processedFrameStatusRef.current,
        nextStatus,
      })
      if (!transition.shouldCommit) {
        return
      }

      processedFrameStatusRef.current = transition.nextStatus
      setProcessedFrameStatus(transition.nextStatus)
    },
    [],
  )

  const resetProcessedFrameStatus = useCallback(() => {
    firstFrameWaitRef.current = null
    commitProcessedFrameStatus(EMPTY_PREVIEW_FRAME_STATUS)
  }, [commitProcessedFrameStatus])

  useEffect(() => {
    onCompareRenderModeChange?.(compareRenderMode.kind)
  }, [compareRenderMode.kind, onCompareRenderModeChange])

  // A published or forgotten pipeline starts with no image and no frame.
  const publishPipeline = useCallback(
    (pipeline: RawProcessingPipeline | null) => {
      processedUploadGenerationKeyRef.current = ''
      resetProcessedFrameStatus()
      if (pipeline) setError(null)
      onPipelineChange?.(pipeline)
    },
    [onPipelineChange, resetProcessedFrameStatus],
  )
  const reportInitializationError = useCallback((err: unknown) => {
    setError(
      err instanceof Error ? err.message : 'GPU preview initialization failed',
    )
  }, [])
  // The primary pipeline keeps a failed initialization until it is torn
  // down; its own failure report moves the preview to the CPU executor.
  const { pipelineRef, isInitialized } = usePreviewPipelineLifecycle({
    canvasRef,
    createPipeline: createProcessedPipeline,
    publish: publishPipeline,
    onInitializationError: reportInitializationError,
    suspended,
  })

  const syncProcessedImageUpload = useCallback(() => {
    const pipeline = pipelineRef.current
    if (!pipeline || !isInitialized) return false
    if (
      processedUploadGenerationKeyRef.current === processedImageGenerationKey
    ) {
      return true
    }

    const image = imageRef.current
    const uploadInput = createRawUploadInput({
      data: image?.data ?? null,
      layout: image?.layout ?? null,
      colorSpace: image?.colorSpace ?? null,
      width: image?.width ?? 0,
      height: image?.height ?? 0,
      renderExposureEv: image?.renderExposure.ev ?? 0,
    })
    const uploaded = syncRawUploadInput({
      pipeline,
      imageData: image?.data ?? null,
      uploadInput,
      setError,
    })
    processedUploadGenerationKeyRef.current = uploaded
      ? processedImageGenerationKey
      : ''

    return uploaded
  }, [imageRef, isInitialized, pipelineRef, processedImageGenerationKey])

  const renderProcessedPreview = useCallback(async () => {
    const pipeline = pipelineRef.current
    if (!pipeline || !isInitialized) return false
    const request = ++processedRenderRequestRef.current
    // Withhold frames (and supersede in-flight ones) while the selected LUT
    // is missing from the GPU.
    if (lutUploadFailedRef.current) return false
    const isCurrent = () =>
      pipelineRef.current === pipeline &&
      !suspendedRef.current &&
      processedRenderRequestRef.current === request &&
      processedGenerationKeyRef.current === processedImageGenerationKey
    try {
      if (!syncProcessedImageUpload()) return false
      pipeline.setParams(processedCanvasParams)
      const stats = pipeline.render()
      const renderedImage = imageRef.current
      const readyFrame = processedFrameStatusRef.current
      if (
        readyFrame.state !== 'ready' ||
        readyFrame.generationKey !== processedImageGenerationKey
      ) {
        // One completion proves the new image has rendered. Parameter edits
        // reuse that proof; already-ready generations never stall for the GPU.
        if (
          firstFrameWaitRef.current?.pipeline !== pipeline ||
          firstFrameWaitRef.current.generationKey !==
            processedImageGenerationKey
        ) {
          firstFrameWaitRef.current = {
            pipeline,
            generationKey: processedImageGenerationKey,
            completion: pipeline.waitForGpu(),
          }
        }
        await firstFrameWaitRef.current.completion
      }
      if (!isCurrent()) return false
      commitProcessedFrameStatus({
        generationKey: processedImageGenerationKey,
        displaySource,
        source: renderedImage?.source ?? 'preview',
        state: 'ready',
      })
      onStatsUpdate?.(stats)
      return true
    } catch (error) {
      if (isCurrent()) {
        firstFrameWaitRef.current = null
        setError(
          error instanceof Error ? error.message : 'Preview rendering failed',
        )
      }
      return false
    }
  }, [
    commitProcessedFrameStatus,
    displaySource,
    imageRef,
    isInitialized,
    onStatsUpdate,
    pipelineRef,
    processedCanvasParams,
    processedImageGenerationKey,
    syncProcessedImageUpload,
  ])

  useEffect(() => {
    renderProcessedPreviewRef.current = renderProcessedPreview
  }, [renderProcessedPreview])

  // Handle canvas resize
  useEffect(() => {
    const container = containerRef.current
    const track = trackRef.current
    const canvas = canvasRef.current
    const surface = surfaceRef.current

    if (!container || !track || !canvas || !surface) return
    if (typeof ResizeObserver === 'undefined') {
      setTrackReady(true)
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
        setTrackReady(true)
        return backingStoreSize(fit)
      },
      onApply: () => {
        const pipeline = pipelineRef.current
        if (!pipeline) return
        pipeline.resize(canvas.width, canvas.height)
        if (imageRef.current && !shouldDelayProcessedCompareRender) {
          renderProcessedPreviewRef.current?.()
        }
      },
      applyImmediately: () => !pipelineRef.current,
    })
  }, [
    imageRef,
    imageVersion,
    imageWidth,
    imageHeight,
    pipelineRef,
    shouldDelayProcessedCompareRender,
  ])

  // Upload image data when it changes
  useEffect(() => {
    syncProcessedImageUpload()
  }, [syncProcessedImageUpload])

  // Upload LUT when it changes
  useEffect(() => {
    const pipeline = pipelineRef.current
    if (!pipeline || !isInitialized) return
    const lutData = lutDataRef.current

    try {
      if (lutData) {
        pipeline.uploadLUT(lutData)
      } else {
        pipeline.clearLUT()
      }
      lutUploadFailedRef.current = false
    } catch {
      // The pipeline has dropped its LUT and reported the failure, which
      // moves the preview to the CPU executor. Until then the canvas must not
      // draw a LUT-less frame as the selected look, and the failure must not
      // escape this passive effect and tear down the whole /raw surface.
      lutUploadFailedRef.current = true
    }
  }, [lutDataRef, lutDataVersion, isInitialized, pipelineRef])

  // Draw once per processed input change: image, params, or LUT. It runs
  // after the LUT upload effect above, so a LUT-only version change renders
  // with the new LUT. Compare mode stays in CSS/DOM space, so the processed
  // canvas never enters the legacy single-canvas shader split path.
  useEffect(() => {
    if (shouldDelayProcessedCompareRender) return
    renderProcessedPreview()
  }, [
    imageVersion,
    lutDataRef,
    lutDataVersion,
    renderProcessedPreview,
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
                generationKey={originalGpuGenerationKey}
                onPipelineChange={onOriginalPreviewPipelineChange}
                onReady={(readyGenerationKey) => {
                  if (
                    readyGenerationKey === originalGpuGenerationKey &&
                    shouldDelayProcessedCompareRender
                  ) {
                    renderProcessedPreview()
                  }
                  setOriginalGpuStatus({
                    generationKey: readyGenerationKey,
                    displaySource,
                    state: 'ready',
                  })
                }}
                onError={(_, failedGenerationKey) => {
                  setOriginalGpuStatus({
                    generationKey: failedGenerationKey,
                    displaySource,
                    state: 'failed',
                  })
                  if (failedGenerationKey === originalGpuGenerationKey) {
                    onRequestOriginalReferenceFallback?.()
                  }
                }}
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
