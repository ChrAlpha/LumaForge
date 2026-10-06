import { NEUTRAL_USER_COLOR_INTENT } from '@lumaforge/luma-color-runtime'

import type { DecodedImage } from '~/lib/raw/decoder'
import type { GpuPreviewInput } from '~/lib/webgpu/contract'
import type { RawUploadInput } from '~/lib/webgpu/raw-processing-pipeline'
import { RawProcessingPipeline } from '~/lib/webgpu/raw-processing-pipeline'
import { gpuPreviewInputParams } from '~/lib/webgpu/uniforms'

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
export const TECHNICAL_ORIGINAL_GPU_INPUT: GpuPreviewInput = Object.freeze({
  color: Object.freeze({
    styleKind: 'none',
    builtinPreset: null,
    intensity: 0,
    ...NEUTRAL_USER_COLOR_INTENT,
  }),
  output: 'technical-original',
})

const ORIGINAL_REFERENCE_PARAMS = gpuPreviewInputParams(
  TECHNICAL_ORIGINAL_GPU_INPUT,
)

function fitWithinPixelCap(width: number, height: number, maxPixels: number) {
  const sourcePixels = Math.max(1, width * height)
  const scale = Math.min(1, Math.sqrt(Math.max(1, maxPixels) / sourcePixels))

  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  }
}

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

function resampleUint16(
  data: Uint16Array,
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
  channels: number,
) {
  if (sourceWidth === targetWidth && sourceHeight === targetHeight) {
    return data
  }

  const output = new Uint16Array(targetWidth * targetHeight * channels)
  for (let y = 0; y < targetHeight; y += 1) {
    const sourceY = Math.min(
      sourceHeight - 1,
      Math.floor(((y + 0.5) * sourceHeight) / targetHeight),
    )
    for (let x = 0; x < targetWidth; x += 1) {
      const sourceX = Math.min(
        sourceWidth - 1,
        Math.floor(((x + 0.5) * sourceWidth) / targetWidth),
      )
      const sourceOffset = (sourceY * sourceWidth + sourceX) * channels
      const outputOffset = (y * targetWidth + x) * channels
      for (let channel = 0; channel < channels; channel += 1) {
        output[outputOffset + channel] = data[sourceOffset + channel] ?? 0
      }
    }
  }

  return output
}

// Only the RGB16 linear ProPhoto render reaches the GPU; other layouts are refused.
function createSnapshotUploadInput(
  image: DecodedImage,
  target: { width: number; height: number },
): RawUploadInput {
  if (
    image.layout === 'rgb-u16' &&
    image.colorSpace === 'linear-prophoto-rgb' &&
    image.data instanceof Uint16Array
  ) {
    return {
      data: resampleUint16(
        image.data,
        image.width,
        image.height,
        target.width,
        target.height,
        3,
      ),
      width: target.width,
      height: target.height,
      layout: 'rgb-u16',
      colorSpace: 'linear-prophoto-rgb',
      renderExposureEv: image.renderExposure.ev,
      renderExposureMultiplier: image.renderExposure.multiplier,
    }
  }

  throw new Error('ORIGINAL_REFERENCE_SNAPSHOT_UNSUPPORTED_INPUT')
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
  const canvas = createCanvas()
  const target = fitWithinPixelCap(image.width, image.height, maxPixels)
  canvas.width = target.width
  canvas.height = target.height

  const pipeline = createPipeline(canvas)
  let disposed = false
  const disposePipeline = () => {
    if (disposed) return
    disposed = true
    pipeline.dispose({ releaseContext: true })
  }
  const handleAbort = () => {
    disposePipeline()
  }

  signal?.addEventListener('abort', handleAbort, { once: true })
  try {
    throwIfAborted(signal)
    await pipeline.initialize()
    throwIfAborted(signal)
    pipeline.uploadImage(createSnapshotUploadInput(image, target))
    pipeline.setParams(ORIGINAL_REFERENCE_PARAMS)
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
