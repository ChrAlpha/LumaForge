import { useCallback, useEffect, useRef } from 'react'

import type { DecodedPreviewFrame } from '~/lib/preview/preview-frame'
import type { DecodedImage } from '~/lib/raw/decoder'
import type { RawProcessingPipeline } from '~/lib/webgpu/raw-processing-pipeline'
import { RawProcessingPipeline as DefaultRawProcessingPipeline } from '~/lib/webgpu/raw-processing-pipeline'
import { gpuPreviewInputParams } from '~/lib/webgpu/uniforms'

import {
  backingStoreSize,
  observeSettledBackingStore,
} from '../hooks/preview/backing-store-resize'
import type { PreviewPipelineHandle } from '../hooks/preview/usePreviewPipelineLifecycle'
import { usePreviewPipelineLifecycle } from '../hooks/preview/usePreviewPipelineLifecycle'
import { TECHNICAL_ORIGINAL_GPU_INPUT } from '../services/compare/original-reference-renderer'
import { createRawUploadInput } from './preview-canvas-helpers'

type OriginalPipeline = Pick<
  RawProcessingPipeline,
  | 'initialize'
  | 'uploadImage'
  | 'setParams'
  | 'render'
  | 'waitForGpu'
  | 'resize'
  | 'dispose'
> &
  Partial<Pick<RawProcessingPipeline, 'onDisposed' | 'getResourceStats'>>

const ORIGINAL_LAYER_PARAMS = gpuPreviewInputParams(
  TECHNICAL_ORIGINAL_GPU_INPUT,
)

function createDefaultOriginalPipeline(canvas: HTMLCanvasElement) {
  // A failed original layer demotes compare to the JPEG fallback; it must not
  // move the primary preview to the CPU executor.
  return new DefaultRawProcessingPipeline(canvas, { reportFailures: false })
}

/**
 * The technical original drawn on its own GPU pipeline under the processed
 * canvas. It draws only an accepted frame and reports readiness against the
 * generation key its owner derived from that frame; it never names a frame
 * itself.
 */
export function OriginalGpuLayer({
  imageRef,
  decodedFrame,
  generationKey,
  createPipeline = createDefaultOriginalPipeline,
  onReady,
  onError,
  onPipelineChange,
}: {
  imageRef: React.RefObject<DecodedImage | null>
  /** The accepted frame `imageRef` holds; null draws nothing. */
  decodedFrame: DecodedPreviewFrame | null
  /** Names the frame and the compare inputs this draw serves. */
  generationKey: string
  createPipeline?: (canvas: HTMLCanvasElement) => OriginalPipeline
  onReady?: (generationKey: string) => void
  onError?: (error: unknown, generationKey: string) => void
  /**
   * Hears the pipeline once it has initialized, before any ready report from
   * it, and `null` once it is released, before the failure that released it
   * is reported. A ready report never outlives its pipeline.
   */
  onPipelineChange?: (pipeline: PreviewPipelineHandle | null) => void
}) {
  const layerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const generationKeyRef = useRef(generationKey)
  const onReadyRef = useRef(onReady)
  const onErrorRef = useRef(onError)
  const onPipelineChangeRef = useRef(onPipelineChange)
  const hasDecodedFrame = decodedFrame !== null
  // A new accepted frame is drawn even if its owner kept the key.
  const frameSessionId = decodedFrame?.sessionId ?? null
  const frameId = decodedFrame?.frameId ?? null

  useEffect(() => {
    generationKeyRef.current = generationKey
    onReadyRef.current = onReady
    onErrorRef.current = onError
    onPipelineChangeRef.current = onPipelineChange
  }, [generationKey, onReady, onError, onPipelineChange])

  // The parent passes fresh callbacks on every render; only a new pipeline
  // factory rebuilds the layer's pipeline.
  const publishPipeline = useCallback(
    (
      _pipeline: OriginalPipeline | null,
      handle: PreviewPipelineHandle | null,
    ) => onPipelineChangeRef.current?.(handle),
    [],
  )
  const reportInitializationError = useCallback((error: unknown) => {
    onErrorRef.current?.(error, generationKeyRef.current)
  }, [])
  // A failed original layer releases its pipeline before it reports, so
  // compare can fall back without holding a dead GPU context.
  const {
    pipelineRef,
    isInitialized,
    release: releasePipeline,
  } = usePreviewPipelineLifecycle({
    canvasRef,
    createPipeline,
    publish: publishPipeline,
    onInitializationError: reportInitializationError,
    releaseOnInitializationFailure: true,
  })

  const reportPipelineError = useCallback(
    (error: unknown) => {
      releasePipeline({ releaseContext: true })
      onErrorRef.current?.(error, generationKey)
    },
    [generationKey, releasePipeline],
  )

  useEffect(() => {
    const layer = layerRef.current
    const canvas = canvasRef.current
    if (!layer || !canvas || typeof ResizeObserver === 'undefined') return

    // The layer fills the aspect-fitted track the processed canvas sizes, so
    // its box already is the photo box; fitting it to the photo again would
    // misalign the two layers.
    return observeSettledBackingStore(layer, canvas, {
      measure: (contentRect) => backingStoreSize(contentRect, 1),
      onApply: () => {
        try {
          pipelineRef.current?.resize(canvas.width, canvas.height)
          if (isInitialized && hasDecodedFrame && imageRef.current) {
            pipelineRef.current?.render()
          }
        } catch (error) {
          reportPipelineError(error)
        }
      },
    })
  }, [
    hasDecodedFrame,
    imageRef,
    isInitialized,
    pipelineRef,
    reportPipelineError,
  ])

  useEffect(() => {
    const canvas = canvasRef.current
    const pipeline = pipelineRef.current
    const image = imageRef.current
    if (!canvas || !pipeline || !isInitialized || !hasDecodedFrame || !image) {
      return
    }

    if (canvas.width <= 0 || canvas.height <= 0) {
      canvas.width = image.width
      canvas.height = image.height
      pipeline.resize(canvas.width, canvas.height)
    }

    const uploadInput = createRawUploadInput({
      data: image.data,
      layout: image.layout,
      colorSpace: image.colorSpace,
      width: image.width,
      height: image.height,
      renderExposureEv: image.renderExposure.ev,
    })
    if (!uploadInput) return

    let cancelled = false
    const isCurrent = () =>
      !cancelled &&
      pipelineRef.current === pipeline &&
      generationKeyRef.current === generationKey
    const renderOriginal = async () => {
      try {
        pipeline.uploadImage(uploadInput)
        pipeline.setParams(ORIGINAL_LAYER_PARAMS)
        pipeline.render()
        await pipeline.waitForGpu()
        if (isCurrent()) onReadyRef.current?.(generationKey)
      } catch (error) {
        if (isCurrent()) reportPipelineError(error)
      }
    }
    void renderOriginal()
    return () => {
      cancelled = true
    }
  }, [
    frameId,
    frameSessionId,
    generationKey,
    hasDecodedFrame,
    imageRef,
    isInitialized,
    pipelineRef,
    reportPipelineError,
  ])

  return (
    <div
      ref={layerRef}
      className="raw-preview-original-gpu-layer"
      aria-hidden="true"
    >
      <canvas ref={canvasRef} className="raw-preview-original-gpu-canvas" />
    </div>
  )
}
