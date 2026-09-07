/**
 * Minimal 3x3 projective helpers for the export geometry stage.
 *
 * These mirror `src/modules/transform-demo/geometry/matrix.ts` deliberately:
 * the engine cannot import from the app, and the export must reproduce the
 * framing the preview showed. Keep the two in step — the framing-parity test in
 * `export-geometry.test.ts` is what holds them together.
 */
export type Matrix3 = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
]

export type Point = { x: number; y: number }

export function isMatrix3(value: unknown): value is Matrix3 {
  return (
    Array.isArray(value) &&
    value.length === 9 &&
    value.every((entry) => typeof entry === 'number' && Number.isFinite(entry))
  )
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
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-10) {
    return null
  }

  return adjugate.map((value) => value / determinant) as unknown as Matrix3
}

export function applyMatrix(matrix: Matrix3, point: Point): Point | null {
  const denominator = matrix[6] * point.x + matrix[7] * point.y + matrix[8]
  if (!Number.isFinite(denominator) || Math.abs(denominator) < 1e-8) {
    return null
  }

  const x =
    (matrix[0] * point.x + matrix[1] * point.y + matrix[2]) / denominator
  const y =
    (matrix[3] * point.x + matrix[4] * point.y + matrix[5]) / denominator
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null
}
