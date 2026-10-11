// HQ preview snapshot planning: full-frame vs tiled readback of the GPU
// preview. The authoritative full-resolution export does not use this module.
import type { PerformancePreference } from '@lumaforge/render-engine/policy'

import type { RawUploadInput } from './contract'

export type ExportRenderPlan =
  | {
      strategy: 'full-frame'
      width: number
      height: number
    }
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
      retryable: boolean
    }

export interface ExportRenderPlanInput {
  width: number
  height: number
  maxTextureSize: number
  maxCanvasSize?: number
  maxCanvasPixels?: number
  memoryBudgetBytes?: number
  renderBytesPerPixel?: number
}

export type ExportRenderOptions = Omit<
  ExportRenderPlanInput,
  'width' | 'height' | 'maxTextureSize'
>

export type ExportRenderErrorCode =
  | 'EXPORT_CANVAS_LIMIT_EXCEEDED'
  | 'EXPORT_GPU_LIMIT_EXCEEDED'

export type ExportRenderFailureReason = Extract<
  ExportRenderPlan,
  { strategy: 'fail' }
>['reason']

export interface ExportTile {
  x: number
  y: number
  width: number
  height: number
}

const DEFAULT_MAX_CANVAS_SIZE = 16_384
const DEFAULT_MAX_CANVAS_PIXELS = 120_000_000
const DEFAULT_MEMORY_BUDGET_BYTES = 768 * 1024 * 1024
const DEFAULT_RENDER_BYTES_PER_PIXEL = 32
const MIN_TILE_SIZE = 256

const EXPORT_OPTIONS_BY_PREFERENCE: Record<
  PerformancePreference,
  Required<ExportRenderOptions>
> = {
  safe: {
    maxCanvasSize: 8192,
    maxCanvasPixels: 50_000_000,
    memoryBudgetBytes: 256 * 1024 * 1024,
    renderBytesPerPixel: DEFAULT_RENDER_BYTES_PER_PIXEL,
  },
  balanced: {
    maxCanvasSize: 12000,
    maxCanvasPixels: 80_000_000,
    memoryBudgetBytes: 512 * 1024 * 1024,
    renderBytesPerPixel: DEFAULT_RENDER_BYTES_PER_PIXEL,
  },
  max: {
    maxCanvasSize: DEFAULT_MAX_CANVAS_SIZE,
    maxCanvasPixels: DEFAULT_MAX_CANVAS_PIXELS,
    memoryBudgetBytes: DEFAULT_MEMORY_BUDGET_BYTES,
    renderBytesPerPixel: DEFAULT_RENDER_BYTES_PER_PIXEL,
  },
}

export class ExportRenderError extends Error {
  readonly code: ExportRenderErrorCode
  readonly retryable: boolean
  readonly reason: ExportRenderFailureReason
  readonly width: number
  readonly height: number

  constructor(
    code: ExportRenderErrorCode,
    {
      retryable,
      reason,
      width,
      height,
    }: {
      retryable: boolean
      reason: ExportRenderFailureReason
      width: number
      height: number
    },
  ) {
    super(code)
    this.name = 'ExportRenderError'
    this.code = code
    this.retryable = retryable
    this.reason = reason
    this.width = width
    this.height = height
  }

  static fromFailedPlan(
    plan: Extract<ExportRenderPlan, { strategy: 'fail' }>,
  ): ExportRenderError {
    return new ExportRenderError(
      plan.reason === 'canvas-limit'
        ? 'EXPORT_CANVAS_LIMIT_EXCEEDED'
        : 'EXPORT_GPU_LIMIT_EXCEEDED',
      {
        retryable: plan.retryable,
        reason: plan.reason,
        width: plan.width,
        height: plan.height,
      },
    )
  }
}

export function getExportRenderOptionsForPreference(
  preference: PerformancePreference,
): Required<ExportRenderOptions> {
  return { ...EXPORT_OPTIONS_BY_PREFERENCE[preference] }
}

export function planExportRenderTarget({
  width,
  height,
  maxTextureSize,
  maxCanvasSize = DEFAULT_MAX_CANVAS_SIZE,
  maxCanvasPixels = DEFAULT_MAX_CANVAS_PIXELS,
  memoryBudgetBytes = DEFAULT_MEMORY_BUDGET_BYTES,
  renderBytesPerPixel = DEFAULT_RENDER_BYTES_PER_PIXEL,
}: ExportRenderPlanInput): ExportRenderPlan {
  const pixels = width * height

  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0 ||
    width > maxCanvasSize ||
    height > maxCanvasSize ||
    pixels > maxCanvasPixels
  ) {
    return {
      strategy: 'fail',
      width,
      height,
      reason: 'canvas-limit',
      retryable: true,
    }
  }

  if (!Number.isFinite(maxTextureSize) || maxTextureSize < MIN_TILE_SIZE) {
    return {
      strategy: 'fail',
      width,
      height,
      reason: 'gpu-limit',
      retryable: false,
    }
  }

  const fullFrameBytes = pixels * renderBytesPerPixel
  if (
    width <= maxTextureSize &&
    height <= maxTextureSize &&
    fullFrameBytes <= memoryBudgetBytes
  ) {
    return {
      strategy: 'full-frame',
      width,
      height,
    }
  }

  const memoryTileSize = Math.floor(
    Math.sqrt(memoryBudgetBytes / renderBytesPerPixel),
  )
  const tileSize = Math.min(maxTextureSize, memoryTileSize)

  if (tileSize < MIN_TILE_SIZE) {
    return {
      strategy: 'fail',
      width,
      height,
      reason: 'gpu-limit',
      retryable: false,
    }
  }

  return {
    strategy: 'tiled',
    width,
    height,
    tileWidth: Math.min(width, tileSize),
    tileHeight: Math.min(height, tileSize),
    reason:
      width > maxTextureSize || height > maxTextureSize
        ? 'texture-limit'
        : 'memory-budget',
  }
}

export function createExportTiles({
  width,
  height,
  tileWidth,
  tileHeight,
}: {
  width: number
  height: number
  tileWidth: number
  tileHeight: number
}): ExportTile[] {
  const tiles: ExportTile[] = []

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

export function cropRawUploadInput(
  input: RawUploadInput,
  tile: ExportTile,
): RawUploadInput {
  if (
    tile.x < 0 ||
    tile.y < 0 ||
    tile.width <= 0 ||
    tile.height <= 0 ||
    tile.x + tile.width > input.width ||
    tile.y + tile.height > input.height
  ) {
    throw new Error('EXPORT_TILE_OUT_OF_BOUNDS')
  }

  return {
    ...input,
    width: tile.width,
    height: tile.height,
    data: cropRgb16Rows(input.data, input.width, tile),
  }
}

function cropRgb16Rows(
  source: Uint16Array,
  sourceWidth: number,
  tile: ExportTile,
): Uint16Array {
  const result = new Uint16Array(tile.width * tile.height * 3)
  const rowLength = tile.width * 3

  for (let row = 0; row < tile.height; row++) {
    const sourceOffset = ((tile.y + row) * sourceWidth + tile.x) * 3
    result.set(
      source.subarray(sourceOffset, sourceOffset + rowLength),
      row * rowLength,
    )
  }

  return result
}
