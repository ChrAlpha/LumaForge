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

/** The GPU upload of a decoded frame, with the frame's RAW render exposure. */
export function createRawUploadInput(image: DecodedImage): RawUploadInput {
  const { ev } = image.renderExposure
  const renderExposureEv = Number.isFinite(ev) ? ev : 0
  return {
    data: image.data,
    width: image.width,
    height: image.height,
    layout: 'rgb-u16',
    colorSpace: 'linear-prophoto-rgb',
    renderExposureEv,
    renderExposureMultiplier: Math.pow(2, renderExposureEv),
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

/** Uploads the frame, or clears the pipeline's stale input without one. */
export function syncRawUploadInput(
  pipeline: RawUploadPipeline,
  image: DecodedImage | null,
): boolean {
  if (!image) {
    pipeline.clearImage()
    return false
  }
  pipeline.uploadImage(createRawUploadInput(image))
  return true
}
