import type { ColorGraphIntent } from '@lumaforge/luma-color-runtime'
import { LUT_SIZE } from '@lumaforge/luma-color-runtime'

import type { GPUReadbackScope } from './async-resources'
import type { RawUploadInput } from './contract'
import { WebGPUImages } from './images'
import type { WebGPUPrograms } from './programs'
import { UNIFORM_BUFFER_SIZE } from './uniform-layout'
import { gpuPreviewInputParams, packUniforms } from './uniforms'

export type SnapshotPlan =
  | { strategy: 'full-frame'; width: number; height: number }
  | {
      strategy: 'tiled'
      width: number
      height: number
      tileWidth: number
      tileHeight: number
      reason: 'texture-limit' | 'memory-budget'
    }
  | {
      strategy: 'fail'
      width: number
      height: number
      reason: 'canvas-limit' | 'gpu-limit'
    }

interface SnapshotTile {
  x: number
  y: number
  width: number
  height: number
}

const MAX_CANVAS_SIZE = 16_384
const MAX_CANVAS_PIXELS = 120_000_000
const DEFAULT_BUDGET_BYTES = 768 * 1024 * 1024
const RENDER_BYTES_PER_PIXEL = 32
// RGBA16 uint source texel; WebGPU has no three-channel 16-bit format.
const INPUT_BYTES_PER_PIXEL = 8
const MIN_TILE_SIZE = 256

function readbackBytes(width: number, height: number): number {
  return Math.ceil((width * 4) / 256) * 256 * height
}

/**
 * Plans the HQ preview snapshot: one full-frame readback when the GPU texture
 * limit and the memory budget hold it, otherwise square tiles whose source,
 * process and readback targets plus the LUT stay inside the budget.
 */
export function planSnapshotRender({
  width,
  height,
  maxTextureSize,
  lutSize,
  budgetBytes = DEFAULT_BUDGET_BYTES,
}: {
  width: number
  height: number
  maxTextureSize: number
  lutSize: number
  budgetBytes?: number
}): SnapshotPlan {
  const pixels = width * height
  if (
    !(width > 0 && height > 0) ||
    width > MAX_CANVAS_SIZE ||
    height > MAX_CANVAS_SIZE ||
    pixels > MAX_CANVAS_PIXELS
  )
    return { strategy: 'fail', width, height, reason: 'canvas-limit' }
  const gpuLimit = {
    strategy: 'fail',
    width,
    height,
    reason: 'gpu-limit',
  } as const
  if (!Number.isFinite(maxTextureSize) || maxTextureSize < MIN_TILE_SIZE)
    return gpuLimit
  const fitsTexture = width <= maxTextureSize && height <= maxTextureSize
  const fullFrameFits =
    fitsTexture && pixels * RENDER_BYTES_PER_PIXEL <= budgetBytes
  if (
    fullFrameFits &&
    pixels * 4 + readbackBytes(width, height) + UNIFORM_BUFFER_SIZE <=
      budgetBytes
  )
    return { strategy: 'full-frame', width, height }
  // A frame too large for one render needs tiles of at least MIN_TILE_SIZE.
  if (
    !fullFrameFits &&
    Math.sqrt(budgetBytes / RENDER_BYTES_PER_PIXEL) < MIN_TILE_SIZE
  )
    return gpuLimit
  const fixedBytes =
    lutSize ** 3 * 16 + LUT_SIZE * 16 + 16 + UNIFORM_BUFFER_SIZE
  const tileBytes = (side: number) =>
    fixedBytes +
    side * side * (INPUT_BYTES_PER_PIXEL + 12) +
    readbackBytes(side, side)
  let side = Math.min(
    maxTextureSize,
    Math.floor(
      Math.sqrt(Math.max(0, budgetBytes - fixedBytes) / RENDER_BYTES_PER_PIXEL),
    ),
  )
  while (side > 0 && tileBytes(side) > budgetBytes) side--
  if (side < 1) return gpuLimit
  return {
    strategy: 'tiled',
    width,
    height,
    reason: fitsTexture ? 'memory-budget' : 'texture-limit',
    tileWidth: Math.min(width, side),
    tileHeight: Math.min(height, side),
  }
}

export function snapshotTiles({
  width,
  height,
  tileWidth,
  tileHeight,
}: Extract<SnapshotPlan, { strategy: 'tiled' }>): SnapshotTile[] {
  const tiles: SnapshotTile[] = []
  for (let y = 0; y < height; y += tileHeight) {
    for (let x = 0; x < width; x += tileWidth) {
      tiles.push({
        x,
        y,
        width: Math.min(tileWidth, width - x),
        height: Math.min(tileHeight, height - y),
      })
    }
  }
  return tiles
}

export function cropSnapshotSource(
  input: RawUploadInput,
  tile: SnapshotTile,
): RawUploadInput {
  const data = new Uint16Array(tile.width * tile.height * 3)
  const rowLength = tile.width * 3
  for (let row = 0; row < tile.height; row++) {
    const offset = ((tile.y + row) * input.width + tile.x) * 3
    data.set(input.data.subarray(offset, offset + rowLength), row * rowLength)
  }
  return { ...input, width: tile.width, height: tile.height, data }
}

interface SnapshotInput {
  device: GPUDevice
  programs: WebGPUPrograms
  images: WebGPUImages
  /** The look the export reproduces; the snapshot always draws it processed. */
  color: ColorGraphIntent
  exposure: number
  width: number
  height: number
  plan: Exclude<SnapshotPlan, { strategy: 'fail' }>
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
  // The tiles arrive as CPU pixels and every reader takes them back out on
  // the CPU (getImageData, toBlob), so the canvas stays in CPU memory: a
  // GPU-backed one would upload each tile and stall on a readback per read.
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('EXPORT_CANVAS_CONTEXT_MISSING')
  const params = gpuPreviewInputParams({
    color: structuredClone(input.color),
    output: 'processed',
  })
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
      ? snapshotTiles(plan)
      : [{ x: 0, y: 0, width, height }]
  for (const tile of tiles) {
    assertReady()
    if (plan.strategy === 'tiled')
      targets.uploadImage(cropSnapshotSource(source, tile))
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
    process.setPipeline(programs.processU16)
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
