import type { ProcessingParams } from '@lumaforge/luma-color-runtime'

import type { DecodedImage } from '~/lib/raw/decoder'
import type { RawUploadInput } from '~/lib/webgpu/raw-processing-pipeline'
import { RawProcessingPipeline } from '~/lib/webgpu/raw-processing-pipeline'

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

const ORIGINAL_REFERENCE_PARAMS: ProcessingParams = {
  viewMode: 'original',
  compareSplit: 0.5,
  intensity: 0,
  styleKind: 'none',
  builtinPreset: null,
  userExposureEv: 0,
  userContrast: 0,
  userHighlights: 0,
  userShadows: 0,
  userWhites: 0,
  userBlacks: 0,
  userTemperature: 0,
  userTint: 0,
  userSaturation: 0,
  userVibrance: 0,
}

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

function resampleFloat32(
  data: Float32Array,
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
  channels: number,
) {
  if (sourceWidth === targetWidth && sourceHeight === targetHeight) {
    return data
  }

  const output = new Float32Array(targetWidth * targetHeight * channels)
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

  if (
    image.layout === 'rgba-float32' &&
    image.colorSpace === 'display-srgb-preview' &&
    image.data instanceof Float32Array
  ) {
    return {
      data: resampleFloat32(
        image.data,
        image.width,
        image.height,
        target.width,
        target.height,
        4,
      ),
      width: target.width,
      height: target.height,
      layout: 'rgba-float32',
      colorSpace: 'display-srgb-preview',
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
    pipeline.render({ waitForGpu: false })
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
