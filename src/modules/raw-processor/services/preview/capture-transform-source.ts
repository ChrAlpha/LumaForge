import type { ProcessingParams } from '@lumaforge/luma-color-runtime'
import type { CpuPreviewFrame } from '@lumaforge/render-engine/preview'

import type { RawProcessingPipeline } from '~/lib/gl/pipeline'
import { previewDimensions } from '~/modules/transform-demo/image-input'
import type { PreviewSource } from '~/modules/transform-demo/preview-types'

export function transformInputKey(
  imageVersion: number,
  lutVersion: number,
  params: ProcessingParams,
) {
  const { viewMode: _view, compareSplit: _split, ...color } = params
  return JSON.stringify([imageVersion, lutVersion, color])
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
