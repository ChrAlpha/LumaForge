/**
 * WebGL canvas component for rendering processed RAW images.
 */

import './preview-canvas.css'

import type { LUTData, ProcessingParams } from '@lumaforge/luma-color-runtime'
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
import type { PipelineStats } from '~/lib/gl/pipeline'
import { RawProcessingPipeline } from '~/lib/gl/pipeline'
import { useI18n } from '~/lib/i18n'
import type { DecodedImage } from '~/lib/raw/decoder'
import { Spring } from '~/lib/spring'

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
  EMPTY_ORIGINAL_WEBGL_FRAME_STATUS,
  EMPTY_PREVIEW_FRAME_STATUS,
} from '../services/preview/preview-compare-readiness'
import type {
  PreviewViewport,
  PreviewViewportGeometry,
} from '../services/preview/preview-viewport'
import {
  DEFAULT_PREVIEW_VIEWPORT,
  getWheelPreviewZoomTarget,
  normalizePreviewViewport,
  panPreviewViewport,
  resetPreviewViewport,
  zoomPreviewViewportAtPoint,
} from '../services/preview/preview-viewport'
import { OriginalReferenceLayer } from './OriginalReferenceLayer'
import type { OriginalWebglPipelineHandle } from './OriginalWebglLayer'
import { OriginalWebglLayer } from './OriginalWebglLayer'
import type { TrackedPointer } from './preview-canvas-helpers'
import {
  createRawUploadInput,
  getPointerDistance,
  getPointerMidpoint,
  syncRawUploadInput,
  tryCapturePointer,
  tryReleasePointer,
} from './preview-canvas-helpers'

export interface PreviewCanvasProps {
  imageRef: React.RefObject<DecodedImage | null>
  imageVersion: number
  params: ProcessingParams
  lutDataRef: React.RefObject<LUTData | null>
  lutDataVersion: number
  embeddedPreviewUrl?: string | null
  displaySource?: DisplaySource
  originalReferenceSnapshot?: OriginalReferenceSnapshot | null
  originalReferenceFallbackReason?: string | null
  dualWebglAllowed?: boolean
  suspended?: boolean
  interactionDisabled?: boolean
  previewViewport?: PreviewViewport
  onPreviewViewportChange?: (viewport: PreviewViewport) => void
  onStatsUpdate?: (stats: PipelineStats) => void
  onPipelineChange?: (pipeline: RawProcessingPipeline | null) => void
  onOriginalPreviewPipelineChange?: (
    pipeline: OriginalWebglPipelineHandle | null,
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

/** Trailing delay before the WebGL backing store follows a layout resize. */
const PREVIEW_RESIZE_SETTLE_MS = 90

export function PreviewCanvas({
  imageRef,
  imageVersion,
  params,
  lutDataRef,
  lutDataVersion,
  embeddedPreviewUrl,
  displaySource = 'none',
  originalReferenceSnapshot = null,
  originalReferenceFallbackReason = null,
  dualWebglAllowed = false,
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
  const pipelineRef = useRef<RawProcessingPipeline | null>(null)
  const suspendedRef = useRef(suspended)
  const previewViewportRef = useRef(previewViewport)
  const processedUploadGenerationKeyRef = useRef('')
  const processedFrameStatusRef = useRef<PreviewFrameStatus>(
    EMPTY_PREVIEW_FRAME_STATUS,
  )
  const renderProcessedPreviewRef = useRef<(() => boolean) | null>(null)
  const activePointersRef = useRef(new Map<number, TrackedPointer>())
  const pinchStartRef = useRef<{
    distance: number
    midpoint: TrackedPointer
    viewport: PreviewViewport
  } | null>(null)
  const pendingViewportRef = useRef<PreviewViewport | null>(null)
  const pendingViewportRafRef = useRef<number | null>(null)
  const wheelInteractionTimeoutRef = useRef<number | null>(null)
  const [isInitialized, setIsInitialized] = useState(false)
  const [isPointerPanning, setIsPointerPanning] = useState(false)
  const [isWheelInteracting, setIsWheelInteracting] = useState(false)
  const [trackReady, setTrackReady] = useState(false)
  const [originalWebglStatus, setOriginalWebglStatus] = useState(
    EMPTY_ORIGINAL_WEBGL_FRAME_STATUS,
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
    viewMode: params.viewMode,
    dualWebglAllowed,
    suspended,
    supportsCssClip,
    originalWebglStatus,
    processedFrameStatus,
  })
  const {
    processedImageGenerationKey,
    currentProcessedFrameReady,
    processedPreviewVisible,
    originalWebglGenerationKey,
    originalWebglReady,
    originalWebglFailed,
    retainedProcessedFrameReady,
    retainedCompareFrameReady,
    embeddedPreviewFallbackReady,
    shouldMountOriginalWebglLayer,
    shouldDelayProcessedCompareRender,
  } = previewCompareReadiness
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
    requestedViewMode: showEmbeddedPreview ? 'processed' : params.viewMode,
    supportsCssClip,
    dualWebglAllowed,
    originalWebglReady: originalWebglReady && currentProcessedFrameReady,
    retainedCompareFrameReady,
    originalWebglFailed,
    embeddedPreviewReady: embeddedPreviewFallbackReady,
    jpegSnapshotReady: Boolean(originalReferenceSnapshot),
  })
  const isLayeredCompareActive =
    compareRenderMode.kind === 'dual-webgl' ||
    compareRenderMode.kind === 'embedded-fallback' ||
    compareRenderMode.kind === 'jpeg-fallback'
  const pipelineCompareSplit =
    params.viewMode === 'compare' ? 0.5 : params.compareSplit
  const processedCanvasParams = useMemo(
    () =>
      ({
        intensity: params.intensity,
        viewMode: params.viewMode === 'compare' ? 'processed' : params.viewMode,
        compareSplit: pipelineCompareSplit,
        styleKind: params.styleKind,
        builtinPreset: params.builtinPreset,
        userExposureEv: params.userExposureEv,
        userContrast: params.userContrast,
        userHighlights: params.userHighlights,
        userShadows: params.userShadows,
        userWhites: params.userWhites,
        userBlacks: params.userBlacks,
        userTemperature: params.userTemperature,
        userTint: params.userTint,
        userSaturation: params.userSaturation,
        userVibrance: params.userVibrance,
        selectiveColor: params.selectiveColor,
      }) satisfies ProcessingParams,
    [
      params.builtinPreset,
      params.intensity,
      params.selectiveColor,
      params.styleKind,
      params.userBlacks,
      params.userContrast,
      params.userExposureEv,
      params.userHighlights,
      params.userShadows,
      params.userTemperature,
      params.userTint,
      params.userSaturation,
      params.userVibrance,
      params.userWhites,
      params.viewMode,
      pipelineCompareSplit,
    ],
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
    commitProcessedFrameStatus(EMPTY_PREVIEW_FRAME_STATUS)
  }, [commitProcessedFrameStatus])

  useEffect(() => {
    previewViewportRef.current = normalizedPreviewViewport
  }, [normalizedPreviewViewport])

  useEffect(() => {
    onCompareRenderModeChange?.(compareRenderMode.kind)
  }, [compareRenderMode.kind, onCompareRenderModeChange])

  const getViewportGeometry = useCallback(() => {
    const container = containerRef.current
    const track = trackRef.current

    if (!container || !track) return null

    const containerRect = container.getBoundingClientRect()
    const trackRect = track.getBoundingClientRect()
    const contentWidth =
      track.offsetWidth || track.clientWidth || trackRect.width
    const contentHeight =
      track.offsetHeight || track.clientHeight || trackRect.height

    if (
      containerRect.width <= 0 ||
      containerRect.height <= 0 ||
      contentWidth <= 0 ||
      contentHeight <= 0
    ) {
      return null
    }

    return {
      containerRect,
      geometry: {
        viewportWidth: containerRect.width,
        viewportHeight: containerRect.height,
        contentWidth,
        contentHeight,
      } satisfies PreviewViewportGeometry,
    }
  }, [])

  const commitPreviewViewport = useCallback(
    (viewport: PreviewViewport) => {
      previewViewportRef.current = viewport
      onPreviewViewportChange?.(viewport)
    },
    [onPreviewViewportChange],
  )

  const scheduleViewportCommit = useCallback(
    (viewport: PreviewViewport) => {
      previewViewportRef.current = viewport
      pendingViewportRef.current = viewport

      if (pendingViewportRafRef.current !== null) return

      pendingViewportRafRef.current = requestAnimationFrame(() => {
        pendingViewportRafRef.current = null
        const pending = pendingViewportRef.current
        if (pending) {
          pendingViewportRef.current = null
          onPreviewViewportChange?.(pending)
        }
      })
    },
    [onPreviewViewportChange],
  )

  const flushViewportCommit = useCallback(() => {
    if (pendingViewportRafRef.current !== null) {
      cancelAnimationFrame(pendingViewportRafRef.current)
      pendingViewportRafRef.current = null
    }
    const pending = pendingViewportRef.current
    if (pending) {
      pendingViewportRef.current = null
      onPreviewViewportChange?.(pending)
    }
  }, [onPreviewViewportChange])

  const getRelativeOrigin = useCallback(
    (clientX: number, clientY: number) => {
      const viewportGeometry = getViewportGeometry()
      if (!viewportGeometry) return null

      const { containerRect, geometry } = viewportGeometry

      return {
        geometry,
        originX: clientX - containerRect.left - containerRect.width / 2,
        originY: clientY - containerRect.top - containerRect.height / 2,
      }
    },
    [getViewportGeometry],
  )

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
  }, [imageRef, isInitialized, processedImageGenerationKey])

  const renderProcessedPreview = useCallback(() => {
    const pipeline = pipelineRef.current
    if (!pipeline || !isInitialized) return false
    if (!syncProcessedImageUpload()) return false

    pipeline.setParams(processedCanvasParams)
    const stats = pipeline.render()
    const renderedImage = imageRef.current
    commitProcessedFrameStatus({
      generationKey: processedImageGenerationKey,
      displaySource,
      source: renderedImage?.source ?? 'preview',
      state: 'ready',
    })
    onStatsUpdate?.(stats)
    return true
  }, [
    commitProcessedFrameStatus,
    displaySource,
    imageRef,
    isInitialized,
    onStatsUpdate,
    processedCanvasParams,
    processedImageGenerationKey,
    syncProcessedImageUpload,
  ])

  useEffect(() => {
    renderProcessedPreviewRef.current = renderProcessedPreview
  }, [renderProcessedPreview])

  // Initialize pipeline
  useEffect(() => {
    if (suspended) {
      pipelineRef.current = null
      processedUploadGenerationKeyRef.current = ''
      resetProcessedFrameStatus()
      onPipelineChange?.(null)
      setIsInitialized(false)
      return
    }

    const canvas = canvasRef.current
    if (!canvas) return

    let pipeline: RawProcessingPipeline | null = null
    let originalDispose: RawProcessingPipeline['dispose'] | null = null
    let cancelled = false
    let disposed = false

    const disposePipeline = (
      options?: Parameters<RawProcessingPipeline['dispose']>[0],
    ) => {
      if (!pipeline || disposed) {
        return
      }

      const disposedPipeline = pipeline
      pipeline = null
      disposed = true
      if (pipelineRef.current === disposedPipeline) {
        pipelineRef.current = null
        processedUploadGenerationKeyRef.current = ''
        resetProcessedFrameStatus()
        onPipelineChange?.(null)
      }
      setIsInitialized(false)
      ;(originalDispose ?? disposedPipeline.dispose)(options)
    }

    const init = async () => {
      try {
        pipeline = new RawProcessingPipeline(canvas)
        originalDispose = pipeline.dispose.bind(pipeline)
        pipeline.dispose = (options) => {
          disposePipeline(options)
        }
        await pipeline.initialize()
        if (cancelled) {
          disposePipeline()
          return
        }

        pipelineRef.current = pipeline
        processedUploadGenerationKeyRef.current = ''
        resetProcessedFrameStatus()
        onPipelineChange?.(pipeline)
        setIsInitialized(true)
        setError(null)
      } catch (err) {
        if (cancelled) {
          return
        }

        setError(
          err instanceof Error ? err.message : 'WebGL initialization failed',
        )
      }
    }

    init()

    return () => {
      cancelled = true
      disposePipeline({ releaseContext: suspendedRef.current })
      pipelineRef.current = null
      onPipelineChange?.(null)
    }
  }, [onPipelineChange, resetProcessedFrameStatus, suspended])

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

    // The backing store only follows layout once the size has settled. The
    // mobile stage animates its insets while the chrome opens or closes, and
    // re-rendering the WebGL frame on every intermediate size would cost a
    // full pipeline pass per animation frame. In between, the canvas is
    // CSS-scaled inside a track that keeps the photo aspect ratio, which
    // reads as continuous motion. The first fit always applies immediately.
    let settleTimer: number | null = null
    let pendingBacking: { width: number; height: number } | null = null
    let hasFitOnce = false

    const applyBackingStore = () => {
      const next = pendingBacking
      pendingBacking = null
      if (!next) return
      if (canvas.width !== next.width || canvas.height !== next.height) {
        canvas.width = next.width
        canvas.height = next.height
      }
      const pipeline = pipelineRef.current
      if (pipeline) {
        pipeline.resize(canvas.width, canvas.height)
        if (imageRef.current && !shouldDelayProcessedCompareRender) {
          renderProcessedPreviewRef.current?.()
        }
      }
    }

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect
        const dpr = Math.min(window.devicePixelRatio, 2)

        // Calculate aspect-fit dimensions
        let canvasWidth = width
        let canvasHeight = height
        if (imageWidth > 0 && imageHeight > 0) {
          const aspectRatio = imageWidth / imageHeight
          const containerAspect = width / height

          if (aspectRatio > containerAspect) {
            canvasWidth = width
            canvasHeight = width / aspectRatio
          } else {
            canvasHeight = height
            canvasWidth = height * aspectRatio
          }
        }

        track.style.width = `${canvasWidth}px`
        track.style.height = `${canvasHeight}px`
        canvas.style.width = '100%'
        canvas.style.height = '100%'
        pendingBacking = {
          width: Math.round(canvasWidth * dpr),
          height: Math.round(canvasHeight * dpr),
        }

        setTrackReady(true)

        if (settleTimer !== null) {
          window.clearTimeout(settleTimer)
          settleTimer = null
        }
        if (!hasFitOnce || !pipelineRef.current) {
          hasFitOnce = true
          applyBackingStore()
          continue
        }
        settleTimer = window.setTimeout(() => {
          settleTimer = null
          applyBackingStore()
        }, PREVIEW_RESIZE_SETTLE_MS)
      }
    })

    resizeObserver.observe(container)

    return () => {
      resizeObserver.disconnect()
      if (settleTimer !== null) {
        window.clearTimeout(settleTimer)
        settleTimer = null
        // Flush so a remount never leaves a stale backing store behind.
        applyBackingStore()
      }
    }
  }, [
    imageRef,
    imageVersion,
    imageWidth,
    imageHeight,
    shouldDelayProcessedCompareRender,
  ])

  const resetActivePreviewPointers = useCallback(() => {
    activePointersRef.current.clear()
    pinchStartRef.current = null
    setIsPointerPanning(false)
  }, [])

  const handleWheel = useCallback(
    (event: WheelEvent) => {
      if (!canInteractWithPreview) return

      const origin = getRelativeOrigin(event.clientX, event.clientY)
      if (!origin) return

      event.preventDefault()
      event.stopPropagation()
      setIsWheelInteracting(true)
      if (wheelInteractionTimeoutRef.current !== null) {
        window.clearTimeout(wheelInteractionTimeoutRef.current)
      }
      wheelInteractionTimeoutRef.current = window.setTimeout(() => {
        wheelInteractionTimeoutRef.current = null
        setIsWheelInteracting(false)
      }, 180)

      const current = previewViewportRef.current
      const nextZoom = getWheelPreviewZoomTarget(current.zoom, {
        deltaY: event.deltaY,
        deltaMode: event.deltaMode,
        ctrlKey: event.ctrlKey,
      })

      scheduleViewportCommit(
        zoomPreviewViewportAtPoint(current, {
          ...origin,
          nextZoom,
        }),
      )
    },
    [canInteractWithPreview, scheduleViewportCommit, getRelativeOrigin],
  )

  useEffect(() => {
    return () => {
      if (wheelInteractionTimeoutRef.current !== null) {
        window.clearTimeout(wheelInteractionTimeoutRef.current)
        wheelInteractionTimeoutRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    container.addEventListener('wheel', handleWheel, { passive: false })

    return () => {
      container.removeEventListener('wheel', handleWheel)
    }
  }, [handleWheel])

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!canInteractWithPreview || event.button !== 0) return

      event.preventDefault()
      event.stopPropagation()
      tryCapturePointer(event.currentTarget, event.pointerId)

      activePointersRef.current.set(event.pointerId, {
        clientX: event.clientX,
        clientY: event.clientY,
      })

      const pointers = Array.from(activePointersRef.current.values())
      if (pointers.length >= 2) {
        const [first, second] = pointers
        pinchStartRef.current = {
          distance: getPointerDistance(first!, second!),
          midpoint: getPointerMidpoint(first!, second!),
          viewport: previewViewportRef.current,
        }
      }

      setIsPointerPanning(true)
    },
    [canInteractWithPreview],
  )

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!canInteractWithPreview) return

      const previous = activePointersRef.current.get(event.pointerId)
      if (!previous) return

      event.preventDefault()
      event.stopPropagation()

      activePointersRef.current.set(event.pointerId, {
        clientX: event.clientX,
        clientY: event.clientY,
      })

      const pointers = Array.from(activePointersRef.current.values())
      const viewportGeometry = getViewportGeometry()
      if (!viewportGeometry) return

      if (pointers.length >= 2 && pinchStartRef.current) {
        const [first, second] = pointers
        const distance = getPointerDistance(first!, second!)
        if (pinchStartRef.current.distance <= 0) return

        const midpoint = pinchStartRef.current.midpoint
        const origin = getRelativeOrigin(midpoint.clientX, midpoint.clientY)
        if (!origin) return

        scheduleViewportCommit(
          zoomPreviewViewportAtPoint(pinchStartRef.current.viewport, {
            ...origin,
            nextZoom:
              pinchStartRef.current.viewport.zoom *
              (distance / pinchStartRef.current.distance),
          }),
        )
        return
      }

      if (previewViewportRef.current.zoom <= 1) {
        return
      }

      scheduleViewportCommit(
        panPreviewViewport(previewViewportRef.current, {
          geometry: viewportGeometry.geometry,
          deltaX: event.clientX - previous.clientX,
          deltaY: event.clientY - previous.clientY,
        }),
      )
    },
    [
      canInteractWithPreview,
      scheduleViewportCommit,
      getRelativeOrigin,
      getViewportGeometry,
    ],
  )

  const handlePointerRelease = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!activePointersRef.current.has(event.pointerId)) return

      event.preventDefault()
      event.stopPropagation()
      activePointersRef.current.delete(event.pointerId)
      tryReleasePointer(event.currentTarget, event.pointerId)

      if (activePointersRef.current.size < 2) {
        pinchStartRef.current = null
      }
      if (activePointersRef.current.size === 0) {
        flushViewportCommit()
        setIsPointerPanning(false)
      }
    },
    [flushViewportCommit],
  )

  const handleDoubleClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!canInteractWithPreview) return

      event.preventDefault()
      event.stopPropagation()
      resetActivePreviewPointers()
      commitPreviewViewport(resetPreviewViewport())
    },
    [canInteractWithPreview, commitPreviewViewport, resetActivePreviewPointers],
  )

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
    } catch (err) {
      // A failed LUT texture upload degrades to a LUT-less preview (the
      // pipeline clears its LUT state on failure); it must not escape this
      // passive effect and tear down the whole /raw surface.
      console.warn('LUT upload failed; rendering preview without the LUT:', err)
    }
  }, [lutDataRef, lutDataVersion, isInitialized])

  // Update params and render when the processed preview inputs change.
  // Compare mode now stays in CSS/DOM space, so the processed canvas never
  // enters the legacy single-canvas shader split path.
  useEffect(() => {
    if (shouldDelayProcessedCompareRender) return
    renderProcessedPreview()
  }, [imageVersion, renderProcessedPreview, shouldDelayProcessedCompareRender])

  // Re-render when LUT changes
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
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerRelease}
      onPointerCancel={handlePointerRelease}
      onDoubleClick={handleDoubleClick}
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
          {shouldMountOriginalWebglLayer && (
            <div
              className={clsxm(
                'raw-preview-original-webgl-shell',
                compareRenderMode.kind === 'dual-webgl'
                  ? 'raw-preview-layer-clipped'
                  : 'opacity-0 pointer-events-none',
              )}
            >
              <OriginalWebglLayer
                imageRef={imageRef}
                imageVersion={imageVersion}
                generationKey={originalWebglGenerationKey}
                onPipelineChange={onOriginalPreviewPipelineChange}
                onReady={(readyGenerationKey) => {
                  if (
                    readyGenerationKey === originalWebglGenerationKey &&
                    shouldDelayProcessedCompareRender
                  ) {
                    renderProcessedPreview()
                  }
                  setOriginalWebglStatus({
                    generationKey: readyGenerationKey,
                    displaySource,
                    state: 'ready',
                  })
                }}
                onError={(_, failedGenerationKey) => {
                  setOriginalWebglStatus({
                    generationKey: failedGenerationKey,
                    displaySource,
                    state: 'failed',
                  })
                  if (failedGenerationKey === originalWebglGenerationKey) {
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
