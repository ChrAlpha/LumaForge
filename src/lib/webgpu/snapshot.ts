import type { ProcessingParams } from '@lumaforge/luma-color-runtime'
import { LUT_SIZE } from '@lumaforge/luma-color-runtime'

import type { GPUReadbackScope } from './async-resources'
import type { RawUploadInput } from './contract'
import type { ExportRenderOptions, ExportRenderPlan } from './export-plan'
import {
  createExportTiles,
  cropRawUploadInput,
  planExportRenderTarget,
} from './export-plan'
import { WebGPUImages } from './images'
import type { WebGPUPrograms } from './programs'
import { UNIFORM_BUFFER_SIZE } from './uniform-layout'
import { packUniforms } from './uniforms'

export function planSnapshotRender({
  width,
  height,
  maxTextureSize,
  source,
  lutSize,
  exportOptions = {},
}: {
  width: number
  height: number
  maxTextureSize: number
  source: RawUploadInput
  lutSize: number
  exportOptions?: ExportRenderOptions
}): ExportRenderPlan {
  const plan = planExportRenderTarget({
    width,
    height,
    maxTextureSize,
    ...exportOptions,
  })
  if (plan.strategy === 'fail') return plan
  const budget = exportOptions.memoryBudgetBytes ?? 768 * 1024 * 1024
  const fullReadbackBytes =
    width * height * 4 +
    Math.ceil((width * 4) / 256) * 256 * height +
    UNIFORM_BUFFER_SIZE
  if (plan.strategy === 'full-frame' && fullReadbackBytes <= budget) return plan
  const fixedBytes =
    lutSize ** 3 * 16 + LUT_SIZE * 16 + 16 + UNIFORM_BUFFER_SIZE
  const inputBytesPerPixel = source.layout === 'rgb-u16' ? 8 : 16
  const renderBytesPerPixel = Math.max(
    inputBytesPerPixel + 16,
    exportOptions.renderBytesPerPixel ?? 32,
  )
  let side = Math.min(
    maxTextureSize,
    Math.floor(
      Math.sqrt(Math.max(0, budget - fixedBytes) / renderBytesPerPixel),
    ),
  )
  const bytes = (n: number) =>
    fixedBytes +
    n * n * (inputBytesPerPixel + 12) +
    Math.ceil((n * 4) / 256) * 256 * n
  while (side > 0 && bytes(side) > budget) side--
  if (side < 1)
    return {
      strategy: 'fail',
      width,
      height,
      reason: 'gpu-limit',
      retryable: false,
    }
  return {
    strategy: 'tiled',
    width,
    height,
    reason: plan.strategy === 'tiled' ? plan.reason : 'memory-budget',
    tileWidth: Math.min(width, side),
    tileHeight: Math.min(height, side),
  }
}

interface SnapshotInput {
  device: GPUDevice
  programs: WebGPUPrograms
  images: WebGPUImages
  params: ProcessingParams
  exposure: number
  width: number
  height: number
  plan: Exclude<ExportRenderPlan, { strategy: 'fail' }>
  scope: GPUReadbackScope
  assertReady: () => void
}

/** A full-frame readback submits its copy before yielding. Tiled jobs have
 * private, tile-sized source/process targets and a fixed copy of the look. */
export async function renderSnapshot(
  input: SnapshotInput,
): Promise<HTMLCanvasElement> {
  const {
    device,
    programs,
    images,
    exposure,
    width,
    height,
    plan,
    scope,
    assertReady,
  } = input
  const source = images.inputUpload
  if (!source) throw new Error('EXPORT_SOURCE_MISSING')
  if (
    plan.strategy === 'tiled' &&
    (source.width !== width || source.height !== height)
  )
    throw new Error('EXPORT_TILED_REQUIRES_SOURCE_SIZE')
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('EXPORT_CANVAS_CONTEXT_MISSING')
  const params = {
    ...structuredClone(input.params),
    viewMode: 'processed' as const,
    compareSplit: 0.5,
  }
  const uniform = scope.track(
    device.createBuffer({
      label: 'raw-snapshot-uniforms',
      size: UNIFORM_BUFFER_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    }),
    UNIFORM_BUFFER_SIZE,
  )
  let targets = images
  if (plan.strategy === 'tiled') {
    targets = new WebGPUImages(device, programs)
    scope.track(
      { destroy: () => targets.dispose() },
      () => targets.estimatedBytes,
    )
    if (images.lutData) targets.uploadLUT(images.lutData)
  }
  targets.updateSelectiveColor(params.selectiveColor)
  const packed = new ArrayBuffer(UNIFORM_BUFFER_SIZE)
  packUniforms(
    new DataView(packed),
    params,
    targets.lutData,
    exposure,
    targets.selectiveActive,
  )
  device.queue.writeBuffer(uniform, 0, packed)
  const uniforms = device.createBindGroup({
    layout: programs.uniformLayout,
    entries: [{ binding: 0, resource: { buffer: uniform } }],
  })
  const tiles =
    plan.strategy === 'tiled'
      ? createExportTiles(plan)
      : [{ x: 0, y: 0, width, height }]
  for (const tile of tiles) {
    assertReady()
    if (plan.strategy === 'tiled')
      targets.uploadImage(cropRawUploadInput(source, tile))
    const pixels = await readOutputTile(
      { ...input, images: targets },
      uniforms,
      tile,
    )
    assertReady()
    context.putImageData(
      new ImageData(pixels, tile.width, tile.height),
      tile.x,
      tile.y,
    )
  }
  return canvas
}

async function readOutputTile(
  input: SnapshotInput,
  uniforms: GPUBindGroup,
  tile: { width: number; height: number },
) {
  const { device, programs, images, scope } = input
  const { width, height } = tile
  const output = scope.track(
    device.createTexture({
      label: 'raw-snapshot-rgba8',
      size: [width, height],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    }),
    width * height * 4,
  )
  const bytesPerRow = Math.ceil((width * 4) / 256) * 256
  let buffer: GPUBuffer | null = null
  try {
    buffer = scope.track(
      device.createBuffer({
        label: 'raw-snapshot-readback',
        size: bytesPerRow * height,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      }),
      bytesPerRow * height,
    )
    const encoder = device.createCommandEncoder({ label: 'raw-snapshot' })
    const process = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: images.processedView!,
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: [0, 0, 0, 1],
        },
      ],
    })
    process.setPipeline(
      images.inputUpload?.layout === 'rgb-u16'
        ? programs.processU16
        : programs.processFloat,
    )
    process.setBindGroup(0, uniforms)
    process.setBindGroup(1, images.inputGroup!)
    process.setBindGroup(2, images.lutGroup)
    process.setBindGroup(3, images.selectiveGroup)
    process.draw(3)
    process.end()
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
    pass.setBindGroup(0, images.outputGroup!)
    pass.draw(3)
    pass.end()
    encoder.copyTextureToBuffer({ texture: output }, { buffer, bytesPerRow }, [
      width,
      height,
    ])
    device.queue.submit([encoder.finish()])
    await buffer.mapAsync(GPUMapMode.READ)
    scope.assertActive()
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
    scope.release(buffer)
    scope.release(output)
  }
}
