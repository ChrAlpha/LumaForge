import type { ProcessingParams } from '@lumaforge/luma-color-runtime'

import type { ExportRenderPlan } from '~/lib/gl/export'
import { createExportTiles } from '~/lib/gl/export'

import type { WebGPUImages } from './images'
import type { WebGPUPrograms } from './programs'
import { UNIFORM_BUFFER_SIZE } from './uniform-layout'
import { packUniforms } from './uniforms'

interface SnapshotInput {
  device: GPUDevice
  programs: WebGPUPrograms
  images: WebGPUImages
  params: ProcessingParams
  exposure: number
  width: number
  height: number
  plan: Exclude<ExportRenderPlan, { strategy: 'fail' }>
  assertReady: () => void
}

/** Snapshot the processed color intent into retained pixels, independent of
 * browser presentation/discard of the visible WebGPU canvas. */
export async function renderSnapshot(
  input: SnapshotInput,
): Promise<HTMLCanvasElement> {
  const {
    device,
    programs,
    images,
    params,
    exposure,
    width,
    height,
    plan,
    assertReady,
  } = input
  if (!images.processed || !images.inputUpload)
    throw new Error('EXPORT_SOURCE_MISSING')
  if (
    plan.strategy === 'tiled' &&
    (images.inputUpload.width !== width || images.inputUpload.height !== height)
  ) {
    throw new Error('EXPORT_TILED_REQUIRES_SOURCE_SIZE')
  }
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('EXPORT_CANVAS_CONTEXT_MISSING')
  const uniform = device.createBuffer({
    label: 'raw-snapshot-uniforms',
    size: UNIFORM_BUFFER_SIZE,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
  // Tiled readback yields between tiles, so preserve a private processed frame
  // while live edits continue. A single tile is copied before the first await.
  const retained =
    plan.strategy === 'tiled'
      ? device.createTexture({
          label: 'raw-snapshot-retained',
          size: [width, height],
          format: 'rgba16float',
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
        })
      : null
  const processed = retained ?? images.processed
  try {
    images.updateSelectiveColor(params.selectiveColor)
    const packed = new ArrayBuffer(UNIFORM_BUFFER_SIZE)
    packUniforms(
      new DataView(packed),
      { ...params, viewMode: 'processed', compareSplit: 0.5 },
      images.lutData,
      exposure,
      images.selectiveActive,
    )
    device.queue.writeBuffer(uniform, 0, packed)
    const uniforms = device.createBindGroup({
      layout: programs.uniformLayout,
      entries: [{ binding: 0, resource: { buffer: uniform } }],
    })
    const encoder = device.createCommandEncoder({
      label: 'raw-snapshot-process',
    })
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: processed.createView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: [0, 0, 0, 1],
        },
      ],
    })
    pass.setPipeline(
      images.inputUpload.layout === 'rgb-u16'
        ? programs.processU16
        : programs.processFloat,
    )
    pass.setBindGroup(0, uniforms)
    pass.setBindGroup(1, images.inputGroup!)
    pass.setBindGroup(2, images.lutGroup)
    pass.setBindGroup(3, images.selectiveGroup)
    pass.draw(3)
    pass.end()
    device.queue.submit([encoder.finish()])
    const tiles =
      plan.strategy === 'tiled'
        ? createExportTiles(plan)
        : [{ x: 0, y: 0, width, height }]
    for (const tile of tiles) {
      assertReady()
      const pixels = await readOutputTile(input, tile, processed)
      assertReady()
      context.putImageData(
        new ImageData(pixels, tile.width, tile.height),
        tile.x,
        tile.y,
      )
    }
    return canvas
  } finally {
    retained?.destroy()
    uniform.destroy()
  }
}

async function readOutputTile(
  input: SnapshotInput,
  tile: { x: number; y: number; width: number; height: number },
  processed: GPUTexture,
) {
  const { device, programs, images, plan } = input
  const { width, height } = tile
  const output = device.createTexture({
    label: 'raw-snapshot-rgba8',
    size: [width, height],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  })
  const bytesPerRow = Math.ceil((width * 4) / 256) * 256
  let buffer: GPUBuffer | null = null
  let crop: GPUTexture | null = null
  try {
    buffer = device.createBuffer({
      label: 'raw-snapshot-readback',
      size: bytesPerRow * height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    })
    const encoder = device.createCommandEncoder({
      label: 'raw-snapshot-output',
    })
    let source = images.outputGroup!
    if (plan.strategy === 'tiled') {
      crop = device.createTexture({
        label: 'raw-snapshot-tile',
        size: [width, height],
        format: 'rgba16float',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      })
      encoder.copyTextureToTexture(
        { texture: processed, origin: [tile.x, tile.y] },
        { texture: crop },
        [width, height],
      )
      source = images.outputGroupFor(crop.createView())
    }
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: output.createView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: [0, 0, 0, 1],
        },
      ],
    })
    pass.setPipeline(programs.snapshotOutput)
    pass.setBindGroup(0, source)
    pass.draw(3)
    pass.end()
    encoder.copyTextureToBuffer({ texture: output }, { buffer, bytesPerRow }, [
      width,
      height,
    ])
    device.queue.submit([encoder.finish()])
    await buffer.mapAsync(GPUMapMode.READ)
    const mapped = new Uint8Array(buffer.getMappedRange())
    const pixels = new Uint8ClampedArray(width * height * 4)
    for (let row = 0; row < height; row++)
      pixels.set(
        mapped.subarray(row * bytesPerRow, row * bytesPerRow + width * 4),
        row * width * 4,
      )
    return pixels
  } finally {
    if (buffer?.mapState === 'mapped') buffer.unmap()
    buffer?.destroy()
    crop?.destroy()
    output.destroy()
  }
}
