import { describe, expect, it } from 'vitest'

import {
  applyMatrix,
  identityMatrix,
  invertMatrix,
  multiplyMatrices,
  rotationMatrix,
} from '~/modules/transform-demo/geometry/matrix'
import type { Matrix3 } from '~/modules/transform-demo/geometry/types'

describe('normalized projective transforms', () => {
  it('composes and inverts a projective transform', () => {
    const matrix: Matrix3 = [1.1, 0.1, -0.02, 0.02, 0.95, 0.03, 0.2, -0.1, 1]
    const inverse = invertMatrix(matrix)
    expect(inverse).not.toBeNull()
    const product = multiplyMatrices(inverse!, matrix)
    for (const [index, value] of identityMatrix().entries()) {
      expect(product[index]).toBeCloseTo(value, 10)
    }
    const point = { x: 0.18, y: 0.92 }
    const restored = applyMatrix(inverse!, applyMatrix(matrix, point)!)!
    expect(restored.x).toBeCloseTo(point.x, 10)
    expect(restored.y).toBeCloseTo(point.y, 10)
  })

  it('rotates physical pixels around the frame center on a wide image', () => {
    const center = applyMatrix(rotationMatrix(90, 2), { x: 0.5, y: 0.5 })!
    const point = applyMatrix(rotationMatrix(90, 2), { x: 0.75, y: 0.5 })!
    expect(center.x).toBeCloseTo(0.5)
    expect(center.y).toBeCloseTo(0.5)
    expect(point.x).toBeCloseTo(0.5)
    expect(point.y).toBeCloseTo(1)
  })

  it('rejects singular matrices and projective poles', () => {
    expect(invertMatrix([0, 0, 0, 0, 0, 0, 0, 0, 0])).toBeNull()
    expect(
      applyMatrix([1, 0, 0, 0, 1, 0, 1, 0, -0.5], { x: 0.5, y: 0.5 }),
    ).toBeNull()
  })
})
