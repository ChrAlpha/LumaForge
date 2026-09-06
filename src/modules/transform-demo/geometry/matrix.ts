import type { Matrix3, Point } from '~/modules/transform-demo/geometry/types'

export function identityMatrix(): Matrix3 {
  return [1, 0, 0, 0, 1, 0, 0, 0, 1]
}

export function multiplyMatrices(left: Matrix3, right: Matrix3): Matrix3 {
  return Array.from({ length: 9 }, (_, index) => {
    const row = Math.floor(index / 3) * 3
    const column = index % 3
    return (
      left[row] * right[column] +
      left[row + 1] * right[column + 3] +
      left[row + 2] * right[column + 6]
    )
  }) as unknown as Matrix3
}

export function invertMatrix(matrix: Matrix3): Matrix3 | null {
  const [a, b, c, d, e, f, g, h, i] = matrix
  const adjugate: Matrix3 = [
    e * i - f * h,
    c * h - b * i,
    b * f - c * e,
    f * g - d * i,
    a * i - c * g,
    c * d - a * f,
    d * h - e * g,
    b * g - a * h,
    a * e - b * d,
  ]
  const determinant = a * adjugate[0] + b * adjugate[3] + c * adjugate[6]
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-10)
    return null
  return adjugate.map((value) => value / determinant) as unknown as Matrix3
}

export function applyMatrix(matrix: Matrix3, point: Point): Point | null {
  const denominator = matrix[6] * point.x + matrix[7] * point.y + matrix[8]
  if (!Number.isFinite(denominator) || Math.abs(denominator) < 1e-8) return null
  const x =
    (matrix[0] * point.x + matrix[1] * point.y + matrix[2]) / denominator
  const y =
    (matrix[3] * point.x + matrix[4] * point.y + matrix[5]) / denominator
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null
}

export function rotationMatrix(degrees: number, aspectRatio = 1): Matrix3 {
  const radians = (degrees * Math.PI) / 180
  const cosine = Math.cos(radians)
  const sine = Math.sin(radians)
  const xShear = -sine / aspectRatio
  const yShear = sine * aspectRatio
  return [
    cosine,
    xShear,
    (1 - cosine - xShear) / 2,
    yShear,
    cosine,
    (1 - yShear - cosine) / 2,
    0,
    0,
    1,
  ]
}
