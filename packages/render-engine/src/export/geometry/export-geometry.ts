import type { LumaRawWindowRect } from '@lumaforge/luma-raw-runtime'

import type { Matrix3, Point } from './matrix'
import { applyMatrix, invertMatrix, isMatrix3 } from './matrix'

export const INVALID_EXPORT_GEOMETRY = 'FULL_RES_EXPORT_INVALID_GEOMETRY'

/**
 * Matte for output pixels with no source behind them, in output sRGB.
 *
 * Same triple the preview paints (`PREVIEW_MATTE`), so an unconstrained crop
 * exports the border the photographer was looking at.
 */
export const EXPORT_GEOMETRY_MATTE = [18, 20, 25] as const

/** Smallest fraction of the frame a constrained crop may retain. */
const MIN_RETAINED_SCALE = 0.08
const CHANNELS_PER_PIXEL = 3
const UINT16_MAX = 65535

/**
 * The geometry as it crosses a structured-clone boundary: a matrix in
 * source-normalized to output-normalized space plus the crop mode. Everything
 * else is derived, so the worker and the manifest agree by construction.
 */
export type ExportGeometry = {
  readonly matrix: readonly number[]
  readonly constrainCrop: boolean
}

export type PlannedExportGeometry = {
  readonly outputWidth: number
  readonly outputHeight: number
  /** Output-normalized to source-normalized. */
  readonly inverse: Matrix3
  /** Side length of the retained square, 1 when nothing was cropped away. */
  readonly scale: number
  readonly retainedArea: number
}

const UNIT_CORNERS: readonly Point[] = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
]

function invalidGeometry(): never {
  throw new Error(INVALID_EXPORT_GEOMETRY)
}

/**
 * Reject transforms whose projective horizon crosses the frame. When the
 * denominator changes sign across the unit square the mapping folds, and no
 * amount of cropping recovers a photograph from it.
 */
function checkedInverse(matrix: Matrix3): Matrix3 {
  const denominators = UNIT_CORNERS.map(
    ({ x, y }) => matrix[6] * x + matrix[7] * y + matrix[8],
  )
  const inverse = invertMatrix(matrix)
  if (
    !inverse ||
    matrix.some((value) => !Number.isFinite(value)) ||
    denominators.some(
      (value) =>
        Math.abs(value) < 1e-6 ||
        Math.sign(value) !== Math.sign(denominators[0]!),
    )
  ) {
    invalidGeometry()
  }

  return inverse
}

/**
 * Largest centred square of output that still lands entirely inside the source.
 *
 * Operates on the unit square, so the answer is resolution independent and the
 * full-resolution export frames exactly what the preview framed.
 */
function cropScale(inverse: Matrix3): number {
  const inside = (scale: number) =>
    UNIT_CORNERS.every((corner) => {
      const point = applyMatrix(inverse, {
        x: 0.5 + (corner.x - 0.5) * scale,
        y: 0.5 + (corner.y - 0.5) * scale,
      })
      return (
        point !== null &&
        point.x >= 0 &&
        point.x <= 1 &&
        point.y >= 0 &&
        point.y <= 1
      )
    })

  if (inside(1)) return 1
  if (!inside(0)) invalidGeometry()

  let low = 0
  let high = 1
  for (let step = 0; step < 32; step += 1) {
    const middle = (low + high) / 2
    if (inside(middle)) low = middle
    else high = middle
  }

  if (low < MIN_RETAINED_SCALE) invalidGeometry()
  return low
}

/**
 * Reject a mapping that folds inside the frame being produced.
 *
 * `checkedInverse` guards the forward denominator over the source square, but
 * sampling runs the inverse over the OUTPUT square, and that denominator can
 * still cross zero there. Past that horizon the preimage is a mirrored,
 * unbounded region: not a photograph, and a bounding box over it covers the
 * whole source, so the read stops being bounded too.
 */
function assertNoFoldInOutput(inverse: Matrix3, scale: number): void {
  const start = (1 - scale) / 2
  const end = start + scale
  const denominators = [
    [start, start],
    [end, start],
    [end, end],
    [start, end],
  ].map(([x, y]) => inverse[6] * x! + inverse[7] * y! + inverse[8])

  if (
    denominators.some(
      (value) =>
        !Number.isFinite(value) ||
        Math.abs(value) < 1e-6 ||
        Math.sign(value) !== Math.sign(denominators[0]!),
    )
  ) {
    invalidGeometry()
  }
}

export function planExportGeometry(
  geometry: ExportGeometry,
  source: { width: number; height: number },
): PlannedExportGeometry {
  if (!isMatrix3(geometry.matrix)) invalidGeometry()
  if (
    !Number.isSafeInteger(source.width) ||
    !Number.isSafeInteger(source.height) ||
    source.width <= 0 ||
    source.height <= 0
  ) {
    invalidGeometry()
  }

  const inverse = checkedInverse(geometry.matrix)
  const scale = geometry.constrainCrop ? cropScale(inverse) : 1
  assertNoFoldInOutput(inverse, scale)

  return {
    outputWidth: Math.max(1, Math.round(source.width * scale)),
    outputHeight: Math.max(1, Math.round(source.height * scale)),
    inverse,
    scale,
    retainedArea: scale * scale,
  }
}

/**
 * Output pixel centre in the normalized space the inverse matrix expects.
 *
 * The retained square is centred, so output normalized `u` covers
 * `[start, start + scale)` of the untransformed frame.
 */
function outputNormalized(
  index: number,
  extent: number,
  start: number,
  scale: number,
) {
  return start + ((index + 0.5) / extent) * scale
}

/**
 * Source rect an output rect can possibly sample from.
 *
 * A projective map sends the rect's edges to lines, so the four mapped corners
 * bound the preimage exactly. The halo covers the bilinear taps.
 */
export function preimageRect(
  planned: PlannedExportGeometry,
  outputRect: LumaRawWindowRect,
  source: { width: number; height: number },
  halo = 2,
): LumaRawWindowRect | null {
  const start = (1 - planned.scale) / 2
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  let mapped = 0

  // Corners of the output rect in pixel space, inclusive of its far edge.
  for (const corner of [
    { x: outputRect.x, y: outputRect.y },
    { x: outputRect.x + outputRect.width, y: outputRect.y },
    { x: outputRect.x + outputRect.width, y: outputRect.y + outputRect.height },
    { x: outputRect.x, y: outputRect.y + outputRect.height },
  ]) {
    const point = applyMatrix(planned.inverse, {
      x: outputNormalized(
        corner.x - 0.5,
        planned.outputWidth,
        start,
        planned.scale,
      ),
      y: outputNormalized(
        corner.y - 0.5,
        planned.outputHeight,
        start,
        planned.scale,
      ),
    })
    if (!point) continue
    mapped += 1
    const sx = point.x * source.width
    const sy = point.y * source.height
    minX = Math.min(minX, sx)
    minY = Math.min(minY, sy)
    maxX = Math.max(maxX, sx)
    maxY = Math.max(maxY, sy)
  }

  if (mapped === 0) return null

  const x0 = Math.max(0, Math.floor(minX) - halo)
  const y0 = Math.max(0, Math.floor(minY) - halo)
  const x1 = Math.min(source.width, Math.ceil(maxX) + halo)
  const y1 = Math.min(source.height, Math.ceil(maxY) + halo)

  // Entirely outside the source: the tile is pure matte, nothing to read.
  if (x1 <= x0 || y1 <= y0) return null

  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}

export type GeometryTile = {
  /** Output columns of the strip this tile covers. */
  readonly tileRect: LumaRawWindowRect
  /** Source to read for it; null when no source lies behind the tile. */
  readonly sourceRect: LumaRawWindowRect | null
}

/**
 * Split one output strip into tiles whose source windows fit a pixel budget.
 *
 * A fixed tile size is not enough. Magnification, rotation and shear compound,
 * and a preimage that reaches outside the frame clamps to the source bounds, so
 * the bounding box of a large skewed quad can cover the whole image even though
 * the quad barely touches it. Halving the tile shrinks the quad, so splitting
 * until the window fits keeps the read bounded however extreme the geometry is.
 *
 * The split follows the tile's longer output side: splitting columns alone
 * leaves a tile whose preimage spans every row still asking for every row.
 */
export function planGeometryTiles(input: {
  planned: PlannedExportGeometry
  stripRect: LumaRawWindowRect
  source: { width: number; height: number }
  maxWindowPixels: number
  minTileWidth: number
  /** Defaults to `minTileWidth`; the row axis stops splitting here. */
  minTileHeight?: number
  halo?: number
}): GeometryTile[] {
  const { planned, stripRect, source, maxWindowPixels, minTileWidth } = input
  const minTileHeight = input.minTileHeight ?? minTileWidth
  const halo = input.halo ?? 2
  const tiles: GeometryTile[] = []

  const visit = (x: number, y: number, width: number, height: number) => {
    if (width <= 0 || height <= 0) return
    const tileRect = { x, y, width, height }
    const sourceRect = preimageRect(planned, tileRect, source, halo)
    if (!sourceRect) {
      // Nothing behind it; the resampler leaves it uncovered for the matte.
      tiles.push({ tileRect, sourceRect: null })
      return
    }

    const pixels = sourceRect.width * sourceRect.height
    const canSplitWidth = width > minTileWidth
    const canSplitHeight = height > minTileHeight
    if (pixels <= maxWindowPixels || (!canSplitWidth && !canSplitHeight)) {
      tiles.push({ tileRect, sourceRect })
      return
    }

    if (canSplitWidth && (width >= height || !canSplitHeight)) {
      const left = Math.max(minTileWidth, Math.floor(width / 2))
      visit(x, y, left, height)
      visit(x + left, y, width - left, height)
      return
    }

    const top = Math.max(minTileHeight, Math.floor(height / 2))
    visit(x, y, width, top)
    visit(x, y + top, width, height - top)
  }

  visit(stripRect.x, stripRect.y, stripRect.width, stripRect.height)

  return tiles
}

export type GeometrySourceWindow = {
  /** Source rect the samples in `data` cover. */
  readonly rect: LumaRawWindowRect
  /** Linear ProPhoto RGB uint16, `rect.width * 3` samples per row. */
  readonly data: Uint16Array
}

export type GeometryResampleTarget = {
  /**
   * The strip `data` and `coverage` cover. `x` is 0 and `width` is the full
   * output width; tiles write into their own columns of it.
   */
  readonly stripRect: LumaRawWindowRect
  /** The tile being resampled; a column range of `stripRect`. */
  readonly tileRect: LumaRawWindowRect
  /** Linear ProPhoto RGB uint16, `stripRect.width * 3` samples per row. */
  readonly data: Uint16Array
  /** One byte per strip pixel; set to 1 where a source sample was found. */
  readonly coverage: Uint8Array
}

/**
 * Bilinear-resample one source window into its columns of the output strip.
 *
 * Samples in linear ProPhoto light, before the color graph, so edge pixels are
 * blended in the space where blending is physically meaningful. Output pixels
 * with no source behind them are left uncovered for the matte pass.
 */
export function resampleGeometryTile(input: {
  planned: PlannedExportGeometry
  source: { width: number; height: number }
  window: GeometrySourceWindow
  target: GeometryResampleTarget
}): void {
  const { planned, source, window, target } = input
  const start = (1 - planned.scale) / 2
  const [a, b, c, d, e, f, g, h, i] = planned.inverse
  const windowStride = window.rect.width * CHANNELS_PER_PIXEL
  const maxSampleX = window.rect.x + window.rect.width - 1
  const maxSampleY = window.rect.y + window.rect.height - 1
  const stripWidth = target.stripRect.width

  for (let row = 0; row < target.tileRect.height; row += 1) {
    const outputY = target.tileRect.y + row
    const stripRow = outputY - target.stripRect.y
    if (stripRow < 0 || stripRow >= target.stripRect.height) continue
    const py = outputNormalized(
      outputY,
      planned.outputHeight,
      start,
      planned.scale,
    )

    for (let column = 0; column < target.tileRect.width; column += 1) {
      const outputX = target.tileRect.x + column
      const stripColumn = outputX - target.stripRect.x
      if (stripColumn < 0 || stripColumn >= stripWidth) continue
      const px = outputNormalized(
        outputX,
        planned.outputWidth,
        start,
        planned.scale,
      )
      const denominator = g * px + h * py + i
      if (!Number.isFinite(denominator) || denominator === 0) continue

      // Source pixel centres sit at integer + 0.5, matching the preview.
      const sx = ((a * px + b * py + c) / denominator) * source.width - 0.5
      const sy = ((d * px + e * py + f) / denominator) * source.height - 0.5
      if (
        !Number.isFinite(sx) ||
        !Number.isFinite(sy) ||
        sx < -0.5 ||
        sx > source.width - 0.5 ||
        sy < -0.5 ||
        sy > source.height - 0.5
      ) {
        continue
      }

      // Clamp into the window actually held. The halo means this only bites at
      // the true source edge, where clamping is the right answer.
      const boundedX = Math.min(Math.max(sx, window.rect.x), maxSampleX)
      const boundedY = Math.min(Math.max(sy, window.rect.y), maxSampleY)
      const x0 = Math.floor(boundedX)
      const y0 = Math.floor(boundedY)
      const x1 = Math.min(maxSampleX, x0 + 1)
      const y1 = Math.min(maxSampleY, y0 + 1)
      const fx = boundedX - x0
      const fy = boundedY - y0

      const localX0 = (x0 - window.rect.x) * CHANNELS_PER_PIXEL
      const localX1 = (x1 - window.rect.x) * CHANNELS_PER_PIXEL
      const localRow0 = (y0 - window.rect.y) * windowStride
      const localRow1 = (y1 - window.rect.y) * windowStride
      const w00 = (1 - fx) * (1 - fy)
      const w10 = fx * (1 - fy)
      const w01 = (1 - fx) * fy
      const w11 = fx * fy

      const destination =
        (stripRow * stripWidth + stripColumn) * CHANNELS_PER_PIXEL
      for (let channel = 0; channel < CHANNELS_PER_PIXEL; channel += 1) {
        const value =
          (window.data[localRow0 + localX0 + channel] ?? 0) * w00 +
          (window.data[localRow0 + localX1 + channel] ?? 0) * w10 +
          (window.data[localRow1 + localX0 + channel] ?? 0) * w01 +
          (window.data[localRow1 + localX1 + channel] ?? 0) * w11
        target.data[destination + channel] = Math.max(
          0,
          Math.min(UINT16_MAX, Math.round(value)),
        )
      }
      target.coverage[stripRow * stripWidth + stripColumn] = 1
    }
  }
}

/** Paint the matte into every output pixel the resample left uncovered. */
export function applyGeometryMatte(input: {
  rgb8: Uint8Array
  coverage: Uint8Array
  pixelCount: number
  coverageOffset: number
}): void {
  const { rgb8, coverage, pixelCount, coverageOffset } = input
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    if (coverage[coverageOffset + pixel] === 1) continue
    const offset = pixel * CHANNELS_PER_PIXEL
    rgb8[offset] = EXPORT_GEOMETRY_MATTE[0]
    rgb8[offset + 1] = EXPORT_GEOMETRY_MATTE[1]
    rgb8[offset + 2] = EXPORT_GEOMETRY_MATTE[2]
  }
}
