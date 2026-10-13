export interface PreviewFrame {
  width: number
  height: number
  data: Uint8ClampedArray
}

export interface PreviewSource {
  frame: PreviewFrame
}

export const MAX_PREVIEW_EDGE = 1600

export type ImageInputErrorCode = 'decode'

export class ImageInputError extends Error {
  constructor(readonly code: ImageInputErrorCode) {
    super(code)
    this.name = 'ImageInputError'
  }
}
