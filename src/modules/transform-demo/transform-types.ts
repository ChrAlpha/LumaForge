import type { Matrix3 } from './geometry/types'
import type { PreviewFrame } from './preview-types'

export interface ManualTransform {
  vertical: number
  horizontal: number
  rotate: number
  aspect: number
  scale: number
  offsetX: number
  offsetY: number
}

export const NEUTRAL_TRANSFORM: ManualTransform = {
  vertical: 0,
  horizontal: 0,
  rotate: 0,
  aspect: 0,
  scale: 100,
  offsetX: 0,
  offsetY: 0,
}

export interface RenderedPreview {
  frame: PreviewFrame
  displayMatrix: Matrix3
  retainedArea: number
}

export const PREVIEW_MATTE = [18, 20, 25] as const
