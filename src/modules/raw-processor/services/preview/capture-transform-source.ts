import type { ColorGraphIntentSource } from '@lumaforge/luma-color-runtime'
import { colorGraphIntentSignature } from '@lumaforge/luma-color-runtime'
import type { CpuPreviewFrame } from '@lumaforge/render-engine/preview'

import type { DecodedPreviewFrame } from '~/lib/preview/preview-frame'
import { previewDimensions } from '~/lib/transform/preview-dimensions'
import type { PreviewSource } from '~/lib/transform/preview-types'
import type { RawProcessingPipeline } from '~/lib/webgpu/raw-processing-pipeline'

/**
 * The decoded frame a Transform frame is drawn from, named by the identity
 * the workflow minted when it accepted the frame. Two descriptors of one
 * accepted frame name the same source; nothing here is rebuilt from sizes,
 * exposure or counters. No accepted frame names no source.
 */
export function decodedFrameIdentity(frame: DecodedPreviewFrame | null) {
  return JSON.stringify(frame ? [frame.sessionId, frame.frameId] : null)
}

/**
 * What a processed Transform frame is drawn from: the accepted decoded frame,
 * the LUT and the color intent with its continuous strength. The intent is
 * keyed the way the color graph reads it, so view state, key order or a
 * missing HSL record never ask for a new frame, and any color change does.
 */
export function transformInputKey(
  frame: DecodedPreviewFrame | null,
  lutVersion: number,
  color: ColorGraphIntentSource,
) {
  return JSON.stringify([
    decodedFrameIdentity(frame),
    lutVersion,
    colorGraphIntentSignature(color),
  ])
}

export async function captureTransformSource({
  width,
  height,
  name,
  pipeline,
  cpuFrame,
}: {
  width: number
  height: number
  name: string
  pipeline?: Pick<RawProcessingPipeline, 'renderToHiddenCanvas'> | null
  cpuFrame?: CpuPreviewFrame | null
}): Promise<PreviewSource> {
  const target = previewDimensions(
    cpuFrame?.width ?? width,
    cpuFrame?.height ?? height,
  )
  let canvas: HTMLCanvasElement
  if (cpuFrame) {
    const input = document.createElement('canvas')
    input.width = cpuFrame.width
    input.height = cpuFrame.height
    const context = input.getContext('2d')
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
    const output = canvas.getContext('2d')
    if (!output) throw new Error('transform-source-unavailable')
    output.drawImage(input, 0, 0, target.width, target.height)
  } else if (pipeline) {
    canvas = await pipeline.renderToHiddenCanvas(target)
  } else throw new Error('transform-source-unavailable')
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (
    !context ||
    canvas.width !== target.width ||
    canvas.height !== target.height
  )
    throw new Error('transform-source-unavailable')
  return {
    name,
    kind: 'raw',
    originalWidth: width,
    originalHeight: height,
    frame: {
      ...target,
      data: context.getImageData(0, 0, target.width, target.height).data,
    },
  }
}
