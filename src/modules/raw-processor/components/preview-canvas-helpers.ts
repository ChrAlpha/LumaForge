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

export function createRawUploadInput({
  data,
  layout,
  colorSpace,
  width,
  height,
  renderExposureEv,
}: {
  data: Float32Array | Uint16Array | null
  layout: RawUploadInput['layout'] | null
  colorSpace: RawUploadInput['colorSpace'] | null
  width: number
  height: number
  renderExposureEv?: number | null
}): RawUploadInput | null {
  if (!data || !layout || !colorSpace) {
    return null
  }

  if (layout === 'rgb-u16') {
    if (data instanceof Uint16Array && colorSpace === 'linear-prophoto-rgb') {
      const ev =
        typeof renderExposureEv === 'number' &&
        Number.isFinite(renderExposureEv)
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

    return null
  }

  if (data instanceof Float32Array && colorSpace === 'display-srgb-preview') {
    return {
      data,
      width,
      height,
      layout,
      colorSpace,
    }
  }

  return null
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
    setError('Decoded image data does not match the WebGL upload layout')
    return false
  }

  pipeline.uploadImage(uploadInput)
  setError(null)
  return true
}
