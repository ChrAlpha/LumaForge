import type { Matrix3, UprightAnalysis } from './geometry/types'
import type { PreviewFrame } from './preview-types'
import type { RenderedPreview } from './transform-types'

export type TransformWorkerRequest =
  | { type: 'clear'; sourceId: number }
  | { type: 'analyze'; sourceId: number; frame: PreviewFrame }
  | {
      type: 'render'
      sourceId: number
      requestId: number
      matrix: Matrix3
      constrainCrop: boolean
    }

export type TransformWorkerResponse =
  | {
      type: 'analyzed'
      sourceId: number
      analysis: UprightAnalysis
      elapsedMs: number
    }
  | {
      type: 'rendered'
      sourceId: number
      requestId: number
      result: RenderedPreview
    }
  | { type: 'error'; sourceId: number; requestId?: number; message: string }
