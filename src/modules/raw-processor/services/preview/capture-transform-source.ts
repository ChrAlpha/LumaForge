import type { ColorGraphIntent } from '@lumaforge/luma-color-runtime'
import { colorGraphIntentSignature } from '@lumaforge/luma-color-runtime'
import type { CpuPreviewFrame } from '@lumaforge/render-engine/preview'

import type { DecodedPreviewFrame } from '~/lib/preview/preview-frame'
import { decodedPreviewFrameKey } from '~/lib/preview/preview-frame'
import { previewDimensions } from '~/lib/transform/preview-dimensions'
import type { PreviewSource } from '~/lib/transform/preview-types'
import type { RawProcessingPipeline } from '~/lib/webgpu/raw-processing-pipeline'

/**
 * What a processed Transform frame is drawn from: the accepted decoded frame,
 * the LUT and the color intent with its continuous strength. The intent is
 * keyed the way the color graph reads it, so view state, key order or a
 * neutral HSL record spelled out afresh never ask for a new frame, and any
 * color change does.
 */
export function transformInputKey(
  frame: DecodedPreviewFrame | null,
  lutVersion: number,
  color: ColorGraphIntent,
) {
  return JSON.stringify([
    decodedPreviewFrameKey(frame),
    lutVersion,
    colorGraphIntentSignature(color),
  ])
}

export async function captureTransformSource({
  width,
  height,
  pipeline,
  cpuFrame,
}: {
  width: number
  height: number
  pipeline?: Pick<RawProcessingPipeline, 'renderToHiddenCanvas'> | null
  cpuFrame?: CpuPreviewFrame | null
}): Promise<PreviewSource> {
  const target = previewDimensions(
    cpuFrame?.width ?? width,
    cpuFrame?.height ?? height,
  )
  // A CPU frame already at the Transform edge is the frame itself.
  if (
    cpuFrame &&
    cpuFrame.width === target.width &&
    cpuFrame.height === target.height
  ) {
    return {
      frame: { ...target, data: new Uint8ClampedArray(cpuFrame.rgba) },
    }
  }
  // Every canvas here is read back with getImageData, so each is created
  // CPU-backed; a GPU-backed one stalls the main thread on the readback.
  const readable: CanvasRenderingContext2DSettings = {
    willReadFrequently: true,
  }
  let canvas: HTMLCanvasElement
  if (cpuFrame) {
    const input = document.createElement('canvas')
    input.width = cpuFrame.width
    input.height = cpuFrame.height
    const context = input.getContext('2d', readable)
    if (!context) throw new Error('transform-source-unavailable')
    context.putImageData(
      new ImageData(
        new Uint8ClampedArray(cpuFrame.rgba),
        input.width,
        input.height,
      ),
      0,
      0,
    )
    canvas = document.createElement('canvas')
    canvas.width = target.width
    canvas.height = target.height
    const output = canvas.getContext('2d', readable)
    if (!output) throw new Error('transform-source-unavailable')
    output.drawImage(input, 0, 0, target.width, target.height)
  } else if (pipeline) {
    canvas = await pipeline.renderToHiddenCanvas(target)
  } else throw new Error('transform-source-unavailable')
  const context = canvas.getContext('2d', readable)
  if (
    !context ||
    canvas.width !== target.width ||
    canvas.height !== target.height
  )
    throw new Error('transform-source-unavailable')
  return {
    frame: {
      ...target,
      data: context.getImageData(0, 0, target.width, target.height).data,
    },
  }
}
