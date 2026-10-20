import {
  HDR_GAIN_MAP_ALTERNATE_HEADROOM,
  HDR_GAIN_MAP_BASE_HEADROOM,
  HDR_GAIN_MAP_GAMMA,
  HDR_GAIN_MAP_LOG2_MAX,
  HDR_GAIN_MAP_LOG2_MIN,
  HDR_GAIN_MAP_OFFSET,
} from '@lumaforge/luma-color-runtime'

import { createIccProfile } from './icc-profile'

/**
 * The ISO 21496-1 gain-map JPEG LumaForge writes: the SDR export as the
 * primary image, then the gain map as a second image the primary's MPF
 * (CIPA DC-007) index points at.
 *
 * Primary: SOI, APP0, [APP1 EXIF], APP2 ICC (sRGB), APP2 ISO 21496-1 version,
 * APP2 MPF, then the SDR scan data exactly as the SDR export encodes it.
 * Gain map: SOI, APP0, APP2 ISO 21496-1 metadata, APP2 ICC (BT.2020 linear,
 * the space the gain applies in), then its scan data.
 *
 * Producers keep the primary free of these segments until delivery: they
 * write `primary + gain map container` and record the primary's length
 * (`JpegGainMapLayout`), and the delivery inserts one block after the APP0
 * segments that holds the EXIF, ICC, version, and MPF segments, sized from
 * that layout.
 */

/** Where the gain map container starts in the stored (pre-delivery) bytes. */
export type JpegGainMapLayout = {
  primaryByteLength: number
}

/** The JPEG quality of the gain map image; its chroma is never subsampled. */
export const HDR_GAIN_MAP_JPEG_QUALITY = 0.98

const ISO_21496_1_URN = 'urn:iso:std:iso:ts:21496:-1'
const JPEG_SOI = 0xD8
const JPEG_EOI = 0xD9
const JPEG_APP0 = 0xE0
const JPEG_APP2 = 0xE2
const UINT16_MAX = 0xFF_FF
/** Rationals share one denominator (flag bit 3). */
const ISO_DENOMINATOR = 1 << 20
const ISO_FLAG_MULTICHANNEL = 0x80
const ISO_FLAG_COMMON_DENOMINATOR = 0x08
const GAIN_MAP_CHANNELS = 3

function concat(parts: readonly Uint8Array[]) {
  const length = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function ascii(text: string) {
  return Uint8Array.from(
    Array.from(text, (character) => character.charCodeAt(0)),
  )
}

function nulTerminated(text: string) {
  return concat([ascii(text), Uint8Array.of(0)])
}

function markerSegment(marker: number, payload: Uint8Array) {
  const length = payload.length + 2
  if (length > UINT16_MAX) throw new Error('JPEG_SEGMENT_TOO_LARGE')
  const segment = new Uint8Array(payload.length + 4)
  segment[0] = 0xFF
  segment[1] = marker
  segment[2] = length >> 8
  segment[3] = length & 0xFF
  segment.set(payload, 4)
  return segment
}

function iccSegment(profile: Uint8Array) {
  // One-part profile: sequence number 1 of 1.
  return markerSegment(
    JPEG_APP2,
    concat([nulTerminated('ICC_PROFILE'), Uint8Array.of(1, 1), profile]),
  )
}

const PRIMARY_ICC_SEGMENT = iccSegment(
  createIccProfile({
    description: 'sRGB',
    gamut: 'srgb-rec709',
    transfer: 'srgb',
  }),
)

const GAIN_MAP_ICC_SEGMENT = iccSegment(
  createIccProfile({
    description: 'BT.2020 linear',
    gamut: 'rec2020',
    transfer: 'linear',
  }),
)

/** The primary's ISO 21496-1 segment: versions only (minimum 0, writer 0). */
const ISO_VERSION_SEGMENT = markerSegment(
  JPEG_APP2,
  concat([nulTerminated(ISO_21496_1_URN), Uint8Array.of(0, 0, 0, 0)]),
)

function isoMetadataPayload() {
  const view = new DataView(
    new ArrayBuffer(4 + 1 + 12 + 20 * GAIN_MAP_CHANNELS),
  )
  let offset = 0
  const u8 = (value: number) => view.setUint8(offset++, value)
  const u16 = (value: number) => {
    view.setUint16(offset, value)
    offset += 2
  }
  const u32 = (value: number) => {
    view.setUint32(offset, value)
    offset += 4
  }
  const s32 = (value: number) => {
    view.setInt32(offset, value)
    offset += 4
  }
  const numerator = (value: number) => Math.round(value * ISO_DENOMINATOR)

  u16(0) // minimum_version
  u16(0) // writer_version
  // Gain applied in the alternate space (the gain map's ICC), forward
  // direction: the base is the SDR rendition.
  u8(ISO_FLAG_MULTICHANNEL | ISO_FLAG_COMMON_DENOMINATOR)
  u32(ISO_DENOMINATOR)
  u32(numerator(HDR_GAIN_MAP_BASE_HEADROOM))
  u32(numerator(HDR_GAIN_MAP_ALTERNATE_HEADROOM))
  for (let channel = 0; channel < GAIN_MAP_CHANNELS; channel += 1) {
    s32(numerator(HDR_GAIN_MAP_LOG2_MIN))
    s32(numerator(HDR_GAIN_MAP_LOG2_MAX))
    u32(numerator(HDR_GAIN_MAP_GAMMA))
    s32(numerator(HDR_GAIN_MAP_OFFSET))
    s32(numerator(HDR_GAIN_MAP_OFFSET))
  }
  return new Uint8Array(view.buffer)
}

const ISO_METADATA_SEGMENT = markerSegment(
  JPEG_APP2,
  concat([nulTerminated(ISO_21496_1_URN), isoMetadataPayload()]),
)

const MPF_IDENTIFIER = Uint8Array.of(0x4D, 0x50, 0x46, 0)
/** "MPF\0", TIFF header, IFD of three entries, next-IFD, two MP entries. */
const MPF_PAYLOAD_BYTES = 4 + 8 + 2 + 3 * 12 + 4 + 2 * 16
const MPF_SEGMENT_BYTES = 4 + MPF_PAYLOAD_BYTES
/** From the TIFF header to the MP entries: header, IFD, next-IFD offset. */
const MPF_ENTRIES_OFFSET = 8 + 2 + 3 * 12 + 4
const MP_TYPE_BASELINE_PRIMARY = 0x03_00_00
const TIFF_TYPE_LONG = 4
const TIFF_TYPE_UNDEFINED = 7

function mpfSegment(input: {
  primaryByteLength: number
  gainMapByteLength: number
  /** Gain map start relative to the MPF TIFF header. */
  gainMapOffset: number
}) {
  const view = new DataView(new ArrayBuffer(MPF_PAYLOAD_BYTES))
  let offset = 0
  const u8 = (value: number) => view.setUint8(offset++, value)
  const u16 = (value: number) => {
    view.setUint16(offset, value)
    offset += 2
  }
  const u32 = (value: number) => {
    view.setUint32(offset, value)
    offset += 4
  }

  for (const value of MPF_IDENTIFIER) u8(value)
  // Big-endian TIFF header with the IFD right after it.
  for (const value of [0x4D, 0x4D, 0, 0x2A]) u8(value)
  u32(8)
  u16(3)
  // MPFVersion "0100"
  u16(0xB0_00)
  u16(TIFF_TYPE_UNDEFINED)
  u32(4)
  for (const value of ascii('0100')) u8(value)
  // NumberOfImages
  u16(0xB0_01)
  u16(TIFF_TYPE_LONG)
  u32(1)
  u32(2)
  // MPEntry
  u16(0xB0_02)
  u16(TIFF_TYPE_UNDEFINED)
  u32(2 * 16)
  u32(MPF_ENTRIES_OFFSET)
  u32(0)
  // The primary image: offset 0 by definition.
  u32(MP_TYPE_BASELINE_PRIMARY)
  u32(input.primaryByteLength)
  u32(0)
  u16(0)
  u16(0)
  // The gain map.
  u32(0)
  u32(input.gainMapByteLength)
  u32(input.gainMapOffset)
  u16(0)
  u16(0)
  return markerSegment(JPEG_APP2, new Uint8Array(view.buffer))
}

/** Offset just past SOI and every APP0 segment, or null when malformed. */
function afterApp0Segments(bytes: Uint8Array): number | null {
  if (bytes.length < 2 || bytes[0] !== 0xFF || bytes[1] !== JPEG_SOI) {
    return null
  }
  let offset = 2
  while (
    offset + 4 <= bytes.length &&
    bytes[offset] === 0xFF &&
    bytes[offset + 1] === JPEG_APP0
  ) {
    const length = (bytes[offset + 2] << 8) | bytes[offset + 3]
    if (length < 2) return null
    offset += 2 + length
  }
  return offset <= bytes.length ? offset : null
}

/**
 * The gain map image as stored after the primary: the encoded gain map with
 * its ISO 21496-1 metadata and BT.2020 linear ICC after the APP0 segments.
 */
export function createGainMapContainer(gainMapJpeg: Uint8Array): Uint8Array {
  const insertion = afterApp0Segments(gainMapJpeg)
  if (insertion === null) throw new Error('JPEG_GAIN_MAP_INVALID')
  return concat([
    gainMapJpeg.subarray(0, insertion),
    ISO_METADATA_SEGMENT,
    GAIN_MAP_ICC_SEGMENT,
    gainMapJpeg.subarray(insertion),
  ])
}

/**
 * The segments delivery inserts into the primary at `insertionOffset`, after
 * `leading` (the EXIF segment, when there is one): ICC, ISO 21496-1 version,
 * and the MPF index sized from the stored layout.
 */
export function createGainMapPrimarySegments(input: {
  layout: JpegGainMapLayout
  storedByteLength: number
  insertionOffset: number
  leading: Uint8Array | null
}): Uint8Array {
  const { layout, storedByteLength, insertionOffset } = input
  const gainMapByteLength = storedByteLength - layout.primaryByteLength
  if (
    !Number.isSafeInteger(layout.primaryByteLength) ||
    insertionOffset < 2 ||
    insertionOffset > layout.primaryByteLength ||
    gainMapByteLength <= 0
  ) {
    throw new Error('JPEG_GAIN_MAP_LAYOUT_INVALID')
  }
  const leading = input.leading ?? new Uint8Array(0)
  const beforeMpf = concat([leading, PRIMARY_ICC_SEGMENT, ISO_VERSION_SEGMENT])
  const primaryByteLength =
    layout.primaryByteLength + beforeMpf.length + MPF_SEGMENT_BYTES
  // The TIFF header sits after the APP2 marker, its length, and "MPF\0".
  const tiffHeaderPosition = insertionOffset + beforeMpf.length + 4 + 4
  return concat([
    beforeMpf,
    mpfSegment({
      primaryByteLength,
      gainMapByteLength,
      gainMapOffset: primaryByteLength - tiffHeaderPosition,
    }),
  ])
}

function readSegmentAt(bytes: Uint8Array, offset: number) {
  if (offset + 4 > bytes.length || bytes[offset] !== 0xFF) return null
  const length = (bytes[offset + 2] << 8) | bytes[offset + 3]
  return {
    marker: bytes[offset + 1],
    payload: bytes.subarray(offset + 4, offset + 2 + length),
    end: offset + 2 + length,
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array) {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

function verificationFailed(): never {
  throw new Error('JPEG_GAIN_MAP_VERIFICATION_FAILED')
}

/**
 * Leading bytes that hold every segment the checks read: the APP0 segments,
 * an EXIF segment of at most 64 KiB, and the segments this module writes.
 */
const VERIFIED_HEAD_BYTES = 192 * 1024

/**
 * The primary's ICC, version, and MPF segments, in order after the APP0 (and
 * EXIF) segments, and the gain map position the MPF index records. The index
 * must place the gain map right after the primary and end it at the end of
 * the file.
 */
function verifyPrimaryHead(head: Uint8Array, byteLength: number) {
  let offset = afterApp0Segments(head) ?? verificationFailed()
  let segment = readSegmentAt(head, offset) ?? verificationFailed()
  if (segment.marker === 0xE1) {
    offset = segment.end
    segment = readSegmentAt(head, offset) ?? verificationFailed()
  }
  for (const expected of [PRIMARY_ICC_SEGMENT, ISO_VERSION_SEGMENT]) {
    if (!equalBytes(head.subarray(offset, segment.end), expected)) {
      verificationFailed()
    }
    offset = segment.end
    segment = readSegmentAt(head, offset) ?? verificationFailed()
  }
  const mpf = segment.payload
  if (
    segment.marker !== JPEG_APP2 ||
    mpf.length !== MPF_PAYLOAD_BYTES ||
    !equalBytes(mpf.subarray(0, 4), MPF_IDENTIFIER)
  ) {
    verificationFailed()
  }
  const view = new DataView(mpf.buffer, mpf.byteOffset, mpf.byteLength)
  const entries = MPF_IDENTIFIER.length + MPF_ENTRIES_OFFSET
  const primaryByteLength = view.getUint32(entries + 4)
  const gainMapByteLength = view.getUint32(entries + 16 + 4)
  const gainMapStart = offset + 8 + view.getUint32(entries + 16 + 8)
  if (
    view.getUint32(entries) !== MP_TYPE_BASELINE_PRIMARY ||
    primaryByteLength <= segment.end ||
    gainMapStart !== primaryByteLength ||
    primaryByteLength + gainMapByteLength !== byteLength
  ) {
    verificationFailed()
  }
  return primaryByteLength
}

function verifyEndOfImage(lastTwoBytes: Uint8Array) {
  if (lastTwoBytes[0] !== 0xFF || lastTwoBytes[1] !== JPEG_EOI) {
    verificationFailed()
  }
}

/** The gain map's SOI, APP0, then its ISO 21496-1 metadata and its ICC. */
function verifyGainMapHead(head: Uint8Array) {
  let offset = afterApp0Segments(head) ?? verificationFailed()
  for (const expected of [ISO_METADATA_SEGMENT, GAIN_MAP_ICC_SEGMENT]) {
    const segment = readSegmentAt(head, offset) ?? verificationFailed()
    if (!equalBytes(head.subarray(offset, segment.end), expected)) {
      verificationFailed()
    }
    offset = segment.end
  }
}

/**
 * Whether delivered bytes are the gain-map JPEG this module writes. Fails
 * closed: a file a decoder would show only as its SDR image is not delivered
 * as an HDR export.
 */
export function assertGainMapJpeg(bytes: Uint8Array): void {
  const primaryByteLength = verifyPrimaryHead(
    bytes.subarray(0, VERIFIED_HEAD_BYTES),
    bytes.length,
  )
  verifyEndOfImage(bytes.subarray(primaryByteLength - 2, primaryByteLength))
  verifyEndOfImage(bytes.subarray(bytes.length - 2))
  verifyGainMapHead(
    bytes.subarray(primaryByteLength, primaryByteLength + VERIFIED_HEAD_BYTES),
  )
}

/** Delivered bytes read by range, so a large file is never loaded whole. */
export type GainMapJpegSource = {
  byteLength: number
  read: (start: number, end: number) => Promise<Uint8Array>
}

/** `assertGainMapJpeg` over ranged reads. */
export async function verifyGainMapJpeg(
  source: GainMapJpegSource,
): Promise<void> {
  const { byteLength, read } = source
  const primaryByteLength = verifyPrimaryHead(
    await read(0, Math.min(byteLength, VERIFIED_HEAD_BYTES)),
    byteLength,
  )
  verifyEndOfImage(await read(primaryByteLength - 2, primaryByteLength))
  verifyEndOfImage(await read(byteLength - 2, byteLength))
  verifyGainMapHead(
    await read(
      primaryByteLength,
      Math.min(byteLength, primaryByteLength + VERIFIED_HEAD_BYTES),
    ),
  )
}
