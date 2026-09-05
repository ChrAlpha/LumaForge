// Candidate render worker: one JPEG WASM runtime per thread, rendering the
// shared decoded frame with per-candidate color graphs. Every step mirrors
// the inline path in `services/candidate-pool.ts` so outputs stay
// byte-identical regardless of concurrency.

import { parentPort, workerData } from 'node:worker_threads'

import { createLumaJpegRuntimeForNode } from '@lumaforge/luma-jpeg-runtime/node'
import {
  encodePreviewFrameToJpeg,
  renderCpuPreviewFrame,
} from '@lumaforge/render-engine/preview'

import type {
  CandidateWorkerData,
  CandidateWorkerRequest,
  CandidateWorkerResponse,
} from '../services/candidate-pool'
import { finishCandidate } from '../services/candidate-pool'

const port = parentPort
if (!port) {
  throw new Error('candidate-worker must run inside a worker thread')
}

const data = workerData as CandidateWorkerData
const frameData = new Uint16Array(data.frame.buffer)

function post(response: CandidateWorkerResponse, transfer: ArrayBuffer[] = []) {
  port!.postMessage(response, transfer)
}

async function main() {
  const jpeg = await createLumaJpegRuntimeForNode()
  let chain: Promise<void> = Promise.resolve()

  port!.on('message', (request: CandidateWorkerRequest) => {
    if (request.type === 'close') {
      chain = chain.finally(() => {
        jpeg.dispose()
        port!.close()
      })
      return
    }
    chain = chain.then(async () => {
      try {
        const rgba = renderCpuPreviewFrame({
          data: frameData,
          width: data.frame.width,
          height: data.frame.height,
          graph: request.graph,
        })
        const bytes = (await encodePreviewFrameToJpeg(
          (options) => jpeg.createEncoder(options),
          {
            rgba,
            width: data.frame.width,
            height: data.frame.height,
            quality: request.quality,
          },
        )) as Uint8Array
        const output = finishCandidate({
          index: request.index,
          width: data.frame.width,
          height: data.frame.height,
          rgba,
          jpeg: bytes,
          tile: data.tile,
        })
        post(
          {
            type: 'done',
            index: output.index,
            width: output.width,
            height: output.height,
            jpeg: output.jpeg,
            sha256: output.sha256,
            metrics: output.metrics,
            tile: output.tile,
          },
          [
            output.jpeg.buffer as ArrayBuffer,
            output.tile.rgba.buffer as ArrayBuffer,
          ],
        )
      } catch (error) {
        post({
          type: 'error',
          index: request.index,
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        })
      }
    })
  })
  post({ type: 'ready' })
}

main().catch((error: unknown) => {
  post({
    type: 'error',
    index: null,
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  })
})
