export interface PreviewFrame {
  width: number
  height: number
  data: Uint8ClampedArray
}

export interface PreviewSource {
  frame: PreviewFrame
  name: string
  kind: 'image' | 'raw' | 'sample'
  originalWidth: number
  originalHeight: number
}

export const MAX_PREVIEW_EDGE = 1600
export const MAX_IMAGE_BYTES = 64 * 1024 * 1024
export const MAX_RAW_BYTES = 160 * 1024 * 1024

export type ImageInputErrorCode = 'unsupported' | 'too-large' | 'decode'

export class ImageInputError extends Error {
  constructor(readonly code: ImageInputErrorCode) {
    super(code)
    this.name = 'ImageInputError'
  }
}
