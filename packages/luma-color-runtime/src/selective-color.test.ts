import { describe, expect, it } from 'vitest'

import { getLinearProPhotoToGamutMatrix, mat3Invert } from './matrix'
import {
  linearProPhotoToOklab,
  oklabToLinearProPhoto,
  oklabToOklch,
  oklchToOklab,
} from './oklab'
import type {
  HSLBandId,
  HSLBandShift,
  LumaColorSelectiveColorParams,
} from './selective-color'
import {
  adjacentBandCenters,
  applySelectiveColorRow,
  BAND_CENTERS_RAD,
  CHROMA_CLAMP_HIGH,
  CHROMA_CLAMP_LOW,
  HUE_MAX_DELTA_RAD,
  LIGHT_MAX_DELTA,
  LUT_CONSTANTS_VERSION,
  LUT_SIZE,
  makeNeutralBand,
  mixBandShift,
  resolveSelectiveColorParams,
  SAT_MAX_FACTOR,
  wrapFraction,
} from './selective-color'
import { LUMA_COLOR_SELECTIVE_COLOR_WGSL } from './selective-color-wgsl'

const BAND_IDS_ORDERED: readonly HSLBandId[] = [
  'red',
  'orange',
  'yellow',
  'green',
  'aqua',
  'blue',
  'purple',
  'magenta',
]

const TWO_PI = Math.PI * 2

const DOCUMENTED_BAND_DEGREES: Readonly<Record<HSLBandId, number>> = {
  red: 29.2,
  orange: 69.5,
  yellow: 109.8,
  green: 142.5,
  aqua: 194.8,
  blue: 264.2,
  purple: 296.4,
  magenta: 328.5,
}

function degToRad(deg: number): number {
  return (deg * Math.PI) / 180
}

function wrapToTwoPi(value: number): number {
  const wrapped = value % TWO_PI
  return wrapped < 0 ? wrapped + TWO_PI : wrapped
}

function angularDistance(a: number, b: number): number {
  const diff = Math.abs(a - b) % TWO_PI
  return Math.min(diff, TWO_PI - diff)
}

describe('selective-color constants', () => {
  it('exports the documented numeric constants', () => {
    expect(HUE_MAX_DELTA_RAD).toBeCloseTo(Math.PI / 6, 12)
    expect(SAT_MAX_FACTOR).toBe(1.0)
    expect(LIGHT_MAX_DELTA).toBe(0.2)
    expect(CHROMA_CLAMP_LOW).toBe(0.005)
    expect(CHROMA_CLAMP_HIGH).toBe(0.02)
    expect(LUT_SIZE).toBe(256)
    expect(LUT_CONSTANTS_VERSION).toBe(1)
  })

  it('bAND_CENTERS_RAD has length 8', () => {
    expect(BAND_CENTERS_RAD.length).toBe(8)
  })
})

describe('makeNeutralBand (state_safety)', () => {
  it('returns fresh objects so mutating one band does not leak into others', () => {
    const bands: HSLBandShift[] = BAND_IDS_ORDERED.map(() => makeNeutralBand())
    expect(bands.length).toBe(8)
    for (let i = 0; i < bands.length; i++) {
      for (let j = i + 1; j < bands.length; j++) {
        expect(bands[i]).not.toBe(bands[j])
      }
    }

    // Mutate one band's *resolved* shift via a fresh assignable copy.
    // The HSLBandShift type is deep-readonly at the type level, so we mutate
    // through a structurally-compatible mutable alias to prove that the
    // remaining seven bands are unaffected by reference and by value.
    type MutableShift = { hue: number; saturation: number; lightness: number }
    const mutable = bands[2] as unknown as MutableShift
    mutable.hue = 42
    mutable.saturation = -17
    mutable.lightness = 9

    for (let i = 0; i < bands.length; i++) {
      if (i === 2) continue
      expect(bands[i].hue).toBe(0)
      expect(bands[i].saturation).toBe(0)
      expect(bands[i].lightness).toBe(0)
    }
  })

  it('returns a fresh object each call', () => {
    const a = makeNeutralBand()
    const b = makeNeutralBand()
    expect(a).not.toBe(b)
    expect(a).toEqual({ hue: 0, saturation: 0, lightness: 0 })
    expect(b).toEqual({ hue: 0, saturation: 0, lightness: 0 })
  })
})

describe('oKLCh hue axis origin (hue_axis_origin)', () => {
  it('maps synthetic OKLab (a = 0.25, b = 0) to h_norm = 0 and LUT index 0', () => {
    const lab = new Float32Array([0.7, 0.25, 0])
    const lch = new Float32Array(3)
    oklabToOklch(lab, lch)
    expect(lch[2]).toBe(0)

    const lutIndex = Math.floor(lch[2] * LUT_SIZE)
    expect(lutIndex).toBe(0)
  })
})

describe('canonical red LUT position (canonical_red_lut_position)', () => {
  it('linear sRGB red maps to h_norm ≈ 0.0811 and LUT index between 20 and 21', () => {
    // Step 1: linear sRGB red.
    const linearSrgbRed: readonly [number, number, number] = [1, 0, 0]

    // Step 2: convert linear sRGB -> linear ProPhoto via the inverse of the
    // pro-photo -> sRGB gamut matrix.
    const proPhotoToSrgb = getLinearProPhotoToGamutMatrix('srgb-rec709')
    const srgbToProPhoto = mat3Invert(proPhotoToSrgb)
    const linearProPhotoRed = new Float32Array(3)
    linearProPhotoRed[0] =
      srgbToProPhoto[0] * linearSrgbRed[0] +
      srgbToProPhoto[1] * linearSrgbRed[1] +
      srgbToProPhoto[2] * linearSrgbRed[2]
    linearProPhotoRed[1] =
      srgbToProPhoto[3] * linearSrgbRed[0] +
      srgbToProPhoto[4] * linearSrgbRed[1] +
      srgbToProPhoto[5] * linearSrgbRed[2]
    linearProPhotoRed[2] =
      srgbToProPhoto[6] * linearSrgbRed[0] +
      srgbToProPhoto[7] * linearSrgbRed[1] +
      srgbToProPhoto[8] * linearSrgbRed[2]

    // Step 3: linear ProPhoto -> OKLab -> OKLCh.
    const lab = new Float32Array(3)
    const lch = new Float32Array(3)
    linearProPhotoToOklab(linearProPhotoRed, lab)
    oklabToOklch(lab, lch)

    const hNorm = lch[2]
    const expectedHNorm = 29.2 / 360
    // ±0.5° / 360° tolerance = ±0.00139
    expect(Math.abs(hNorm - expectedHNorm)).toBeLessThanOrEqual(0.5 / 360)

    const lutIndexFloat = hNorm * LUT_SIZE
    expect(lutIndexFloat).toBeGreaterThan(20)
    expect(lutIndexFloat).toBeLessThan(21)
  })
})

describe('bAND_CENTERS_RAD (band_centers_match_table)', () => {
  it('each computed band centre matches the documented degree within ±0.5°', () => {
    expect(BAND_CENTERS_RAD.length).toBe(BAND_IDS_ORDERED.length)
    const halfDegRad = degToRad(0.5)
    for (let i = 0; i < BAND_IDS_ORDERED.length; i++) {
      const bandId = BAND_IDS_ORDERED[i]
      const docDeg = DOCUMENTED_BAND_DEGREES[bandId]
      const docRad = wrapToTwoPi(degToRad(docDeg))
      const computed = BAND_CENTERS_RAD[i]
      expect(computed).toBeGreaterThanOrEqual(0)
      expect(computed).toBeLessThan(TWO_PI)
      const dist = angularDistance(computed, docRad)
      expect(
        dist,
        `band ${bandId} computed ${(computed * 180) / Math.PI} deg vs documented ${docDeg} deg`,
      ).toBeLessThanOrEqual(halfDegRad)
    }
  })

  it('band centres are strictly increasing in [0, 2π)', () => {
    for (let i = 1; i < BAND_CENTERS_RAD.length; i++) {
      expect(BAND_CENTERS_RAD[i]).toBeGreaterThan(BAND_CENTERS_RAD[i - 1])
    }
  })
})

describe('wrapFraction', () => {
  it('returns the fraction of the arc from left to right', () => {
    const left = degToRad(29.2)
    const right = degToRad(69.5)
    const mid = (left + right) / 2
    expect(wrapFraction(left, left, right)).toBeCloseTo(0, 10)
    expect(wrapFraction(right, left, right)).toBeCloseTo(1, 10)
    expect(wrapFraction(mid, left, right)).toBeCloseTo(0.5, 10)
  })

  it('clamps to [0, 1] outside the arc', () => {
    const left = degToRad(29.2)
    const right = degToRad(69.5)
    expect(wrapFraction(degToRad(20), left, right)).toBeGreaterThanOrEqual(0)
    expect(wrapFraction(degToRad(20), left, right)).toBeLessThanOrEqual(1)
  })

  it('handles wrap-around across the magenta -> red seam', () => {
    const left = degToRad(328.5)
    const right = degToRad(29.2)
    // h_i = 0 deg (just past magenta -> red seam at 360 deg)
    const t0 = wrapFraction(0, left, right)
    expect(t0).toBeGreaterThan(0)
    expect(t0).toBeLessThan(1)
    // h_i at left endpoint -> 0
    expect(wrapFraction(left, left, right)).toBeCloseTo(0, 10)
    // h_i at right endpoint -> 1
    expect(wrapFraction(right, left, right)).toBeCloseTo(1, 10)
  })
})

describe('adjacentBandCenters', () => {
  it('returns documented-order indices for an interior hue', () => {
    // Between orange (≈69.5°) and yellow (≈109.8°).
    const h = degToRad(90)
    const { leftIdx, rightIdx } = adjacentBandCenters(h)
    expect(leftIdx).toBe(1)
    expect(rightIdx).toBe(2)
  })

  it('wraps around for hues between magenta and red+2π', () => {
    // h_i = 0 deg lies between magenta (≈328.5°) and red+360 (≈389.2°).
    const { leftIdx, rightIdx } = adjacentBandCenters(0)
    expect(leftIdx).toBe(7)
    expect(rightIdx).toBe(0)
  })

  it('handles h_i exactly at a band centre (left-inclusive)', () => {
    // At exactly red centre, left-inclusive convention picks the bracket
    // starting at red.
    const h = BAND_CENTERS_RAD[0]
    const { leftIdx, rightIdx } = adjacentBandCenters(h)
    expect(leftIdx).toBe(0)
    expect(rightIdx).toBe(1)
  })
})

describe('mixBandShift', () => {
  it('returns left at t = 0 and right at t = 1', () => {
    const left: HSLBandShift = { hue: 10, saturation: 20, lightness: 30 }
    const right: HSLBandShift = { hue: -5, saturation: 50, lightness: 0 }
    const atZero = mixBandShift(left, right, 0)
    expect(atZero.hue).toBeCloseTo(10, 12)
    expect(atZero.saturation).toBeCloseTo(20, 12)
    expect(atZero.lightness).toBeCloseTo(30, 12)
    const atOne = mixBandShift(left, right, 1)
    expect(atOne.hue).toBeCloseTo(-5, 12)
    expect(atOne.saturation).toBeCloseTo(50, 12)
    expect(atOne.lightness).toBeCloseTo(0, 12)
  })

  it('linearly interpolates the three scalars at t = 0.5', () => {
    const left: HSLBandShift = { hue: 10, saturation: 20, lightness: 30 }
    const right: HSLBandShift = { hue: -10, saturation: 40, lightness: 0 }
    const mid = mixBandShift(left, right, 0.5)
    expect(mid.hue).toBeCloseTo(0, 12)
    expect(mid.saturation).toBeCloseTo(30, 12)
    expect(mid.lightness).toBeCloseTo(15, 12)
  })
})

function makeNeutralParams(): LumaColorSelectiveColorParams {
  const bands = {} as Record<HSLBandId, HSLBandShift>
  for (const id of BAND_IDS_ORDERED) {
    bands[id] = makeNeutralBand()
  }
  return { selectiveColor: bands }
}

function paramsWithBand(
  bandId: HSLBandId,
  shift: HSLBandShift,
): LumaColorSelectiveColorParams {
  const params = makeNeutralParams()
  const next = { ...params.selectiveColor, [bandId]: shift }
  return { selectiveColor: next }
}

describe('resolveSelectiveColorParams bake', () => {
  it('bake_size_invariant: writes exactly 1024 entries', () => {
    const { prepared } = resolveSelectiveColorParams(makeNeutralParams())
    expect(prepared.buffer.length).toBe(4 * LUT_SIZE)
    expect(prepared.buffer.length).toBe(1024)
  })

  it('reuses the caller-supplied out buffer when provided', () => {
    const out = new Float32Array(4 * LUT_SIZE)
    const { prepared } = resolveSelectiveColorParams(makeNeutralParams(), out)
    expect(prepared.buffer).toBe(out)
  })

  it('rejects outBuffer with wrong length', () => {
    const badBuffer = new Float32Array(512)
    expect(() =>
      resolveSelectiveColorParams(makeNeutralParams(), badBuffer),
    ).toThrow(/1024/)
    expect(() =>
      resolveSelectiveColorParams(makeNeutralParams(), badBuffer),
    ).toThrow(/512/)
  })

  it('bake_field_naming: bake reads band.saturation, not band.sat', () => {
    const params = paramsWithBand('red', {
      hue: 0,
      saturation: 50,
      lightness: 0,
    })
    const { prepared } = resolveSelectiveColorParams(params)
    // The G channel at the red anchor index encodes 1 + (saturation/100) * SAT_MAX_FACTOR.
    // With saturation = 50 and SAT_MAX_FACTOR = 1.0, the value is bracketed
    // between 1 (no saturation contribution) and 2 (full clamp). If the bake
    // mistakenly reads `band.sat` (undefined), the resolved field is 0 and the
    // G channel collapses back to 1.0.
    const redCenter = BAND_CENTERS_RAD[0]
    const anchorIdx =
      Math.round((redCenter / (Math.PI * 2)) * LUT_SIZE) % LUT_SIZE
    const gAtAnchor = prepared.buffer[4 * anchorIdx + 1]
    expect(gAtAnchor).not.toBeCloseTo(1.0, 6)
    expect(gAtAnchor).toBeGreaterThan(1.0)
    expect(gAtAnchor).toBeLessThanOrEqual(2.0)
  })

  it('partition_of_unity_exactly_two_bands: only the two bracket bands contribute and weights sum to 1', () => {
    const markerHue = 100
    const tolerance = 1e-6
    const out = new Float32Array(4 * LUT_SIZE)

    for (let i = 0; i < LUT_SIZE; i++) {
      const h_i = (i / LUT_SIZE) * Math.PI * 2
      const { leftIdx, rightIdx } = adjacentBandCenters(h_i)

      const weights: number[] = Array.from<number>({
        length: BAND_IDS_ORDERED.length,
      }).fill(0)
      for (let b = 0; b < BAND_IDS_ORDERED.length; b++) {
        const bandId = BAND_IDS_ORDERED[b]
        const params = paramsWithBand(bandId, {
          hue: markerHue,
          saturation: 0,
          lightness: 0,
        })
        const { prepared } = resolveSelectiveColorParams(params, out)
        const rAtI = prepared.buffer[4 * i + 0]
        const weight = rAtI / HUE_MAX_DELTA_RAD / (markerHue / 100)

        if (b === leftIdx || b === rightIdx) {
          weights[b] = weight
        } else {
          expect(
            Math.abs(rAtI),
            `non-bracket band ${bandId} contributed to LUT index ${i}`,
          ).toBeLessThanOrEqual(tolerance)
        }
      }

      const sum = weights[leftIdx] + weights[rightIdx]
      expect(
        Math.abs(sum - 1),
        `bracket weights at LUT index ${i} sum to ${sum}, expected 1`,
      ).toBeLessThanOrEqual(tolerance)
    }
  })
})

describe('band_center_boundary_consistency', () => {
  it('both bracket choices at an exact band centre yield the same band shift', () => {
    // At h_i = red centre, evaluating from "red is the right endpoint" gives
    // t = 1 and the band equals red; evaluating from "red is the left
    // endpoint" gives t = 0 and the band also equals red. Both branches must
    // produce the same scalar triple regardless of the bracket choice.
    const redBand: HSLBandShift = { hue: 25, saturation: -10, lightness: 5 }
    const magentaBand: HSLBandShift = {
      hue: -40,
      saturation: 60,
      lightness: -20,
    }
    const orangeBand: HSLBandShift = { hue: 80, saturation: 30, lightness: 10 }

    // Branch A: red is the *right* endpoint (left = magenta, right = red), t = 1.
    const branchA = mixBandShift(magentaBand, redBand, 1)
    // Branch B: red is the *left* endpoint (left = red, right = orange), t = 0.
    const branchB = mixBandShift(redBand, orangeBand, 0)

    expect(branchA.hue).toBeCloseTo(branchB.hue, 12)
    expect(branchA.saturation).toBeCloseTo(branchB.saturation, 12)
    expect(branchA.lightness).toBeCloseTo(branchB.lightness, 12)
    // Sanity: both branches reproduce the red band exactly.
    expect(branchA).toEqual(redBand)
    expect(branchB).toEqual(redBand)
  })
})

// ---------------------------------------------------------------------------
// Apply-path fixtures and helpers (Task 5 failure-mode sweep)
// ---------------------------------------------------------------------------

const proPhotoToSrgbGlobal = getLinearProPhotoToGamutMatrix('srgb-rec709')
const srgbToProPhotoGlobal = mat3Invert(proPhotoToSrgbGlobal)

function linearSrgbToLinearProPhoto(
  rLin: number,
  gLin: number,
  bLin: number,
): [number, number, number] {
  return [
    srgbToProPhotoGlobal[0] * rLin +
      srgbToProPhotoGlobal[1] * gLin +
      srgbToProPhotoGlobal[2] * bLin,
    srgbToProPhotoGlobal[3] * rLin +
      srgbToProPhotoGlobal[4] * gLin +
      srgbToProPhotoGlobal[5] * bLin,
    srgbToProPhotoGlobal[6] * rLin +
      srgbToProPhotoGlobal[7] * gLin +
      srgbToProPhotoGlobal[8] * bLin,
  ]
}

interface AnchorSpec {
  readonly label: string
  readonly bandIndex: number
  readonly rgb: readonly [number, number, number]
}

function computeAnchorList(): readonly AnchorSpec[] {
  // Six sRGB primaries/secondaries; their indices in BAND_IDS_ORDERED match
  // the cardinal slots. The two midpoints (orange, purple) are derived as the
  // short-arc OKLCh midpoints used inside computeBandCentersRad, so we
  // recover them by feeding the BAND_CENTERS_RAD entry directly through the
  // inverse path: pick L = 0.7, C = 0.10 and synthesize the OKLab vector.
  const result: AnchorSpec[] = [
    { label: 'red', bandIndex: 0, rgb: linearSrgbToLinearProPhoto(1, 0, 0) },
    {
      label: 'orange',
      bandIndex: 1,
      rgb: linearSrgbToLinearProPhotoFromBandCenter(1),
    },
    { label: 'yellow', bandIndex: 2, rgb: linearSrgbToLinearProPhoto(1, 1, 0) },
    { label: 'green', bandIndex: 3, rgb: linearSrgbToLinearProPhoto(0, 1, 0) },
    { label: 'aqua', bandIndex: 4, rgb: linearSrgbToLinearProPhoto(0, 1, 1) },
    { label: 'blue', bandIndex: 5, rgb: linearSrgbToLinearProPhoto(0, 0, 1) },
    {
      label: 'purple',
      bandIndex: 6,
      rgb: linearSrgbToLinearProPhotoFromBandCenter(6),
    },
    {
      label: 'magenta',
      bandIndex: 7,
      rgb: linearSrgbToLinearProPhoto(1, 0, 1),
    },
  ]
  return result
}

function linearSrgbToLinearProPhotoFromBandCenter(
  bandIndex: number,
): [number, number, number] {
  // Synthesize a linear ProPhoto sample that sits exactly on the band centre
  // hue at moderate chroma so the apply path measures a well-defined hue
  // shift.
  const h = BAND_CENTERS_RAD[bandIndex]
  const L = 0.7
  const C = 0.1
  const lab = new Float32Array([L, C * Math.cos(h), C * Math.sin(h)])
  const rgb = new Float32Array(3)
  oklabToLinearProPhoto(lab, rgb)
  return [rgb[0], rgb[1], rgb[2]]
}

const ANCHOR_SPECS = computeAnchorList()

function makeBandsWithScalar(
  bandIndex: number,
  field: keyof HSLBandShift,
  value: number,
): LumaColorSelectiveColorParams {
  const params = makeNeutralParams()
  const id = BAND_IDS_ORDERED[bandIndex]
  const next: HSLBandShift = {
    hue: field === 'hue' ? value : 0,
    saturation: field === 'saturation' ? value : 0,
    lightness: field === 'lightness' ? value : 0,
  }
  const bands = { ...params.selectiveColor, [id]: next }
  return { selectiveColor: bands }
}

function applySinglePixel(
  rgbIn: readonly [number, number, number],
  params: LumaColorSelectiveColorParams,
): [number, number, number] {
  const { prepared } = resolveSelectiveColorParams(params)
  const input = new Float32Array(rgbIn)
  const output = new Float32Array(3)
  applySelectiveColorRow(input, output, prepared)
  return [output[0], output[1], output[2]]
}

function rgbToOklchHueRad(rgb: readonly [number, number, number]): {
  L: number
  C: number
  hRad: number
} {
  const lab = new Float32Array(3)
  linearProPhotoToOklab(rgb, lab)
  const L = lab[0]
  const a = lab[1]
  const b = lab[2]
  const C = Math.sqrt(a * a + b * b)
  const hRad = Math.atan2(b, a)
  return { L, C, hRad }
}

function signedHueDelta(hIn: number, hOut: number): number {
  let d = hOut - hIn
  while (d > Math.PI) d -= 2 * Math.PI
  while (d < -Math.PI) d += 2 * Math.PI
  return d
}

function unsignedHueDelta(hIn: number, hOut: number): number {
  return Math.abs(signedHueDelta(hIn, hOut))
}

// ColorChecker grid lifted from the OKLab round-trip fixture so the neutral
// identity test sweeps real in-gamut linear ProPhoto triplets.
const SRGB_TO_XYZ_D65_F64: readonly number[] = [
  0.4123907992659595, 0.357584339383878, 0.1804807884018343,
  0.21263900587151036, 0.715168678767756, 0.07219231536073371,
  0.01933081871559185, 0.11919477979462598, 0.9505321522496606,
]

function srgbCompanding(value: number): number {
  if (value <= 0.04045) return value / 12.92
  return Math.pow((value + 0.055) / 1.055, 2.4)
}

function mat3MulVecArray(
  m: readonly number[],
  v: readonly [number, number, number],
): [number, number, number] {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ]
}

const M_BRADFORD_D50_TO_D65_F64: readonly number[] = [
  0.9555766, -0.0230393, 0.0631636, -0.0282895, 1.0099416, 0.0210077, 0.0122982,
  -0.020483, 1.3299098,
]
const M_PROPHOTO_TO_XYZ_D50_F64: readonly number[] = [
  0.7976749, 0.1351917, 0.0313534, 0.2880402, 0.7118741, 0.0000857, 0.0, 0.0,
  0.82521,
]

function mat3MultiplyF64(
  a: readonly number[],
  b: readonly number[],
): readonly number[] {
  const out: number[] = Array.from({ length: 9 }).fill(0)
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      out[row * 3 + col] =
        a[row * 3 + 0] * b[0 * 3 + col] +
        a[row * 3 + 1] * b[1 * 3 + col] +
        a[row * 3 + 2] * b[2 * 3 + col]
    }
  }
  return out
}

function mat3InvertF64(m: readonly number[]): readonly number[] {
  const [a, b, c, d, e, f, g, h, i] = m
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g)
  const invDet = 1 / det
  return [
    (e * i - f * h) * invDet,
    (c * h - b * i) * invDet,
    (b * f - c * e) * invDet,
    (f * g - d * i) * invDet,
    (a * i - c * g) * invDet,
    (c * d - a * f) * invDet,
    (d * h - e * g) * invDet,
    (b * g - a * h) * invDet,
    (a * e - b * d) * invDet,
  ]
}

const XYZ_D65_TO_PROPHOTO_D50_F64 = mat3InvertF64(
  mat3MultiplyF64(M_BRADFORD_D50_TO_D65_F64, M_PROPHOTO_TO_XYZ_D50_F64),
)

function srgb8ToLinearProPhoto(
  r: number,
  g: number,
  b: number,
): [number, number, number] {
  const linearSrgb: [number, number, number] = [
    srgbCompanding(r / 255),
    srgbCompanding(g / 255),
    srgbCompanding(b / 255),
  ]
  const xyz = mat3MulVecArray(SRGB_TO_XYZ_D65_F64, linearSrgb)
  return mat3MulVecArray(XYZ_D65_TO_PROPHOTO_D50_F64, xyz)
}

const COLORCHECKER_SRGB_8BIT: ReadonlyArray<[number, number, number]> = [
  [115, 82, 68],
  [194, 150, 130],
  [98, 122, 157],
  [87, 108, 67],
  [133, 128, 177],
  [103, 189, 170],
  [214, 126, 44],
  [80, 91, 166],
  [193, 90, 99],
  [94, 60, 108],
  [157, 188, 64],
  [224, 163, 46],
  [56, 61, 150],
  [70, 148, 73],
  [175, 54, 60],
  [231, 199, 31],
  [187, 86, 149],
  [8, 133, 161],
  [243, 243, 242],
  [200, 200, 200],
  [160, 160, 160],
  [122, 122, 121],
  [85, 85, 85],
  [52, 52, 52],
]

const COLORCHECKER_LINEAR_PROPHOTO: ReadonlyArray<[number, number, number]> =
  COLORCHECKER_SRGB_8BIT.map((p) => srgb8ToLinearProPhoto(p[0], p[1], p[2]))

const PINNED_SKIN_LAB: readonly [number, number, number] = [0.7, 0.072, 0.072]
function pinnedSkinLinearProPhoto(): [number, number, number] {
  const rgb = new Float32Array(3)
  oklabToLinearProPhoto(new Float32Array(PINNED_SKIN_LAB), rgb)
  return [rgb[0], rgb[1], rgb[2]]
}

function smoothstepUnit(t: number): number {
  const x = Math.max(0, Math.min(1, t))
  return x * x * (3 - 2 * x)
}

describe('applySelectiveColorRow canonical swatch dominance (canonical_swatch_dominance)', () => {
  it('each anchor under its own hue=+50 yields w_eff >= 0.99', () => {
    for (const anchor of ANCHOR_SPECS) {
      const params = makeBandsWithScalar(anchor.bandIndex, 'hue', 50)
      const before = rgbToOklchHueRad(anchor.rgb)
      const after = rgbToOklchHueRad(applySinglePixel(anchor.rgb, params))
      const observed = Math.abs(signedHueDelta(before.hRad, after.hRad))
      const ideal = (50 / 100) * HUE_MAX_DELTA_RAD
      const wEff = observed / ideal
      expect(
        wEff,
        `anchor ${anchor.label}: observed=${observed} ideal=${ideal} w_eff=${wEff}`,
      ).toBeGreaterThanOrEqual(0.99)
    }
  })
})

describe('applySelectiveColorRow canonical swatch isolation (canonical_swatch_isolation)', () => {
  it('non-adjacent band shifts produce exactly zero hue shift within F32 tolerance', () => {
    for (const anchor of ANCHOR_SPECS) {
      const adjLeft = (anchor.bandIndex - 1 + 8) % 8
      const adjRight = (anchor.bandIndex + 1) % 8
      for (let b = 0; b < 8; b++) {
        if (b === anchor.bandIndex || b === adjLeft || b === adjRight) continue
        const params = makeBandsWithScalar(b, 'hue', 50)
        const before = rgbToOklchHueRad(anchor.rgb)
        const after = rgbToOklchHueRad(applySinglePixel(anchor.rgb, params))
        const observed = unsignedHueDelta(before.hRad, after.hRad)
        expect(
          observed,
          `anchor ${anchor.label} non-adjacent band ${BAND_IDS_ORDERED[b]}: observed=${observed}`,
        ).toBeLessThan(1e-6)
      }
    }
  })
})

describe('applySelectiveColorRow neutral identity (neutral_identity_in_gamut)', () => {
  it('all-neutral bands leave the ColorChecker grid unchanged within 1e-5', () => {
    const params = makeNeutralParams()
    const { prepared } = resolveSelectiveColorParams(params)
    const input = new Float32Array(COLORCHECKER_LINEAR_PROPHOTO.length * 3)
    COLORCHECKER_LINEAR_PROPHOTO.forEach((rgb, idx) => {
      input[3 * idx + 0] = rgb[0]
      input[3 * idx + 1] = rgb[1]
      input[3 * idx + 2] = rgb[2]
    })
    const output = new Float32Array(input.length)
    applySelectiveColorRow(input, output, prepared)
    for (let i = 0; i < input.length; i++) {
      expect(
        Math.abs(output[i] - input[i]),
        `index ${i} channel delta`,
      ).toBeLessThanOrEqual(1e-5)
    }
  })
})

describe('applySelectiveColorRow neutral identity above clip (neutral_identity_above_clip)', () => {
  it('all-neutral bands leave (1.4, 1.2, 1.5) unchanged within 1e-5', () => {
    const params = makeNeutralParams()
    const { prepared } = resolveSelectiveColorParams(params)
    const input = new Float32Array([1.4, 1.2, 1.5])
    const output = new Float32Array(3)
    applySelectiveColorRow(input, output, prepared)
    expect(Math.abs(output[0] - input[0])).toBeLessThanOrEqual(1e-5)
    expect(Math.abs(output[1] - input[1])).toBeLessThanOrEqual(1e-5)
    expect(Math.abs(output[2] - input[2])).toBeLessThanOrEqual(1e-5)
  })
})

describe('applySelectiveColorRow neutral identity negative LMS (neutral_identity_negative_lms)', () => {
  it('all-neutral bands pass through wide-gamut blue samples that drive negative LMS', () => {
    const params = makeNeutralParams()
    const { prepared } = resolveSelectiveColorParams(params)
    const samples: ReadonlyArray<[number, number, number]> = [
      [0.0, 0.0, 1.0],
      [0.01, 0.02, 1.5],
      [0.0, 0.05, 0.6],
      [0.05, 0.0, 0.8],
    ]
    for (const rgb of samples) {
      const input = new Float32Array(rgb)
      const output = new Float32Array(3)
      applySelectiveColorRow(input, output, prepared)
      expect(Math.abs(output[0] - input[0])).toBeLessThanOrEqual(1e-5)
      expect(Math.abs(output[1] - input[1])).toBeLessThanOrEqual(1e-5)
      expect(Math.abs(output[2] - input[2])).toBeLessThanOrEqual(1e-5)
    }
  })
})

describe('applySelectiveColorRow seam continuity (seam_continuity)', () => {
  it('saturation-only edit preserves hue with bounded derivative across the seam', () => {
    const L = 0.7
    const C = 0.1
    const N = 1024
    const ramp = new Float32Array(N * 3)
    const lab = new Float32Array(3)
    const lch = new Float32Array(3)
    const rgbScratch = new Float32Array(3)
    const inputHues = Array.from({ length: N })
    for (let i = 0; i < N; i++) {
      const hNorm = i / N
      lch[0] = L
      lch[1] = C
      lch[2] = hNorm
      oklchToOklab(lch, lab)
      oklabToLinearProPhoto(lab, rgbScratch)
      ramp[3 * i + 0] = rgbScratch[0]
      ramp[3 * i + 1] = rgbScratch[1]
      ramp[3 * i + 2] = rgbScratch[2]
      inputHues[i] = Math.atan2(lab[2], lab[1])
    }
    const params = makeBandsWithScalar(0, 'saturation', 50)
    const { prepared } = resolveSelectiveColorParams(params)
    const out = new Float32Array(N * 3)
    applySelectiveColorRow(ramp, out, prepared)

    const shifts = Array.from({ length: N })
    const labOut = new Float32Array(3)
    for (let i = 0; i < N; i++) {
      // The ramp is constructed from linearly-known hues; recover the input
      // hue directly to avoid F32 polar drift.
      const inHue = inputHues[i]
      linearProPhotoToOklab(
        out.subarray(3 * i, 3 * i + 3) as ArrayLike<number>,
        labOut,
      )
      const outHue = Math.atan2(labOut[2], labOut[1])
      shifts[i] = signedHueDelta(inHue, outHue)
    }
    let maxStep = 0
    for (let i = 0; i < N; i++) {
      const j = (i + 1) % N
      const diff = Math.abs(shifts[j] - shifts[i])
      if (diff > maxStep) maxStep = diff
    }
    // Saturation-only edits should preserve hue, so the discrete derivative
    // is dominated by F32 noise; the threshold is a regression detector.
    expect(maxStep).toBeLessThan(1e-2)
  })
})

describe('applySelectiveColorRow blue/purple desaturation no hue shift (blue_purple_no_shift)', () => {
  it('blue.saturation = -50 leaves 270-330° hues within 1e-2 rad of input', () => {
    const L = 0.7
    const C = 0.1
    const N = 256
    const params = makeBandsWithScalar(5, 'saturation', -50)
    const { prepared } = resolveSelectiveColorParams(params)
    const lab = new Float32Array(3)
    const rgbIn = new Float32Array(3)
    const rgbOut = new Float32Array(3)
    const labOut = new Float32Array(3)
    for (let i = 0; i <= N; i++) {
      const tt = i / N
      const hDeg = 270 + 60 * tt
      const h = (hDeg * Math.PI) / 180
      lab[0] = L
      lab[1] = C * Math.cos(h)
      lab[2] = C * Math.sin(h)
      oklabToLinearProPhoto(lab, rgbIn)
      applySelectiveColorRow(rgbIn, rgbOut, prepared)
      linearProPhotoToOklab(rgbOut, labOut)
      const outHue = Math.atan2(labOut[2], labOut[1])
      const delta = unsignedHueDelta(h, outHue)
      expect(delta, `hue ${hDeg.toFixed(2)}°`).toBeLessThan(1e-2)
    }
  })
})

describe('applySelectiveColorRow aqua desaturation no hue shift (aqua_no_shift_under_desaturation)', () => {
  it('aqua.saturation = -50 leaves 165-225° hues within 1e-2 rad of input', () => {
    const L = 0.7
    const C = 0.1
    const N = 256
    const params = makeBandsWithScalar(4, 'saturation', -50)
    const { prepared } = resolveSelectiveColorParams(params)
    const lab = new Float32Array(3)
    const rgbIn = new Float32Array(3)
    const rgbOut = new Float32Array(3)
    const labOut = new Float32Array(3)
    for (let i = 0; i <= N; i++) {
      const tt = i / N
      const hDeg = 165 + 60 * tt
      const h = (hDeg * Math.PI) / 180
      lab[0] = L
      lab[1] = C * Math.cos(h)
      lab[2] = C * Math.sin(h)
      oklabToLinearProPhoto(lab, rgbIn)
      applySelectiveColorRow(rgbIn, rgbOut, prepared)
      linearProPhotoToOklab(rgbOut, labOut)
      const outHue = Math.atan2(labOut[2], labOut[1])
      const delta = unsignedHueDelta(h, outHue)
      expect(delta, `hue ${hDeg.toFixed(2)}°`).toBeLessThan(1e-2)
    }
  })
})

describe('applySelectiveColorRow skin attenuation under red (skin_attenuation_under_red)', () => {
  it('pinned skin patch under red.hue = +50 produces (0.5 * w_red) * HUE_MAX_DELTA_RAD shift', () => {
    const rgb = pinnedSkinLinearProPhoto()
    const params = makeBandsWithScalar(0, 'hue', 50)
    const before = rgbToOklchHueRad(rgb)
    const after = rgbToOklchHueRad(applySinglePixel(rgb, params))
    const observed = signedHueDelta(before.hRad, after.hRad)

    const redRad = BAND_CENTERS_RAD[0]
    const orangeRad = BAND_CENTERS_RAD[1]
    const t = (Math.PI / 4 - redRad) / (orangeRad - redRad)
    const wRed = 1 - smoothstepUnit(t)
    const expected = (50 / 100) * wRed * HUE_MAX_DELTA_RAD

    expect(Math.abs(observed - expected)).toBeLessThanOrEqual(1e-4)
  })
})

describe('applySelectiveColorRow skin band maps to orange (skin_band_maps_to_orange)', () => {
  it('pinned skin patch under orange.hue = +50 produces (0.5 * (1 - w_red)) * HUE_MAX_DELTA_RAD shift', () => {
    const rgb = pinnedSkinLinearProPhoto()
    const params = makeBandsWithScalar(1, 'hue', 50)
    const before = rgbToOklchHueRad(rgb)
    const after = rgbToOklchHueRad(applySinglePixel(rgb, params))
    const observed = signedHueDelta(before.hRad, after.hRad)

    const redRad = BAND_CENTERS_RAD[0]
    const orangeRad = BAND_CENTERS_RAD[1]
    const t = (Math.PI / 4 - redRad) / (orangeRad - redRad)
    const wRed = 1 - smoothstepUnit(t)
    const expected = (50 / 100) * (1 - wRed) * HUE_MAX_DELTA_RAD

    expect(Math.abs(observed - expected)).toBeLessThanOrEqual(1e-4)
  })
})

describe('applySelectiveColorRow skin partition of unity (skin_band_partition_of_unity)', () => {
  it('pinned skin patch under red.hue = orange.hue = +50 shifts exactly 0.5 * HUE_MAX_DELTA_RAD', () => {
    const rgb = pinnedSkinLinearProPhoto()
    const params: LumaColorSelectiveColorParams = {
      selectiveColor: {
        red: { hue: 50, saturation: 0, lightness: 0 },
        orange: { hue: 50, saturation: 0, lightness: 0 },
        yellow: makeNeutralBand(),
        green: makeNeutralBand(),
        aqua: makeNeutralBand(),
        blue: makeNeutralBand(),
        purple: makeNeutralBand(),
        magenta: makeNeutralBand(),
      },
    }
    const before = rgbToOklchHueRad(rgb)
    const after = rgbToOklchHueRad(applySinglePixel(rgb, params))
    const observed = signedHueDelta(before.hRad, after.hRad)
    const expected = 0.5 * HUE_MAX_DELTA_RAD
    expect(Math.abs(observed - expected)).toBeLessThanOrEqual(1e-4)
  })
})

describe('applySelectiveColorRow skin isolation under yellow (skin_isolation_under_yellow)', () => {
  it('pinned skin patch is invariant under yellow.hue = ±50', () => {
    const rgb = pinnedSkinLinearProPhoto()
    for (const value of [50, -50]) {
      const params = makeBandsWithScalar(2, 'hue', value)
      const before = rgbToOklchHueRad(rgb)
      const after = rgbToOklchHueRad(applySinglePixel(rgb, params))
      const observed = unsignedHueDelta(before.hRad, after.hRad)
      expect(observed, `yellow.hue=${value}`).toBeLessThan(1e-6)
    }
  })
})

describe('applySelectiveColorRow chroma amplitude clamp (chroma_amplitude_clamp)', () => {
  it('mid-grey patch under red.hue = +100 produces 8-bit deltas below 1 LSB', () => {
    // OKLab(0.5, 0.001, 0.0005) -> chroma ~0.00112 < CHROMA_CLAMP_LOW; strength = 0.
    const lab = new Float32Array([0.5, 0.001, 0.0005])
    const rgbIn = new Float32Array(3)
    oklabToLinearProPhoto(lab, rgbIn)
    const params = makeBandsWithScalar(0, 'hue', 100)
    const { prepared } = resolveSelectiveColorParams(params)
    const rgbOut = new Float32Array(3)
    applySelectiveColorRow(rgbIn, rgbOut, prepared)
    for (let c = 0; c < 3; c++) {
      const inRounded = Math.round(rgbIn[c] * 255)
      const outRounded = Math.round(rgbOut[c] * 255)
      expect(
        Math.abs(outRounded - inRounded),
        `channel ${c} in=${rgbIn[c]} out=${rgbOut[c]}`,
      ).toBeLessThanOrEqual(0)
    }
  })
})

describe('applySelectiveColorRow cross-talk smoothness (cross_talk_smoothness)', () => {
  it('red.hue = +50 produces bounded discrete derivative across a full hue ramp', () => {
    const L = 0.7
    const C = 0.1
    const N = 256
    const params = makeBandsWithScalar(0, 'hue', 50)
    const { prepared } = resolveSelectiveColorParams(params)
    const ramp = new Float32Array(N * 3)
    const inputHues = Array.from({ length: N })
    const lab = new Float32Array(3)
    const rgbScratch = new Float32Array(3)
    for (let i = 0; i < N; i++) {
      const h = (i / N) * 2 * Math.PI
      lab[0] = L
      lab[1] = C * Math.cos(h)
      lab[2] = C * Math.sin(h)
      oklabToLinearProPhoto(lab, rgbScratch)
      ramp[3 * i + 0] = rgbScratch[0]
      ramp[3 * i + 1] = rgbScratch[1]
      ramp[3 * i + 2] = rgbScratch[2]
      inputHues[i] = h > Math.PI ? h - 2 * Math.PI : h
    }
    const out = new Float32Array(N * 3)
    applySelectiveColorRow(ramp, out, prepared)
    const shifts = Array.from({ length: N })
    const labOut = new Float32Array(3)
    for (let i = 0; i < N; i++) {
      linearProPhotoToOklab(
        out.subarray(3 * i, 3 * i + 3) as ArrayLike<number>,
        labOut,
      )
      const outHue = Math.atan2(labOut[2], labOut[1])
      shifts[i] = signedHueDelta(inputHues[i], outHue)
    }
    let maxStep = 0
    for (let i = 0; i < N; i++) {
      const j = (i + 1) % N
      const diff = Math.abs(shifts[j] - shifts[i])
      if (diff > maxStep) maxStep = diff
    }
    // Per-step bound ~2e-2 rad accommodates the LUT-256 discretization plus
    // the smoothstep peak slope inside the red bracket. Spec calls this a
    // regression-detecting threshold rather than a fixed physical bound; a
    // gross C¹ violation would push max step well above 0.1.
    expect(maxStep).toBeLessThan(2e-2)
  })
})

describe('selective-color WGSL contract', () => {
  it('samples the 256-entry hue table with wrap-around linear interpolation', () => {
    expect(LUMA_COLOR_SELECTIVE_COLOR_WGSL).toContain(
      'fn sampleSelectiveColorLut(hNorm: f32) -> vec4f',
    )
    expect(LUMA_COLOR_SELECTIVE_COLOR_WGSL).toContain(
      `fract(hNorm) * ${LUT_SIZE.toFixed(1)}`,
    )
    expect(LUMA_COLOR_SELECTIVE_COLOR_WGSL).toContain(
      `let i1 = (i0 + 1u) % ${LUT_SIZE}u;`,
    )
    expect(LUMA_COLOR_SELECTIVE_COLOR_WGSL).toContain('mix(a, b, vec4f(t))')
  })

  it('mirrors the CPU apply algorithm: oklab roundtrip, smoothstep chroma clamp, direct rotation', () => {
    expect(LUMA_COLOR_SELECTIVE_COLOR_WGSL).toContain(
      'fn applyUserSelectiveColor(rgbProPhoto: vec3f) -> vec3f',
    )
    expect(LUMA_COLOR_SELECTIVE_COLOR_WGSL).toContain('linearProPhotoToOklab')
    expect(LUMA_COLOR_SELECTIVE_COLOR_WGSL).toContain('oklabToLinearProPhoto')
    expect(LUMA_COLOR_SELECTIVE_COLOR_WGSL).toMatch(
      /smoothstep\(params\.selectiveColorChromaClamp\.x,\s*params\.selectiveColorChromaClamp\.y/,
    )
    expect(LUMA_COLOR_SELECTIVE_COLOR_WGSL).toContain('atan2(b_val, a_val)')
    // Chroma scale formula matches the CPU 1 + strength * (satMul - 1).
    expect(LUMA_COLOR_SELECTIVE_COLOR_WGSL).toMatch(/mix\(1\.0,\s*\w+\.g/)
    expect(LUMA_COLOR_SELECTIVE_COLOR_WGSL).toMatch(
      /a_val\s*\*\s*cosD\s*-\s*b_val\s*\*\s*sinD/,
    )
  })
})
