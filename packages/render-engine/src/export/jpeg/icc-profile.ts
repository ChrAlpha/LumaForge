import type { ColorGamutId } from '@lumaforge/luma-color-runtime'
import { getColorGamut } from '@lumaforge/luma-color-runtime'

/**
 * A minimal ICC v4.4 display profile: RGB matrix and parametric curves, plus
 * the `cicp` tag that names the same space by its ITU-T H.273 code points.
 * The bytes are deterministic (fixed date, no profile ID), so the delivered
 * file hashes the same every time.
 */

export type IccTransfer = 'srgb' | 'linear'

export type IccProfileInput = {
  description: string
  gamut: Extract<ColorGamutId, 'srgb-rec709' | 'rec2020'>
  transfer: IccTransfer
}

/** H.273 colour primaries and transfer characteristics of each profile. */
const CICP_PRIMARIES: Record<IccProfileInput['gamut'], number> = {
  'srgb-rec709': 1,
  rec2020: 9,
}
const CICP_TRANSFER: Record<IccTransfer, number> = { srgb: 13, linear: 8 }

/** Parametric curve type 3 (IEC 61966-2-1) and type 0 (gamma 1). */
const PARAMETRIC_CURVES: Record<
  IccTransfer,
  { type: number; params: readonly number[] }
> = {
  srgb: {
    type: 3,
    params: [2.4, 1 / 1.055, 0.055 / 1.055, 1 / 12.92, 0.04045],
  },
  linear: { type: 0, params: [1] },
}

const D50_XYZ = [0.9642, 1, 0.8249] as const
const BRADFORD = [
  0.8951, 0.2664, -0.1614, -0.7502, 1.7135, 0.0367, 0.0389, -0.0685, 1.0296,
] as const

type Matrix = readonly number[]
type Vector = readonly [number, number, number]

function multiply(left: Matrix, right: Matrix): number[] {
  const out = [0, 0, 0, 0, 0, 0, 0, 0, 0]
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      for (let k = 0; k < 3; k += 1) {
        out[row * 3 + column] += left[row * 3 + k] * right[k * 3 + column]
      }
    }
  }
  return out
}

function apply(matrix: Matrix, vector: Vector): Vector {
  return [0, 1, 2].map(
    (row) =>
      matrix[row * 3] * vector[0] +
      matrix[row * 3 + 1] * vector[1] +
      matrix[row * 3 + 2] * vector[2],
  ) as unknown as Vector
}

function invert(m: Matrix): number[] {
  const [a, b, c, d, e, f, g, h, i] = m
  const A = e * i - f * h
  const B = -(d * i - f * g)
  const C = d * h - e * g
  const determinant = a * A + b * B + c * C
  return [
    A,
    -(b * i - c * h),
    b * f - c * e,
    B,
    a * i - c * g,
    -(a * f - c * d),
    C,
    -(a * h - b * g),
    a * e - b * d,
  ].map((value) => value / determinant)
}

function xyToXyz([x, y]: readonly [number, number]): Vector {
  return [x / y, 1, (1 - x - y) / y]
}

function colorGamut(gamut: IccProfileInput['gamut']) {
  const found = getColorGamut(gamut)
  if (!found) throw new Error(`Unknown color gamut: ${gamut}`)
  return found
}

/** RGB to PCS XYZ (D50), Bradford-adapted from the space's own white. */
function rgbToPcsXyz(gamut: IccProfileInput['gamut']): number[] {
  const { primaries, whitePoint } = colorGamut(gamut)
  const [red, green, blue] = [
    primaries.red,
    primaries.green,
    primaries.blue,
  ].map((primary) => xyToXyz(primary))
  const primaryMatrix = [
    red[0],
    green[0],
    blue[0],
    red[1],
    green[1],
    blue[1],
    red[2],
    green[2],
    blue[2],
  ]
  const white = xyToXyz(whitePoint)
  const scale = apply(invert(primaryMatrix), white)
  const toXyz = primaryMatrix.map((value, index) => value * scale[index % 3])
  return multiply(chromaticAdaptation(white), toXyz)
}

function chromaticAdaptation(sourceWhite: Vector): number[] {
  const source = apply(BRADFORD, sourceWhite)
  const destination = apply(BRADFORD, D50_XYZ)
  const diagonal = [
    destination[0] / source[0],
    0,
    0,
    0,
    destination[1] / source[1],
    0,
    0,
    0,
    destination[2] / source[2],
  ]
  return multiply(invert(BRADFORD), multiply(diagonal, BRADFORD))
}

class IccWriter {
  private readonly bytes: number[] = []

  get length() {
    return this.bytes.length
  }

  u8(value: number) {
    this.bytes.push(value & 0xFF)
  }

  u16(value: number) {
    this.u8(value >> 8)
    this.u8(value)
  }

  u32(value: number) {
    this.u16(value >>> 16)
    this.u16(value & 0xFFFF)
  }

  s15Fixed16(value: number) {
    this.u32((Math.round(value * 65_536) | 0) >>> 0)
  }

  signature(text: string) {
    for (const character of text) this.u8(character.charCodeAt(0))
  }

  pad() {
    while (this.bytes.length % 4 !== 0) this.u8(0)
  }

  zeros(count: number) {
    for (let index = 0; index < count; index += 1) this.u8(0)
  }

  append(bytes: Uint8Array) {
    for (const value of bytes) this.u8(value)
  }

  toBytes() {
    return Uint8Array.from(this.bytes)
  }
}

function tag(write: (writer: IccWriter) => void) {
  const writer = new IccWriter()
  write(writer)
  writer.pad()
  return writer.toBytes()
}

function multiLocalizedText(text: string) {
  return tag((writer) => {
    writer.signature('mluc')
    writer.u32(0)
    writer.u32(1)
    writer.u32(12)
    writer.signature('enUS')
    writer.u32(text.length * 2)
    writer.u32(28)
    for (const character of text) writer.u16(character.charCodeAt(0))
  })
}

function xyzTag(xyz: readonly number[]) {
  return tag((writer) => {
    writer.signature('XYZ ')
    writer.u32(0)
    for (const value of xyz) writer.s15Fixed16(value)
  })
}

function s15Fixed16ArrayTag(values: readonly number[]) {
  return tag((writer) => {
    writer.signature('sf32')
    writer.u32(0)
    for (const value of values) writer.s15Fixed16(value)
  })
}

function parametricCurveTag(transfer: IccTransfer) {
  const curve = PARAMETRIC_CURVES[transfer]
  return tag((writer) => {
    writer.signature('para')
    writer.u32(0)
    writer.u16(curve.type)
    writer.u16(0)
    for (const value of curve.params) writer.s15Fixed16(value)
  })
}

function cicpTag(input: IccProfileInput) {
  return tag((writer) => {
    writer.signature('cicp')
    writer.u32(0)
    writer.u8(CICP_PRIMARIES[input.gamut])
    writer.u8(CICP_TRANSFER[input.transfer])
    // Matrix coefficients 0 (RGB), full range.
    writer.u8(0)
    writer.u8(1)
  })
}

const ICC_HEADER_BYTES = 128
const ICC_VERSION_4_4 = 0x04_40_00_00

export function createIccProfile(input: IccProfileInput): Uint8Array {
  const toPcs = rgbToPcsXyz(input.gamut)
  const curve = parametricCurveTag(input.transfer)
  const tags: Array<[string, Uint8Array]> = [
    ['desc', multiLocalizedText(input.description)],
    ['cprt', multiLocalizedText('No copyright, use freely')],
    ['wtpt', xyzTag(D50_XYZ)],
    [
      'chad',
      s15Fixed16ArrayTag(
        chromaticAdaptation(xyToXyz(colorGamut(input.gamut).whitePoint)),
      ),
    ],
    ['rXYZ', xyzTag([toPcs[0], toPcs[3], toPcs[6]])],
    ['gXYZ', xyzTag([toPcs[1], toPcs[4], toPcs[7]])],
    ['bXYZ', xyzTag([toPcs[2], toPcs[5], toPcs[8]])],
    ['rTRC', curve],
    ['gTRC', curve],
    ['bTRC', curve],
    ['cicp', cicpTag(input)],
  ]

  // The three TRC tags share one curve's bytes.
  const offsets = new Map<Uint8Array, number>()
  const blobs: Uint8Array[] = []
  let cursor = ICC_HEADER_BYTES + 4 + tags.length * 12
  for (const [, data] of tags) {
    if (offsets.has(data)) continue
    offsets.set(data, cursor)
    blobs.push(data)
    cursor += data.length
  }
  const size = cursor

  const writer = new IccWriter()
  writer.u32(size)
  writer.u32(0)
  writer.u32(ICC_VERSION_4_4)
  writer.signature('mntr')
  writer.signature('RGB ')
  writer.signature('XYZ ')
  for (const part of [2026, 1, 1, 0, 0, 0]) writer.u16(part)
  writer.signature('acsp')
  // Platform, flags, manufacturer, model, attributes (8 bytes), intent.
  writer.zeros(28)
  for (const value of D50_XYZ) writer.s15Fixed16(value)
  // Creator, profile ID (none), reserved.
  writer.zeros(4 + 16 + 28)
  writer.u32(tags.length)
  for (const [signature, data] of tags) {
    writer.signature(signature)
    writer.u32(offsets.get(data)!)
    writer.u32(data.length)
  }
  for (const blob of blobs) writer.append(blob)

  if (writer.length !== size) {
    throw new Error('ICC_PROFILE_SIZE_MISMATCH')
  }
  return writer.toBytes()
}
