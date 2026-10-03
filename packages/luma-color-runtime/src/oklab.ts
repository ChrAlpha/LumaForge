import type { Mat3 } from './matrix'
import { mat3Invert, mat3Multiply } from './matrix'

export type OklabVec3 = Float32Array | [number, number, number]

const M_PROPHOTO_TO_XYZ_D50 = new Float32Array([
  0.7976749, 0.1351917, 0.0313534, 0.2880402, 0.7118741, 0.0000857, 0.0, 0.0,
  0.82521,
])

const M_BRADFORD_D50_TO_D65 = new Float32Array([
  0.9555766, -0.0230393, 0.0631636, -0.0282895, 1.0099416, 0.0210077, 0.0122982,
  -0.020483, 1.3299098,
])

const M_XYZ_D65_TO_LMS = new Float32Array([
  0.818933, 0.3618667, -0.1288598, 0.0329845, 0.9293119, 0.0361457, 0.0482003,
  0.2643662, 0.6338517,
])

export const M_PROPHOTO_TO_LMS: Mat3 = mat3Multiply(
  mat3Multiply(M_XYZ_D65_TO_LMS, M_BRADFORD_D50_TO_D65),
  M_PROPHOTO_TO_XYZ_D50,
)

export const M_LMS_TO_PROPHOTO: Mat3 = mat3Invert(M_PROPHOTO_TO_LMS)

export const M_LMS_TO_OKLAB: Mat3 = new Float32Array([
  0.2104542553, 0.793617785, -0.0040720468, 1.9779984951, -2.428592205,
  0.4505937099, 0.0259040371, 0.7827717662, -0.808675766,
])

export const M_OKLAB_TO_LMS: Mat3 = mat3Invert(M_LMS_TO_OKLAB)

export function signedCbrt(x: number): number {
  return Math.sign(x) * Math.pow(Math.abs(x), 1 / 3)
}

function mat3Apply(
  m: Mat3,
  x0: number,
  x1: number,
  x2: number,
  out: OklabVec3,
): OklabVec3 {
  out[0] = m[0] * x0 + m[1] * x1 + m[2] * x2
  out[1] = m[3] * x0 + m[4] * x1 + m[5] * x2
  out[2] = m[6] * x0 + m[7] * x1 + m[8] * x2
  return out
}

export function linearProPhotoToOklab(
  rgb: ArrayLike<number>,
  out: OklabVec3 = new Float32Array(3),
): OklabVec3 {
  const lms0 =
    M_PROPHOTO_TO_LMS[0] * rgb[0] +
    M_PROPHOTO_TO_LMS[1] * rgb[1] +
    M_PROPHOTO_TO_LMS[2] * rgb[2]
  const lms1 =
    M_PROPHOTO_TO_LMS[3] * rgb[0] +
    M_PROPHOTO_TO_LMS[4] * rgb[1] +
    M_PROPHOTO_TO_LMS[5] * rgb[2]
  const lms2 =
    M_PROPHOTO_TO_LMS[6] * rgb[0] +
    M_PROPHOTO_TO_LMS[7] * rgb[1] +
    M_PROPHOTO_TO_LMS[8] * rgb[2]
  return mat3Apply(
    M_LMS_TO_OKLAB,
    signedCbrt(lms0),
    signedCbrt(lms1),
    signedCbrt(lms2),
    out,
  )
}

export function oklabToLinearProPhoto(
  lab: ArrayLike<number>,
  out: OklabVec3 = new Float32Array(3),
): OklabVec3 {
  const lp0 =
    M_OKLAB_TO_LMS[0] * lab[0] +
    M_OKLAB_TO_LMS[1] * lab[1] +
    M_OKLAB_TO_LMS[2] * lab[2]
  const lp1 =
    M_OKLAB_TO_LMS[3] * lab[0] +
    M_OKLAB_TO_LMS[4] * lab[1] +
    M_OKLAB_TO_LMS[5] * lab[2]
  const lp2 =
    M_OKLAB_TO_LMS[6] * lab[0] +
    M_OKLAB_TO_LMS[7] * lab[1] +
    M_OKLAB_TO_LMS[8] * lab[2]
  return mat3Apply(
    M_LMS_TO_PROPHOTO,
    lp0 * lp0 * lp0,
    lp1 * lp1 * lp1,
    lp2 * lp2 * lp2,
    out,
  )
}

const TWO_PI = Math.PI * 2

function wrapHueNorm(value: number): number {
  const wrapped = value - Math.floor(value)
  return wrapped === 1 ? 0 : wrapped
}

export function oklabToOklch(
  lab: ArrayLike<number>,
  out: OklabVec3 = new Float32Array(3),
): OklabVec3 {
  const L = lab[0]
  const a = lab[1]
  const b = lab[2]
  const C = Math.sqrt(a * a + b * b)
  const h = Math.atan2(b, a)
  out[0] = L
  out[1] = C
  out[2] = wrapHueNorm(h / TWO_PI + 1.0)
  return out
}

export function oklchToOklab(
  lch: ArrayLike<number>,
  out: OklabVec3 = new Float32Array(3),
): OklabVec3 {
  const L = lch[0]
  const C = lch[1]
  const h = lch[2] * TWO_PI
  out[0] = L
  out[1] = C * Math.cos(h)
  out[2] = C * Math.sin(h)
  return out
}
