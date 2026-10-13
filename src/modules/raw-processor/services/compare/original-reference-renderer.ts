import { NEUTRAL_USER_COLOR_INTENT } from '@lumaforge/luma-color-runtime'

import type { DecodedImage } from '~/lib/raw/decoder'
import { RawProcessingPipeline } from '~/lib/webgpu/raw-processing-pipeline'
import type { GpuPreviewParams } from '~/lib/webgpu/uniforms'

import { sampleRgb16Frame } from '../preview/bounded-rgb16-frame'
import type { OriginalReferenceSnapshot } from './original-reference-snapshot'

type PipelineLike = Pick<
  RawProcessingPipeline,
  | 'initialize'
  | 'uploadImage'
  | 'setParams'
  | 'render'
  | 'waitForGpu'
  | 'dispose'
>

export type RenderOriginalReferenceSnapshotInput = {
  image: DecodedImage
  key: string
  maxPixels: number
  signal?: AbortSignal
  createCanvas?: () => HTMLCanvasElement
  createPipeline?: (canvas: HTMLCanvasElement) => PipelineLike
  createObjectURL?: (blob: Blob) => string
  revokeObjectURL?: (url: string) => void
}

/**
 * The technical original every original surface draws: the RAW render with its
 * exposure, no look and neutral user color. The upload carries the exposure;
 * the input sets every color field so none falls back to a pipeline default.
 */
export const TECHNICAL_ORIGINAL_GPU_INPUT: GpuPreviewParams = Object.freeze({
  styleKind: 'none',
  builtinPreset: null,
  intensity: 0,
  ...NEUTRAL_USER_COLOR_INTENT,
  output: 'technical-original',
})

function canvasToJpegBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error('ORIGINAL_REFERENCE_SNAPSHOT_ENCODE_FAILED'))
          return
        }
        resolve(blob)
      },
      'image/jpeg',
      0.92,
    )
  })
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new Error('ORIGINAL_REFERENCE_SNAPSHOT_ABORTED')
  }
}

export async function renderOriginalReferenceSnapshot({
  image,
  key,
  maxPixels,
  signal,
  createCanvas = () => document.createElement('canvas'),
  createPipeline = (canvas) =>
    new RawProcessingPipeline(canvas, { reportFailures: false }),
  createObjectURL = URL.createObjectURL.bind(URL),
}: RenderOriginalReferenceSnapshotInput): Promise<OriginalReferenceSnapshot> {
  // Only the RGB16 linear ProPhoto render reaches the GPU; other layouts are
  // refused before any pipeline exists.
  const target = sampleRgb16Frame(image, maxPixels)
  if (!target) throw new Error('ORIGINAL_REFERENCE_SNAPSHOT_UNSUPPORTED_INPUT')
  const canvas = createCanvas()
  canvas.width = target.width
  canvas.height = target.height

  const pipeline = createPipeline(canvas)
  let disposed = false
  const disposePipeline = () => {
    if (disposed) return
    disposed = true
    pipeline.dispose()
  }
  const handleAbort = () => {
    disposePipeline()
  }

  signal?.addEventListener('abort', handleAbort, { once: true })
  try {
    throwIfAborted(signal)
    await pipeline.initialize()
    throwIfAborted(signal)
    pipeline.uploadImage({
      ...target,
      layout: 'rgb-u16',
      colorSpace: 'linear-prophoto-rgb',
      renderExposureEv: image.renderExposure.ev,
      renderExposureMultiplier: image.renderExposure.multiplier,
    })
    pipeline.setParams(TECHNICAL_ORIGINAL_GPU_INPUT)
    pipeline.render()
    await pipeline.waitForGpu()
    throwIfAborted(signal)

    const blob = await canvasToJpegBlob(canvas)
    throwIfAborted(signal)
    return {
      key,
      objectUrl: createObjectURL(blob),
      width: target.width,
      height: target.height,
      source: image.source === 'bounded-hq' ? 'bounded-hq' : 'quick',
      mimeType: 'image/jpeg',
      estimatedBytes: blob.size,
    }
  } finally {
    signal?.removeEventListener('abort', handleAbort)
    disposePipeline()
  }
}
