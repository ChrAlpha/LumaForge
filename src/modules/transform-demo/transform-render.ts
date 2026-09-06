import {
  applyMatrix,
  invertMatrix,
  multiplyMatrices,
  rotationMatrix,
} from './geometry/matrix'
import type { Matrix3, Point } from './geometry/types'
import type { PreviewFrame } from './preview-types'
import type { ManualTransform, RenderedPreview } from './transform-types'
import { PREVIEW_MATTE } from './transform-types'

const CORNERS: Point[] = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
]

export function composeManualTransform(
  base: Matrix3,
  manual: ManualTransform,
  aspectRatio: number,
): Matrix3 {
  const center: Matrix3 = [1, 0, -0.5, 0, 1, -0.5, 0, 0, 1]
  const perspective: Matrix3 = [
    1,
    0,
    0,
    0,
    1,
    0,
    manual.horizontal / 100,
    manual.vertical / 100,
    1,
  ]
  const scale = manual.scale / 100
  const restore: Matrix3 = [
    scale * (1 + manual.aspect / 100),
    0,
    0.5 + manual.offsetX / 100,
    0,
    scale,
    0.5 + manual.offsetY / 100,
    0,
    0,
    1,
  ]
  const adjustment = multiplyMatrices(
    restore,
    multiplyMatrices(perspective, center),
  )
  return multiplyMatrices(
    adjustment,
    multiplyMatrices(rotationMatrix(manual.rotate, aspectRatio), base),
  )
}

function checkedInverse(matrix: Matrix3): Matrix3 {
  const inverse = invertMatrix(matrix)
  const denominators = CORNERS.map(
    ({ x, y }) => matrix[6] * x + matrix[7] * y + matrix[8],
  )
  if (
    !inverse ||
    matrix.some((value) => !Number.isFinite(value)) ||
    denominators.some(
      (value) =>
        Math.abs(value) < 1e-6 ||
        Math.sign(value) !== Math.sign(denominators[0]),
    )
  ) {
    throw new Error('invalid-transform')
  }
  return inverse
}

function cropScale(inverse: Matrix3): number {
  const inside = (scale: number) =>
    CORNERS.every((corner) => {
      const point = applyMatrix(inverse, {
        x: 0.5 + (corner.x - 0.5) * scale,
        y: 0.5 + (corner.y - 0.5) * scale,
      })
      return (
        point && point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1
      )
    })
  if (inside(1)) return 1
  if (!inside(0)) throw new Error('invalid-transform')
  let low = 0
  let high = 1
  for (let i = 0; i < 32; i++) {
    const middle = (low + high) / 2
    if (inside(middle)) low = middle
    else high = middle
  }
  if (low < 0.08) throw new Error('invalid-transform')
  return low
}

export function renderTransformedPreview(
  source: PreviewFrame,
  matrix: Matrix3,
  constrainCrop: boolean,
): RenderedPreview {
  const inverse = checkedInverse(matrix)
  if (
    source.width < 1 ||
    source.height < 1 ||
    source.data.length !== source.width * source.height * 4
  ) {
    throw new Error('invalid-image')
  }
  const scale = constrainCrop ? cropScale(inverse) : 1
  const width = Math.max(1, Math.round(source.width * scale))
  const height = Math.max(1, Math.round(source.height * scale))
  const data = new Uint8ClampedArray(width * height * 4)
  const [a, b, c, d, e, f, g, h, i] = inverse
  const start = (1 - scale) / 2
  const outputToWorld: Matrix3 = [scale, 0, start, 0, scale, start, 0, 0, 1]
  const worldToOutput = invertMatrix(outputToWorld)!

  for (let y = 0; y < height; y++) {
    const py = start + ((y + 0.5) / height) * scale
    for (let x = 0; x < width; x++) {
      const px = start + ((x + 0.5) / width) * scale
      const denominator = g * px + h * py + i
      const sx = ((a * px + b * py + c) / denominator) * source.width - 0.5
      const sy = ((d * px + e * py + f) / denominator) * source.height - 0.5
      const dest = (y * width + x) * 4
      data[dest + 3] = 255
      if (
        !Number.isFinite(sx) ||
        !Number.isFinite(sy) ||
        sx < -0.5 ||
        sx > source.width - 0.5 ||
        sy < -0.5 ||
        sy > source.height - 0.5
      ) {
        data.set(PREVIEW_MATTE, dest)
        continue
      }
      const boundedX = Math.max(0, Math.min(source.width - 1, sx))
      const boundedY = Math.max(0, Math.min(source.height - 1, sy))
      const x0 = Math.floor(boundedX)
      const y0 = Math.floor(boundedY)
      const x1 = Math.min(source.width - 1, x0 + 1)
      const y1 = Math.min(source.height - 1, y0 + 1)
      const fx = boundedX - x0
      const fy = boundedY - y0
      const offsets = [
        (y0 * source.width + x0) * 4,
        (y0 * source.width + x1) * 4,
        (y1 * source.width + x0) * 4,
        (y1 * source.width + x1) * 4,
      ]
      const weights = [
        (1 - fx) * (1 - fy),
        fx * (1 - fy),
        (1 - fx) * fy,
        fx * fy,
      ]
      for (let channel = 0; channel < 3; channel++) {
        let value = 0
        for (let sample = 0; sample < 4; sample++) {
          const alpha = source.data[offsets[sample] + 3] / 255
          value +=
            weights[sample] *
            (source.data[offsets[sample] + channel] * alpha +
              PREVIEW_MATTE[channel] * (1 - alpha))
        }
        data[dest + channel] = value
      }
    }
  }
  return {
    frame: { width, height, data },
    displayMatrix: multiplyMatrices(worldToOutput, matrix),
    retainedArea: scale * scale,
  }
}
