import { describe, expect, it } from 'vitest'

import {
  applyMatrix,
  identityMatrix,
  multiplyMatrices,
  rotationMatrix,
} from '~/modules/transform-demo/geometry/matrix'
import type {
  AnalysisImage,
  Matrix3,
  Point,
} from '~/modules/transform-demo/geometry/types'
import { analyzeUpright } from '~/modules/transform-demo/geometry/upright'

const width = 360
const height = 280
const center: Matrix3 = [
  1,
  0,
  -0.5,
  0,
  height / width,
  -height / width / 2,
  0,
  0,
  1,
]
const uncenter: Matrix3 = [1, 0, 0.5, 0, width / height, 0.5, 0, 0, 1]

function centered(matrix: Matrix3): Matrix3 {
  return multiplyMatrices(uncenter, multiplyMatrices(matrix, center))
}

function rasterize(
  matrix: Matrix3,
  kind: 'building' | 'diagonal' | 'stems' = 'building',
  withOutliers = false,
): AnalysisImage {
  const data = new Uint8ClampedArray(width * height * 4).fill(230)
  const lines: [Point, Point][] = []
  for (let index = 0; index < 7; index++) {
    const coordinate = 0.14 + index * 0.12
    if (kind === 'building') {
      lines.push([
        { x: coordinate, y: 0.12 },
        { x: coordinate, y: 0.88 },
      ])
      lines.push([
        { x: 0.12, y: coordinate },
        { x: 0.88, y: coordinate },
      ])
    } else if (kind === 'diagonal') {
      lines.push([
        { x: coordinate - 0.3, y: 0.1 },
        { x: coordinate + 0.3, y: 0.87 },
      ])
    }
  }
  if (kind === 'stems') {
    for (const coordinate of [0.12, 0.82, 0.86]) {
      lines.push([
        { x: coordinate, y: 0.38 },
        { x: coordinate + 0.06, y: 0.86 },
      ])
    }
  }
  if (withOutliers) {
    lines.push([
      { x: 0.06, y: 0.1 },
      { x: 0.9, y: 0.56 },
    ])
    lines.push([
      { x: 0.12, y: 0.86 },
      { x: 0.9, y: 0.58 },
    ])
    lines.push([
      { x: 0.07, y: 0.16 },
      { x: 0.35, y: 0.95 },
    ])
  }
  for (const [first, last] of lines) {
    const start = applyMatrix(matrix, first)!
    const end = applyMatrix(matrix, last)!
    const dx = (end.x - start.x) * width
    const dy = (end.y - start.y) * height
    const steps = Math.ceil(Math.hypot(dx, dy) * 3)
    for (let step = 0; step <= steps; step++) {
      const x = Math.round(start.x * width + (dx * step) / steps)
      const y = Math.round(start.y * height + (dy * step) / steps)
      for (let iy = y - 1; iy <= y + 1; iy++) {
        for (let ix = x - 1; ix <= x + 1; ix++) {
          if (ix < 0 || iy < 0 || ix >= width || iy >= height) continue
          const offset = (iy * width + ix) * 4
          data[offset] = 30
          data[offset + 1] = 35
          data[offset + 2] = 40
        }
      }
    }
  }
  for (let index = 3; index < data.length; index += 4) data[index] = 255
  return { data, width, height }
}

function residual(
  matrix: Matrix3,
  distortion: Matrix3,
  kind: 'vertical' | 'horizontal',
): number {
  const combined = multiplyMatrices(matrix, distortion)
  let worst = 0
  for (const coordinate of [0.16, 0.38, 0.62, 0.84]) {
    const start = applyMatrix(
      combined,
      kind === 'vertical'
        ? { x: coordinate, y: 0.15 }
        : { x: 0.15, y: coordinate },
    )!
    const end = applyMatrix(
      combined,
      kind === 'vertical'
        ? { x: coordinate, y: 0.85 }
        : { x: 0.85, y: coordinate },
    )!
    const dx = (end.x - start.x) * width
    const dy = (end.y - start.y) * height
    const error =
      kind === 'vertical'
        ? Math.atan2(Math.abs(dx), Math.abs(dy))
        : Math.atan2(Math.abs(dy), Math.abs(dx))
    worst = Math.max(worst, (error * 180) / Math.PI)
  }
  return worst
}

describe('image-based Upright analysis', () => {
  it('leaves a blank frame and diagonal-only texture unchanged', () => {
    const blank = {
      data: new Uint8ClampedArray(width * height * 4).fill(255),
      width,
      height,
    }
    for (const image of [blank, rasterize(identityMatrix(), 'diagonal')]) {
      const analysis = analyzeUpright(image)
      expect(analysis.solutions.auto.status).toBe('insufficient')
      expect(analysis.solutions.auto.matrix).toEqual(identityMatrix())
    }
  })

  it('does not invent a transform for an already upright building', () => {
    const analysis = analyzeUpright(rasterize(identityMatrix()))
    expect(analysis.lines.length).toBeGreaterThan(8)
    expect(analysis.solutions.auto.status).toBe('unchanged')
  })

  it('does not automatically level a few aligned plant-like stems', () => {
    const analysis = analyzeUpright(rasterize(identityMatrix(), 'stems'))
    expect(analysis.lines.length).toBeGreaterThan(0)
    expect(analysis.solutions.auto.status).toBe('insufficient')
  })

  it('detects and corrects roll from raster pixels', () => {
    const distortion = rotationMatrix(7, width / height)
    const analysis = analyzeUpright(rasterize(distortion))
    expect(analysis.solutions.level.status).toBe('corrected')
    expect(analysis.solutions.level.rotationDegrees).toBeCloseTo(-7, 0)
    expect(
      residual(analysis.solutions.level.matrix, distortion, 'horizontal'),
    ).toBeLessThan(0.6)
  })

  it('retains dark structural edges in a frame containing bright highlights', () => {
    const distortion = rotationMatrix(5, width / height)
    const image = rasterize(distortion)
    for (let index = 0; index < image.data.length; index += 4) {
      const value = image.data[index] < 100 ? 18 : 26
      image.data[index] = value
      image.data[index + 1] = value
      image.data[index + 2] = value
    }
    for (let y = 5; y < 20; y++) {
      for (let x = 5; x < 20; x++) {
        image.data.fill(240, (y * width + x) * 4, (y * width + x) * 4 + 3)
      }
    }
    const analysis = analyzeUpright(image)
    expect(analysis.solutions.auto.status).toBe('corrected')
    expect(
      residual(analysis.solutions.auto.matrix, distortion, 'vertical'),
    ).toBeLessThan(0.8)
  })

  it.each([-0.65, 0.65])(
    'rectifies vertical convergence %s without a model',
    (perspective) => {
      const distortion = multiplyMatrices(
        rotationMatrix(4, width / height),
        centered([1, 0, 0, 0, 1, 0, 0, perspective, 1]),
      )
      const analysis = analyzeUpright(rasterize(distortion))
      expect(analysis.solutions.vertical.status).toBe('corrected')
      expect(
        residual(analysis.solutions.vertical.matrix, distortion, 'vertical'),
      ).toBeLessThan(1.1)
      expect(analysis.solutions.auto.status).toBe('corrected')
      expect(
        residual(analysis.solutions.auto.matrix, distortion, 'vertical'),
      ).toBeLessThan(2)
    },
  )

  it('rectifies two converging families in Full mode', () => {
    const distortion = centered([1, 0.03, 0, 0.04, 1, 0, 0.3, -0.55, 1])
    const analysis = analyzeUpright(rasterize(distortion))
    expect(analysis.solutions.full.status).toBe('corrected')
    expect(
      residual(analysis.solutions.full.matrix, distortion, 'vertical'),
    ).toBeLessThan(1.2)
    expect(
      residual(analysis.solutions.full.matrix, distortion, 'horizontal'),
    ).toBeLessThan(1.2)
    expect(
      residual(analysis.solutions.auto.matrix, distortion, 'horizontal'),
    ).toBeLessThan(2)
  })

  it('rejects conflicting outlier edges while preserving the building correction', () => {
    const distortion = multiplyMatrices(
      rotationMatrix(-5, width / height),
      centered([1, 0, 0, 0, 1, 0, 0, -0.5, 1]),
    )
    const analysis = analyzeUpright(rasterize(distortion, 'building', true))
    expect(analysis.solutions.vertical.status).toBe('corrected')
    expect(
      residual(analysis.solutions.vertical.matrix, distortion, 'vertical'),
    ).toBeLessThan(1.2)
    expect(analysis.solutions.auto.status).toBe('corrected')
  })

  it('keeps source-pixel lines and normalized transforms after bounded downsampling', () => {
    const distortion = rotationMatrix(6, width / height)
    const original = rasterize(distortion)
    const factor = 4
    const image = {
      width: width * factor,
      height: height * factor,
      data: new Uint8ClampedArray(original.data.length * factor ** 2),
    }
    for (let y = 0; y < image.height; y++) {
      for (let x = 0; x < image.width; x++) {
        const source =
          (Math.floor(y / factor) * width + Math.floor(x / factor)) * 4
        image.data.set(
          original.data.subarray(source, source + 4),
          (y * image.width + x) * 4,
        )
      }
    }
    const analysis = analyzeUpright(image)
    expect(analysis.lines.some((line) => line.end.x > 640)).toBe(true)
    expect(
      residual(analysis.solutions.level.matrix, distortion, 'horizontal'),
    ).toBeLessThan(0.6)
  })

  it('declines invalid or tiny pixel buffers', () => {
    for (const image of [
      { data: new Uint8ClampedArray(4), width: 360, height: 280 },
      { data: new Uint8ClampedArray(400), width: 10, height: 10 },
    ]) {
      expect(analyzeUpright(image).solutions.auto.status).toBe('insufficient')
    }
  })

  it('is deterministic and resists random image texture', () => {
    const image = rasterize(rotationMatrix(-5, width / height))
    expect(analyzeUpright(image)).toEqual(analyzeUpright(image))
    let state = 73
    for (let index = 0; index < image.data.length; index += 4) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0
      const value = state >>> 24
      image.data[index] = value
      image.data[index + 1] = value
      image.data[index + 2] = value
    }
    expect(analyzeUpright(image).solutions.auto.status).toBe('insufficient')
  })
})
