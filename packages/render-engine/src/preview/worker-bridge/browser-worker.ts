import { renderCpuPreviewFrame } from '../preview-render'
import type { CpuPreviewRequest, CpuPreviewResponse } from './protocol'

type SourceState = { width: number; height: number; data: Uint16Array }
const sources = new Map<string, SourceState>()

function reply(res: CpuPreviewResponse, transfer?: Transferable[]) {
  ;(self as unknown as Worker).postMessage(res, transfer ?? [])
}

self.onmessage = (e: MessageEvent<CpuPreviewRequest>) => {
  const msg = e.data
  if (msg.type === 'loadSource') {
    if (
      !(msg.data instanceof Uint16Array) ||
      msg.data.length !== msg.width * msg.height * 3
    ) {
      reply({
        type: 'error',
        sourceId: msg.sourceId,
        reason: 'invalid-source-buffer',
      })
      return
    }
    sources.set(msg.sourceId, {
      width: msg.width,
      height: msg.height,
      data: msg.data,
    })
    return
  }
  if (msg.type === 'disposeSource') {
    sources.delete(msg.sourceId)
    return
  }
  const src = sources.get(msg.sourceId)
  if (!src) {
    reply({
      type: 'error',
      sourceId: msg.sourceId,
      requestId: msg.requestId,
      reason: 'invalid-source-buffer',
    })
    return
  }
  try {
    const rgba = renderCpuPreviewFrame({
      data: src.data,
      width: src.width,
      height: src.height,
      graph: msg.graph,
      hdrView: msg.hdrView,
    })
    reply(
      {
        type: 'rendered',
        sourceId: msg.sourceId,
        requestId: msg.requestId,
        rgba,
        width: src.width,
        height: src.height,
      },
      [rgba.buffer],
    )
  } catch (error) {
    const reason =
      error instanceof RangeError ? 'out-of-memory' : 'render-failed'
    reply({
      type: 'error',
      sourceId: msg.sourceId,
      requestId: msg.requestId,
      reason,
    })
  }
}

export {}
