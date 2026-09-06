import { analyzeUpright } from './geometry/upright'
import type { PreviewFrame } from './preview-types'
import { renderTransformedPreview } from './transform-render'
import type {
  TransformWorkerRequest,
  TransformWorkerResponse,
} from './worker-protocol'

let source: PreviewFrame | null = null
let sourceId = 0

self.onmessage = ({ data }: MessageEvent<TransformWorkerRequest>) => {
  try {
    if (data.type === 'clear') {
      source = null
      sourceId = data.sourceId
    } else if (data.type === 'analyze') {
      source = data.frame
      sourceId = data.sourceId
      const start = performance.now()
      const analysis = analyzeUpright(source)
      self.postMessage({
        type: 'analyzed',
        sourceId,
        analysis,
        elapsedMs: performance.now() - start,
      } satisfies TransformWorkerResponse)
    } else if (source && sourceId === data.sourceId) {
      const result = renderTransformedPreview(
        source,
        data.matrix,
        data.constrainCrop,
      )
      self.postMessage(
        {
          type: 'rendered',
          sourceId,
          requestId: data.requestId,
          result,
        } satisfies TransformWorkerResponse,
        { transfer: [result.frame.data.buffer] },
      )
    }
  } catch (error) {
    self.postMessage({
      type: 'error',
      sourceId: data.sourceId,
      requestId: data.type === 'render' ? data.requestId : undefined,
      message: error instanceof Error ? error.message : 'processing-failed',
    } satisfies TransformWorkerResponse)
  }
}
