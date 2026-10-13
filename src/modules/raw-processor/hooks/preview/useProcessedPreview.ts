import type { ColorGraphIntent, LUTData } from '@lumaforge/luma-color-runtime'
import {
  COLOR_GRAPH_INTENT_KEYS,
  pickColorGraphIntent,
} from '@lumaforge/luma-color-runtime'
import type { RefObject } from 'react'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import type { DecodedPreviewFrame } from '~/lib/preview/preview-frame'
import type { PreviewViewMode } from '~/lib/preview/preview-view'
import { previewSurfaceOutputForViewMode } from '~/lib/preview/preview-view'
import type { DecodedImage } from '~/lib/raw/decoder'
import type {
  PipelineStats,
  RawProcessingPipeline,
} from '~/lib/webgpu/raw-processing-pipeline'

import type { DisplaySource } from '../../model/session'
import type { CompareRenderMode } from '../../services/compare/compare-render-mode'
import { selectCompareRenderMode } from '../../services/compare/compare-render-mode'
import {
  createRawUploadInput,
  syncRawUploadInput,
} from '../../services/preview/preview-canvas-helpers'
import type {
  PreviewCompareReadiness,
  PreviewFrameStatus,
} from '../../services/preview/preview-compare-readiness'
import {
  derivePreviewCompareReadiness,
  derivePreviewFrameStatusTransition,
  derivePreviewTrackReadinessTransition,
  EMPTY_ORIGINAL_GPU_FRAME_STATUS,
  EMPTY_PREVIEW_FRAME_STATUS,
} from '../../services/preview/preview-compare-readiness'
import type { PreviewPipelineHandle } from './usePreviewPipelineLifecycle'

/** The drawing surface of the processed preview pipeline. */
export type ProcessedPreviewPipeline = Pick<
  RawProcessingPipeline,
  | 'clearImage'
  | 'uploadImage'
  | 'clearLUT'
  | 'uploadLUT'
  | 'setParams'
  | 'render'
  | 'waitForGpu'
>

export interface ProcessedPreviewOptions<
  TPipeline extends ProcessedPreviewPipeline,
> {
  imageRef: RefObject<DecodedImage | null>
  /**
   * Bumped whenever `imageRef` changes. It only notifies; it never names a
   * frame.
   */
  imageVersion: number
  /**
   * The workflow's accepted descriptor of the frame `imageRef` holds, which
   * keys every upload, draw, and readiness report. Null authorizes no decoded
   * drawing: the surface clears its image instead.
   */
  decodedFrame: DecodedPreviewFrame | null
  displaySource: DisplaySource
  /** The color the processed surface draws; it carries no view state. */
  color: ColorGraphIntent
  viewMode: PreviewViewMode
  lutDataRef: RefObject<LUTData | null>
  lutDataVersion: number
  embeddedPreviewUrl?: string | null
  dualGpuAllowed: boolean
  suspended: boolean
  supportsCssClip: boolean
  /** Whether a JPEG snapshot of the original can stand in for compare. */
  jpegSnapshotReady: boolean
  onStatsUpdate?: (stats: PipelineStats) => void
  onPipelineChange?: (pipeline: TPipeline | null) => void
  /** Hears every pipeline the original GPU layer publishes or releases. */
  onOriginalPipelineChange?: (pipeline: PreviewPipelineHandle | null) => void
  onRequestOriginalReferenceFallback?: () => void
}

export interface ProcessedPreview<
  TPipeline extends ProcessedPreviewPipeline,
> extends Pick<
  PreviewCompareReadiness,
  | 'showEmbeddedPreview'
  | 'embeddedHandoffPreviewVisible'
  | 'currentProcessedFrameReady'
  | 'shouldMountOriginalGpuLayer'
  | 'shouldDelayProcessedCompareRender'
> {
  /**
   * The publication port for the pipeline's lifetime owner: every published
   * or forgotten pipeline starts with no image and no frame.
   */
  publishPipeline: (pipeline: TPipeline | null) => void
  reportInitializationError: (error: unknown) => void
  /** The processed surface failure shown over the stage, if any. */
  error: string | null
  /** Whether the track holding the canvas has its aspect-fit size. */
  trackReady: boolean
  markTrackReady: () => void
  compareRenderMode: CompareRenderMode
  /** Draws the latest processed inputs, as after a backing store resize. */
  redraw: () => void
  /** Wiring for the original GPU layer that compare layers over the canvas. */
  originalGpuLayer: {
    generationKey: string
    onReady: (generationKey: string) => void
    onError: (error: unknown, generationKey: string) => void
    /**
     * The layer's pipeline publication port. A ready original belongs to
     * the pipeline that drew it, so publishing or releasing one forgets it.
     */
    onPipelineChange: (pipeline: PreviewPipelineHandle | null) => void
  }
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

/**
 * Owns processed preview rendering and its readiness: image and LUT upload,
 * one draw per processed input change, the first-frame GPU fence, the
 * retained frame and track across a quick to bounded-HQ handoff, and the
 * compare handoff with the original GPU layer.
 *
 * It does not own the pipeline's lifetime. It learns the current pipeline
 * only through `publishPipeline`, which the lifetime owner calls.
 *
 * A draw announces a ready frame only while its pipeline, request, and
 * accepted frame are all still current and the preview is not suspended, so
 * failed or superseded work never claims the surface. Only the output
 * selection reaches the pipeline: the original view redraws the technical
 * original, while compare, the split, and the viewport stay in CSS.
 */
export function useProcessedPreview<
  TPipeline extends ProcessedPreviewPipeline,
>({
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
  jpegSnapshotReady,
  onStatsUpdate,
  onPipelineChange,
  onOriginalPipelineChange,
  onRequestOriginalReferenceFallback,
}: ProcessedPreviewOptions<TPipeline>): ProcessedPreview<TPipeline> {
  const pipelineRef = useRef<TPipeline | null>(null)
  const [publishedPipeline, setPublishedPipeline] = useState<TPipeline | null>(
    null,
  )
  const suspendedRef = useRef(suspended)
  const processedUploadGenerationKeyRef = useRef('')
  const processedGenerationKeyRef = useRef('')
  const processedRenderRequestRef = useRef(0)
  const lutUploadFailedRef = useRef(false)
  const firstFrameWaitRef = useRef<{
    pipeline: TPipeline
    generationKey: string
    completion: Promise<void>
  } | null>(null)
  const processedFrameStatusRef = useRef<PreviewFrameStatus>(
    EMPTY_PREVIEW_FRAME_STATUS,
  )
  const renderProcessedPreviewRef = useRef<(() => Promise<boolean>) | null>(
    null,
  )
  const retainedTrackIdentityRef = useRef('')
  const [trackReady, setTrackReady] = useState(false)
  const [originalGpuStatus, setOriginalGpuStatus] = useState(
    EMPTY_ORIGINAL_GPU_FRAME_STATUS,
  )
  const [processedFrameStatus, setProcessedFrameStatus] =
    useState<PreviewFrameStatus>(EMPTY_PREVIEW_FRAME_STATUS)
  const [error, setError] = useState<string | null>(null)
  suspendedRef.current = suspended

  const image = imageRef.current
  const readiness = derivePreviewCompareReadiness({
    frame: decodedFrame,
    displaySource,
    hasImageData: Boolean(image?.data),
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
    showEmbeddedPreview,
    embeddedHandoffPreviewVisible,
    processedImageGenerationKey,
    currentProcessedFrameReady,
    originalGpuGenerationKey,
    originalGpuReady,
    originalGpuFailed,
    retainedProcessedFrameReady,
    compareFrameBridgeReady,
    embeddedPreviewFallbackReady,
    shouldMountOriginalGpuLayer,
    shouldDelayProcessedCompareRender,
  } = readiness
  processedGenerationKeyRef.current = processedImageGenerationKey
  // The track is fitted to one accepted frame.
  const processedTrackIdentity = processedImageGenerationKey

  useLayoutEffect(() => {
    const transition = derivePreviewTrackReadinessTransition({
      retainedTrackIdentity: retainedTrackIdentityRef.current,
      processedTrackIdentity,
      retainedProcessedFrameReady,
      handoffPreviewVisible: embeddedHandoffPreviewVisible,
    })

    retainedTrackIdentityRef.current = transition.nextRetainedTrackIdentity
    if (transition.resetTrackReady) {
      setTrackReady(false)
    }
  }, [
    processedTrackIdentity,
    retainedProcessedFrameReady,
    embeddedHandoffPreviewVisible,
  ])

  const compareRenderMode = selectCompareRenderMode({
    requestedViewMode: showEmbeddedPreview ? 'processed' : viewMode,
    supportsCssClip,
    dualGpuAllowed,
    originalGpuReady: originalGpuReady && currentProcessedFrameReady,
    retainedCompareFrameReady: compareFrameBridgeReady,
    originalGpuFailed,
    embeddedPreviewReady: embeddedPreviewFallbackReady,
    jpegSnapshotReady,
  })
  const stableColor = useStableColorIntent(color)
  const processedSurfaceOutput = previewSurfaceOutputForViewMode(viewMode)
  const processedCanvasParams = useMemo(
    () => ({ ...stableColor, output: processedSurfaceOutput }),
    [processedSurfaceOutput, stableColor],
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

  const publishPipeline = useCallback(
    (pipeline: TPipeline | null) => {
      pipelineRef.current = pipeline
      setPublishedPipeline(pipeline)
      processedUploadGenerationKeyRef.current = ''
      firstFrameWaitRef.current = null
      commitProcessedFrameStatus(EMPTY_PREVIEW_FRAME_STATUS)
      if (pipeline) setError(null)
      onPipelineChange?.(pipeline)
    },
    [commitProcessedFrameStatus, onPipelineChange],
  )

  const reportInitializationError = useCallback((err: unknown) => {
    setError(
      err instanceof Error ? err.message : 'GPU preview initialization failed',
    )
  }, [])

  const markTrackReady = useCallback(() => setTrackReady(true), [])

  const syncProcessedImageUpload = useCallback(() => {
    const pipeline = pipelineRef.current
    if (!pipeline || !publishedPipeline) return false
    if (
      processedUploadGenerationKeyRef.current === processedImageGenerationKey
    ) {
      return true
    }

    // Pixels without an accepted descriptor are never uploaded.
    const image = decodedFrame ? imageRef.current : null
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
  }, [decodedFrame, imageRef, processedImageGenerationKey, publishedPipeline])

  const renderProcessedPreview = useCallback(async () => {
    const pipeline = pipelineRef.current
    if (!pipeline || !publishedPipeline) return false
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
        frame: decodedFrame,
        state: 'ready',
      })
      // A current frame on screen ends any earlier draw failure.
      setError(null)
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
    decodedFrame,
    onStatsUpdate,
    processedCanvasParams,
    processedImageGenerationKey,
    publishedPipeline,
    syncProcessedImageUpload,
  ])

  useEffect(() => {
    renderProcessedPreviewRef.current = renderProcessedPreview
  }, [renderProcessedPreview])

  const redraw = useCallback(() => {
    void renderProcessedPreviewRef.current?.()
  }, [])

  // Upload image data when it changes
  useEffect(() => {
    syncProcessedImageUpload()
  }, [syncProcessedImageUpload])

  // Upload LUT when it changes
  useEffect(() => {
    const pipeline = pipelineRef.current
    if (!pipeline || !publishedPipeline) return
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
  }, [lutDataRef, lutDataVersion, publishedPipeline])

  // Draw once per processed input change: image, params, or LUT. It runs
  // after the LUT upload effect above, so a LUT-only version change renders
  // with the new LUT. While the retained compare pair holds a bounded-HQ
  // frame back, this effect stays the one draw owner: the original layer's
  // ready report lifts the delay, and the lifted delay draws. Compare mode
  // stays in CSS/DOM space, so the processed canvas never enters the legacy
  // single-canvas shader split path.
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

  const forgetOriginalGpuFrame = useCallback(
    (pipeline: PreviewPipelineHandle | null) => {
      // A failure stays recorded for its generation; only a drawn frame is
      // tied to the pipeline that drew it.
      setOriginalGpuStatus((current) =>
        current.state === 'failed' ? current : EMPTY_ORIGINAL_GPU_FRAME_STATUS,
      )
      onOriginalPipelineChange?.(pipeline)
    },
    [onOriginalPipelineChange],
  )

  return {
    showEmbeddedPreview,
    embeddedHandoffPreviewVisible,
    currentProcessedFrameReady,
    shouldMountOriginalGpuLayer,
    shouldDelayProcessedCompareRender,
    publishPipeline,
    reportInitializationError,
    error,
    trackReady,
    markTrackReady,
    compareRenderMode,
    redraw,
    originalGpuLayer: {
      generationKey: originalGpuGenerationKey,
      onReady: (readyGenerationKey) => {
        // Only the current generation's frame may become ready; late work
        // for another frame or compare policy publishes nothing. Reaching
        // the frame a retained compare pair waits for lifts the processed
        // delay, and the draw effect then draws the new image.
        if (readyGenerationKey !== originalGpuGenerationKey) return
        setOriginalGpuStatus({
          generationKey: readyGenerationKey,
          frame: decodedFrame,
          state: 'ready',
        })
      },
      onError: (_, failedGenerationKey) => {
        setOriginalGpuStatus({
          generationKey: failedGenerationKey,
          frame:
            failedGenerationKey === originalGpuGenerationKey
              ? decodedFrame
              : null,
          state: 'failed',
        })
        if (failedGenerationKey === originalGpuGenerationKey) {
          onRequestOriginalReferenceFallback?.()
        }
      },
      onPipelineChange: forgetOriginalGpuFrame,
    },
  }
}
