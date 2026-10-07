import type { Matrix3 } from '@lumaforge/render-engine/geometry'

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
