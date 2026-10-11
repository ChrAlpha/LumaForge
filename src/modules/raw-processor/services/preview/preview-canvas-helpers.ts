// Shared adapters for the preview hooks and GPU layers. They hand decoded
// pixels to a GPU pipeline and capture pointers on DOM elements; they are not
// pure color or geometry math.

import type { DecodedImage } from '~/lib/raw/decoder'
import type {
  RawProcessingPipeline,
  RawUploadInput,
} from '~/lib/webgpu/raw-processing-pipeline'

export type RawUploadPipeline = Pick<
  RawProcessingPipeline,
  'clearImage' | 'uploadImage'
>

export type TrackedPointer = {
  clientX: number
  clientY: number
}

/**
 * The GPU draws only the RGB16 linear ProPhoto render. Any other decoded layout
 * yields null so the caller refuses it instead of uploading.
 */
export function createRawUploadInput({
  data,
  layout,
  colorSpace,
  width,
  height,
  renderExposureEv,
}: {
  data: DecodedImage['data'] | null
  layout: DecodedImage['layout'] | null
  colorSpace: DecodedImage['colorSpace'] | null
  width: number
  height: number
  renderExposureEv?: number | null
}): RawUploadInput | null {
  if (
    layout !== 'rgb-u16' ||
    colorSpace !== 'linear-prophoto-rgb' ||
    !(data instanceof Uint16Array)
  ) {
    return null
  }

  const ev =
    typeof renderExposureEv === 'number' && Number.isFinite(renderExposureEv)
      ? renderExposureEv
      : 0

  return {
    data,
    width,
    height,
    layout,
    colorSpace,
    renderExposureEv: ev,
    renderExposureMultiplier: Math.pow(2, ev),
  }
}

export function getPointerDistance(a: TrackedPointer, b: TrackedPointer) {
  return Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY)
}

export function getPointerMidpoint(a: TrackedPointer, b: TrackedPointer) {
  return {
    clientX: (a.clientX + b.clientX) / 2,
    clientY: (a.clientY + b.clientY) / 2,
  }
}

export function tryCapturePointer(target: HTMLElement, pointerId: number) {
  try {
    target.setPointerCapture?.(pointerId)
  } catch {
    // Pointer capture is best-effort for synthetic events and WebKit edge paths.
  }
}

export function tryReleasePointer(target: HTMLElement, pointerId: number) {
  try {
    target.releasePointerCapture?.(pointerId)
  } catch {
    // Internal pointer tracking is authoritative if release is unavailable.
  }
}

export function syncRawUploadInput({
  pipeline,
  imageData,
  uploadInput,
  setError,
}: {
  pipeline: RawUploadPipeline
  imageData: Float32Array | Uint16Array | null
  uploadInput: RawUploadInput | null
  setError: (error: string | null) => void
}): boolean {
  if (!imageData) {
    pipeline.clearImage()
    setError(null)
    return false
  }

  if (!uploadInput) {
    pipeline.clearImage()
    setError('Decoded image data does not match the GPU upload layout')
    return false
  }

  pipeline.uploadImage(uploadInput)
  setError(null)
  return true
}
