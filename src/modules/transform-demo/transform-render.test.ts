import { describe, expect, it } from 'vitest'

import { applyMatrix, identityMatrix, rotationMatrix } from './geometry/matrix'
import {
  composeManualTransform,
  renderTransformedPreview,
} from './transform-render'
import { NEUTRAL_TRANSFORM, PREVIEW_MATTE } from './transform-types'

function frame(width = 100, height = 80) {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data.set([80 + x, 90 + y, 180, 255], (y * width + x) * 4)
    }
  }
  return { width, height, data }
}

describe('transform preview resampling', () => {
  it('preserves every opaque pixel and dimensions at identity', () => {
    const input = frame()
    const rendered = renderTransformedPreview(input, identityMatrix(), false)
    expect(rendered.frame).toEqual(input)
    expect(rendered.retainedArea).toBe(1)
  })

  it('uses inverse mapping and rotates a square by ninety degrees', () => {
    const input = frame(80, 80)
    const rendered = renderTransformedPreview(input, rotationMatrix(90), false)
    expect(Array.from(rendered.frame.data.slice(0, 4))).toEqual([
      80, 169, 180, 255,
    ])
  })

  it('crops tilted blank corners while preserving the image aspect', () => {
    const input = frame()
    const matrix = rotationMatrix(12, input.width / input.height)
    const uncropped = renderTransformedPreview(input, matrix, false)
    expect(Array.from(uncropped.frame.data.slice(0, 3))).toEqual(PREVIEW_MATTE)
    const cropped = renderTransformedPreview(input, matrix, true)
    expect(cropped.frame.width).toBeLessThan(input.width)
    expect(cropped.frame.width / cropped.frame.height).toBeCloseTo(1.25, 1)
    expect(cropped.retainedArea).toBeLessThan(1)
    for (let i = 0; i < cropped.frame.data.length; i += 4) {
      expect(cropped.frame.data[i]).toBeGreaterThanOrEqual(80)
      expect(cropped.frame.data[i + 3]).toBe(255)
    }
  })

  it('composes offsets and physical rotation without moving the neutral center', () => {
    const neutral = composeManualTransform(
      identityMatrix(),
      NEUTRAL_TRANSFORM,
      1.5,
    )
    expect(applyMatrix(neutral, { x: 0.5, y: 0.5 })).toEqual({ x: 0.5, y: 0.5 })
    const shifted = composeManualTransform(
      identityMatrix(),
      { ...NEUTRAL_TRANSFORM, offsetX: 10 },
      1.5,
    )
    expect(applyMatrix(shifted, { x: 0.5, y: 0.5 })?.x).toBeCloseTo(0.6)
  })

  it('rejects a singular transform and a projective horizon through the image', () => {
    expect(() =>
      renderTransformedPreview(frame(), [0, 0, 0, 0, 0, 0, 0, 0, 1], true),
    ).toThrow('invalid-transform')
    expect(() =>
      renderTransformedPreview(frame(), [1, 0, 0, 0, 1, 0, 0, 2, -1], true),
    ).toThrow('invalid-transform')
  })
})
