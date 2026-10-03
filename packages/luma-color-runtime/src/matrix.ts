/**
 * Color space transformation matrices and utilities.
 * Implements gamut conversion and log encoding for RAW processing.
 */

import type { ColorGamutId, ColorSpaceDef } from './constants'
import { COLOR_SPACES, resolveColorSpaceKey } from './constants'
import { warn } from './warnings'

/**
 * 3x3 Matrix type for color transformations
 */
export type Mat3 = Float32Array

/**
 * Creates a 3x3 identity matrix
 */
export function mat3Identity(): Mat3 {
  return new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1])
}

/**
 * Multiplies two 3x3 matrices
 */
export function mat3Multiply(a: Mat3, b: Mat3): Mat3 {
  const result = new Float32Array(9)
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      result[row * 3 + col] =
        a[row * 3 + 0] * b[0 * 3 + col] +
        a[row * 3 + 1] * b[1 * 3 + col] +
        a[row * 3 + 2] * b[2 * 3 + col]
    }
  }
  return result
}

/**
 * Inverts a 3x3 matrix
 */
export function mat3Invert(m: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, h, i] = m
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g)

  if (Math.abs(det) < 1e-10) {
    throw new Error('Matrix is singular and cannot be inverted')
  }

  const invDet = 1 / det
  return new Float32Array([
    (e * i - f * h) * invDet,
    (c * h - b * i) * invDet,
    (b * f - c * e) * invDet,
    (f * g - d * i) * invDet,
    (a * i - c * g) * invDet,
    (c * d - a * f) * invDet,
    (d * h - e * g) * invDet,
    (b * g - a * h) * invDet,
    (a * e - b * d) * invDet,
  ])
}

/**
 * Converts xy chromaticity to XYZ (Y=1)
 */
function xyToXYZ(x: number, y: number): [number, number, number] {
  if (y === 0) return [0, 0, 0]
  return [x / y, 1, (1 - x - y) / y]
}

/**
 * Computes RGB to XYZ matrix for a color space
 */
function computeRGBtoXYZMatrix(colorSpace: ColorSpaceDef): Mat3 {
  const { primaries, whitePoint } = colorSpace

  // Convert primaries and white point to XYZ
  const Xr = primaries.red[0] / primaries.red[1]
  const Yr = 1
  const Zr = (1 - primaries.red[0] - primaries.red[1]) / primaries.red[1]

  const Xg = primaries.green[0] / primaries.green[1]
  const Yg = 1
  const Zg = (1 - primaries.green[0] - primaries.green[1]) / primaries.green[1]

  const Xb = primaries.blue[0] / primaries.blue[1]
  const Yb = 1
  const Zb = (1 - primaries.blue[0] - primaries.blue[1]) / primaries.blue[1]

  // White point XYZ
  const [Xw, Yw, Zw] = xyToXYZ(whitePoint[0], whitePoint[1])

  // Build primaries matrix and invert
  const primMat = new Float32Array([Xr, Xg, Xb, Yr, Yg, Yb, Zr, Zg, Zb])
  const invPrimMat = mat3Invert(primMat)

  // Solve for scaling factors
  const Sr = invPrimMat[0] * Xw + invPrimMat[1] * Yw + invPrimMat[2] * Zw
  const Sg = invPrimMat[3] * Xw + invPrimMat[4] * Yw + invPrimMat[5] * Zw
  const Sb = invPrimMat[6] * Xw + invPrimMat[7] * Yw + invPrimMat[8] * Zw

  // Final RGB to XYZ matrix
  return new Float32Array([
    Sr * Xr,
    Sg * Xg,
    Sb * Xb,
    Sr * Yr,
    Sg * Yg,
    Sb * Yb,
    Sr * Zr,
    Sg * Zg,
    Sb * Zb,
  ])
}

// Bradford chromatic adaptation matrix
const BRADFORD_MA = new Float32Array([
  0.8951, 0.2664, -0.1614, -0.7502, 1.7135, 0.0367, 0.0389, -0.0685, 1.0296,
])

const BRADFORD_MA_INV = mat3Invert(BRADFORD_MA)

/**
 * Computes chromatic adaptation matrix using Bradford transform
 */
function chromaticAdaptationMatrix(
  srcWhite: [number, number],
  dstWhite: [number, number],
): Mat3 {
  const [srcX, srcY, srcZ] = xyToXYZ(srcWhite[0], srcWhite[1])
  const [dstX, dstY, dstZ] = xyToXYZ(dstWhite[0], dstWhite[1])

  // Transform to cone response domain
  const srcCone = [
    BRADFORD_MA[0] * srcX + BRADFORD_MA[1] * srcY + BRADFORD_MA[2] * srcZ,
    BRADFORD_MA[3] * srcX + BRADFORD_MA[4] * srcY + BRADFORD_MA[5] * srcZ,
    BRADFORD_MA[6] * srcX + BRADFORD_MA[7] * srcY + BRADFORD_MA[8] * srcZ,
  ]

  const dstCone = [
    BRADFORD_MA[0] * dstX + BRADFORD_MA[1] * dstY + BRADFORD_MA[2] * dstZ,
    BRADFORD_MA[3] * dstX + BRADFORD_MA[4] * dstY + BRADFORD_MA[5] * dstZ,
    BRADFORD_MA[6] * dstX + BRADFORD_MA[7] * dstY + BRADFORD_MA[8] * dstZ,
  ]

  // Diagonal scaling matrix
  const scale = new Float32Array([
    dstCone[0] / srcCone[0],
    0,
    0,
    0,
    dstCone[1] / srcCone[1],
    0,
    0,
    0,
    dstCone[2] / srcCone[2],
  ])

  // M_adapt = M_A^-1 * scale * M_A
  const temp = mat3Multiply(scale, BRADFORD_MA)
  return mat3Multiply(BRADFORD_MA_INV, temp)
}

// Cache computed matrices
const matrixCache = new Map<string, Mat3>()

/**
 * Gets the RGB to RGB transformation matrix between two color spaces.
 * Handles chromatic adaptation when white points differ.
 */
export function getGamutMatrix(srcSpace: string, dstSpace: string): Mat3 {
  const srcKey = resolveColorSpaceKey(srcSpace)
  const dstKey = resolveColorSpaceKey(dstSpace)

  const src = srcKey ? COLOR_SPACES[srcKey] : undefined
  const dst = dstKey ? COLOR_SPACES[dstKey] : undefined

  if (!src || !dst) {
    warn(`Unknown color space: ${srcSpace} or ${dstSpace}`)
    return mat3Identity()
  }

  const cacheKey = `${srcKey}→${dstKey}`
  if (matrixCache.has(cacheKey)) {
    return matrixCache.get(cacheKey)!
  }

  // Compute matrices
  const srcToXYZ = computeRGBtoXYZMatrix(src)
  const dstToXYZ = computeRGBtoXYZMatrix(dst)
  const XYZtoDst = mat3Invert(dstToXYZ)

  let result: Mat3

  // Check if chromatic adaptation is needed
  const srcWhite = src.whitePoint
  const dstWhite = dst.whitePoint

  if (
    Math.abs(srcWhite[0] - dstWhite[0]) > 0.001 ||
    Math.abs(srcWhite[1] - dstWhite[1]) > 0.001
  ) {
    // Apply Bradford chromatic adaptation
    const adapt = chromaticAdaptationMatrix(srcWhite, dstWhite)
    const temp = mat3Multiply(adapt, srcToXYZ)
    result = mat3Multiply(XYZtoDst, temp)
  } else {
    result = mat3Multiply(XYZtoDst, srcToXYZ)
  }

  matrixCache.set(cacheKey, result)
  return result
}

/**
 * Gets a pre-computed matrix for common conversions
 */
export function getProPhotoToTargetMatrix(targetGamut: string): Mat3 {
  return getGamutMatrix('ProPhoto RGB', targetGamut)
}

export function getLinearProPhotoToGamutMatrix(
  targetGamut: ColorGamutId | string,
): Mat3 {
  return getGamutMatrix('prophoto-rgb', targetGamut)
}

export function getLinearGamutMatrix(
  srcGamut: ColorGamutId | string,
  dstGamut: ColorGamutId | string,
): Mat3 {
  return getGamutMatrix(srcGamut, dstGamut)
}

export function getLUTOutputToTargetMatrix(
  lutOutputGamut: ColorGamutId | string,
  targetGamut: ColorGamutId | string,
): Mat3 {
  return getLinearGamutMatrix(lutOutputGamut, targetGamut)
}

/**
 * Converts a row-major Mat3 to the column-major layout shader uniforms use.
 */
export function mat3ToColumnMajor(m: Mat3): Float32Array {
  return new Float32Array([
    m[0],
    m[3],
    m[6], // column 0
    m[1],
    m[4],
    m[7], // column 1
    m[2],
    m[5],
    m[8], // column 2
  ])
}
