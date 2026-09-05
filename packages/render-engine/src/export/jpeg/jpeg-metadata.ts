import { createStreamingSha256 } from '../../manifest/streaming-sha256'

export type JpegExportMetadata = {
  make?: string
  model?: string
  lens?: string
  iso?: number
  aperture?: number
  focalLength?: number
  shutter?: number
  shutterSpeed?: string
  timestamp?: number | Date
}

export type PreserveJpegMetadataInput = {
  jpeg: Blob
  metadata?: JpegExportMetadata | null
  width: number
  height: number
}

type TiffEntry = {
  tag: number
  type: number
  count: number
  value: Uint8Array
}

const TYPE_ASCII = 2
const TYPE_SHORT = 3
const TYPE_LONG = 4
const TYPE_RATIONAL = 5
const TYPE_UNDEFINED = 7

const IFD0_OFFSET = 8
const EXIF_HEADER = new Uint8Array([69, 120, 105, 102, 0, 0])
const LITTLE_ENDIAN_MARK = 18_761
const TIFF_MAGIC = 42
const JPEG_SOI = 216
const JPEG_APP0 = 224
const JPEG_APP1 = 225
const UINT16_MAX = 65_535
const UINT32_MAX = 4_294_967_295

const TAG_MAKE = 271
const TAG_MODEL = 272
const TAG_ORIENTATION = 274
const TAG_SOFTWARE = 305
const TAG_DATETIME = 306
const TAG_EXIF_IFD_POINTER = 34_665
const TAG_EXPOSURE_TIME = 33_434
const TAG_F_NUMBER = 33_437
const TAG_ISO_SPEED_RATINGS = 34_855
const TAG_EXIF_VERSION = 36_864
const TAG_DATETIME_ORIGINAL = 36_867
const TAG_DATETIME_DIGITIZED = 36_868
const TAG_FOCAL_LENGTH = 37_386
const TAG_COLOR_SPACE = 40_961
const TAG_PIXEL_X_DIMENSION = 40_962
const TAG_PIXEL_Y_DIMENSION = 40_963
const TAG_LENS_MODEL = 42_036

function isPositiveFinite(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function gcd(left: number, right: number): number {
  let a = Math.abs(left)
  let b = Math.abs(right)

  while (b !== 0) {
    const next = a % b
    a = b
    b = next
  }

  return a || 1
}

function toRationalBytes(value: number, scale = 1_000_000) {
  if (!isPositiveFinite(value)) return null

  const denominator = scale
  const numerator = Math.round(value * denominator)
  if (numerator <= 0) return null

  const divisor = gcd(numerator, denominator)
  const reducedNumerator = numerator / divisor
  const reducedDenominator = denominator / divisor
  if (reducedNumerator > UINT32_MAX || reducedDenominator > UINT32_MAX) {
    return null
  }

  const bytes = new Uint8Array(8)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, reducedNumerator, true)
  view.setUint32(4, reducedDenominator, true)
  return bytes
}

function shortBytes(value: number) {
  const bytes = new Uint8Array(2)
  new DataView(bytes.buffer).setUint16(0, value, true)
  return bytes
}

function longBytes(value: number) {
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setUint32(0, value, true)
  return bytes
}

function asciiBytes(value: string) {
  const trimmed = value.trim().slice(0, 512)
  let normalized = ''

  for (let index = 0; index < trimmed.length; index += 1) {
    const code = trimmed.charCodeAt(index)
    normalized += code < 32 || code === 127 ? ' ' : trimmed[index]
  }

  if (!normalized) return null

  const bytes = new Uint8Array(normalized.length + 1)
  for (let index = 0; index < normalized.length; index += 1) {
    const code = normalized.charCodeAt(index)
    bytes[index] = code >= 32 && code <= 126 ? code : 63
  }
  return bytes
}

function undefinedBytes(value: string) {
  const bytes = new Uint8Array(value.length)
  for (let index = 0; index < value.length; index += 1) {
    bytes[index] = value.charCodeAt(index) & 255
  }
  return bytes
}

function addAsciiEntry(entries: TiffEntry[], tag: number, value?: string) {
  if (!value) return
  const bytes = asciiBytes(value)
  if (!bytes) return
  entries.push({ tag, type: TYPE_ASCII, count: bytes.length, value: bytes })
}

function addShortEntry(entries: TiffEntry[], tag: number, value?: number) {
  if (!isPositiveFinite(value) || value > UINT16_MAX) return
  entries.push({ tag, type: TYPE_SHORT, count: 1, value: shortBytes(value) })
}

function addLongEntry(entries: TiffEntry[], tag: number, value?: number) {
  if (!isPositiveFinite(value) || value > UINT32_MAX) return
  entries.push({ tag, type: TYPE_LONG, count: 1, value: longBytes(value) })
}

function addRationalEntry(
  entries: TiffEntry[],
  tag: number,
  value?: number,
  scale?: number,
) {
  if (!isPositiveFinite(value)) return
  const bytes = toRationalBytes(value, scale)
  if (!bytes) return
  entries.push({ tag, type: TYPE_RATIONAL, count: 1, value: bytes })
}

function addUndefinedEntry(entries: TiffEntry[], tag: number, value: string) {
  const bytes = undefinedBytes(value)
  entries.push({ tag, type: TYPE_UNDEFINED, count: bytes.length, value: bytes })
}

function parseShutterSeconds(metadata: JpegExportMetadata) {
  if (isPositiveFinite(metadata.shutter)) {
    return metadata.shutter
  }

  const shutterSpeed = metadata.shutterSpeed?.trim().replace(/s$/i, '')
  if (!shutterSpeed) return undefined

  const fraction = shutterSpeed.match(
    /^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/,
  )
  if (fraction) {
    const numerator = Number(fraction[1])
    const denominator = Number(fraction[2])
    return isPositiveFinite(numerator) && isPositiveFinite(denominator)
      ? numerator / denominator
      : undefined
  }

  const decimal = Number(shutterSpeed)
  return isPositiveFinite(decimal) ? decimal : undefined
}

function resolveTimestamp(value: JpegExportMetadata['timestamp']) {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value : null
  }

  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null
  }

  return new Date(value < 10_000_000_000 ? value * 1000 : value)
}

function pad(value: number) {
  return String(value).padStart(2, '0')
}

function formatExifDate(date: Date | null) {
  if (!date) return undefined

  return `${date.getUTCFullYear()}:${pad(date.getUTCMonth() + 1)}:${pad(
    date.getUTCDate(),
  )} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(
    date.getUTCSeconds(),
  )}`
}

function sortedEntries(entries: TiffEntry[]) {
  return [...entries].sort((left, right) => left.tag - right.tag)
}

function ifdTableSize(entryCount: number) {
  return 2 + entryCount * 12 + 4
}

function externalDataSize(entries: TiffEntry[]) {
  return entries.reduce(
    (total, entry) => total + (entry.value.length > 4 ? entry.value.length : 0),
    0,
  )
}

function writeEntry(
  view: DataView,
  bytes: Uint8Array,
  entryOffset: number,
  entry: TiffEntry,
  valueOffset: number,
) {
  view.setUint16(entryOffset, entry.tag, true)
  view.setUint16(entryOffset + 2, entry.type, true)
  view.setUint32(entryOffset + 4, entry.count, true)

  if (entry.value.length <= 4) {
    bytes.set(entry.value, entryOffset + 8)
    return valueOffset
  }

  view.setUint32(entryOffset + 8, valueOffset, true)
  bytes.set(entry.value, valueOffset)
  return valueOffset + entry.value.length
}

function writeIfd(
  view: DataView,
  bytes: Uint8Array,
  offset: number,
  entries: TiffEntry[],
  valueOffset: number,
) {
  view.setUint16(offset, entries.length, true)
  let nextValueOffset = valueOffset

  entries.forEach((entry, index) => {
    nextValueOffset = writeEntry(
      view,
      bytes,
      offset + 2 + index * 12,
      entry,
      nextValueOffset,
    )
  })

  view.setUint32(offset + 2 + entries.length * 12, 0, true)
  return nextValueOffset
}

type ExifBuildInput = {
  metadata?: JpegExportMetadata | null
  width: number
  height: number
}

function createExifPayload(input: ExifBuildInput) {
  const metadata = input.metadata ?? {}
  const dateTime = formatExifDate(resolveTimestamp(metadata.timestamp))
  const ifd0Entries: TiffEntry[] = []
  const exifEntries: TiffEntry[] = []

  addAsciiEntry(ifd0Entries, TAG_MAKE, metadata.make)
  addAsciiEntry(ifd0Entries, TAG_MODEL, metadata.model)
  addShortEntry(ifd0Entries, TAG_ORIENTATION, 1)
  addAsciiEntry(ifd0Entries, TAG_SOFTWARE, 'LumaForge')
  addAsciiEntry(ifd0Entries, TAG_DATETIME, dateTime)

  addRationalEntry(
    exifEntries,
    TAG_EXPOSURE_TIME,
    parseShutterSeconds(metadata),
  )
  addRationalEntry(exifEntries, TAG_F_NUMBER, metadata.aperture, 100)
  addShortEntry(exifEntries, TAG_ISO_SPEED_RATINGS, metadata.iso)
  addUndefinedEntry(exifEntries, TAG_EXIF_VERSION, '0231')
  addAsciiEntry(exifEntries, TAG_DATETIME_ORIGINAL, dateTime)
  addAsciiEntry(exifEntries, TAG_DATETIME_DIGITIZED, dateTime)
  addRationalEntry(exifEntries, TAG_FOCAL_LENGTH, metadata.focalLength, 100)
  addShortEntry(exifEntries, TAG_COLOR_SPACE, 1)
  addLongEntry(exifEntries, TAG_PIXEL_X_DIMENSION, input.width)
  addLongEntry(exifEntries, TAG_PIXEL_Y_DIMENSION, input.height)
  addAsciiEntry(exifEntries, TAG_LENS_MODEL, metadata.lens)

  if (exifEntries.length > 0) {
    ifd0Entries.push({
      tag: TAG_EXIF_IFD_POINTER,
      type: TYPE_LONG,
      count: 1,
      value: longBytes(0),
    })
  }

  const sortedIfd0 = sortedEntries(ifd0Entries)
  const sortedExif = sortedEntries(exifEntries)
  const ifd0ExternalOffset = IFD0_OFFSET + ifdTableSize(sortedIfd0.length)
  const exifIfdOffset =
    ifd0ExternalOffset +
    externalDataSize(
      sortedIfd0.filter((entry) => entry.tag !== TAG_EXIF_IFD_POINTER),
    )

  const entriesWithExifPointer = sortedIfd0.map((entry) =>
    entry.tag === TAG_EXIF_IFD_POINTER
      ? { ...entry, value: longBytes(exifIfdOffset) }
      : entry,
  )
  const exifExternalOffset = exifIfdOffset + ifdTableSize(sortedExif.length)
  const totalSize = exifExternalOffset + externalDataSize(sortedExif)
  const tiff = new Uint8Array(totalSize)
  const view = new DataView(tiff.buffer)

  view.setUint16(0, LITTLE_ENDIAN_MARK, true)
  view.setUint16(2, TIFF_MAGIC, true)
  view.setUint32(4, IFD0_OFFSET, true)
  writeIfd(view, tiff, IFD0_OFFSET, entriesWithExifPointer, ifd0ExternalOffset)

  if (sortedExif.length > 0) {
    writeIfd(view, tiff, exifIfdOffset, sortedExif, exifExternalOffset)
  }

  const payload = new Uint8Array(EXIF_HEADER.length + tiff.length)
  payload.set(EXIF_HEADER, 0)
  payload.set(tiff, EXIF_HEADER.length)
  return payload
}

function createApp1ExifSegment(input: ExifBuildInput) {
  const payload = createExifPayload(input)
  const length = payload.length + 2
  if (length > UINT16_MAX) return null

  const segment = new Uint8Array(payload.length + 4)
  segment[0] = 255
  segment[1] = JPEG_APP1
  segment[2] = length >> 8
  segment[3] = length & 255
  segment.set(payload, 4)
  return segment
}

async function readBlobHead(blob: Blob) {
  const reader = blob.slice(0, Math.min(blob.size, 65536))

  if (typeof reader.arrayBuffer === 'function') {
    return new Uint8Array(await reader.arrayBuffer())
  }

  if (typeof FileReader === 'undefined') {
    throw new TypeError('JPEG_METADATA_BLOB_READ_UNAVAILABLE')
  }

  return await new Promise<Uint8Array>((resolve, reject) => {
    const fileReader = new FileReader()
    fileReader.onload = () => {
      if (fileReader.result instanceof ArrayBuffer) {
        resolve(new Uint8Array(fileReader.result))
        return
      }

      reject(new Error('JPEG_METADATA_BLOB_READ_FAILED'))
    }
    fileReader.onerror = () =>
      reject(fileReader.error ?? new Error('JPEG_METADATA_BLOB_READ_FAILED'))
    fileReader.readAsArrayBuffer(reader)
  })
}

function segmentTotalLength(bytes: Uint8Array, offset: number) {
  if (offset + 4 > bytes.length) return null
  const length = (bytes[offset + 2] << 8) | bytes[offset + 3]
  if (length < 2) return null
  return length + 2
}

function findJpegMetadataInsertionOffset(bytes: Uint8Array, fullSize: number) {
  if (bytes.length < 2 || bytes[0] !== 255 || bytes[1] !== JPEG_SOI) {
    return null
  }

  let offset = 2
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 255) return offset
    const marker = bytes[offset + 1]
    if (marker !== JPEG_APP0) return offset

    const length = segmentTotalLength(bytes, offset)
    if (length === null) return null
    offset += length
  }

  return offset <= fullSize ? offset : null
}

/**
 * Where and what to insert so a JPEG carries the export metadata. The plan is
 * derived from the leading marker segments only, so producers can compute the
 * identity of the delivered bytes (`sha256OfJpegWithMetadata`) without
 * materializing a second copy of the file.
 */
export type JpegMetadataInjectionPlan = {
  insertionOffset: number
  segment: Uint8Array
}

export function planJpegMetadataInjection({
  header,
  fullSize,
  metadata,
  width,
  height,
}: {
  /** Leading bytes of the JPEG (at least the SOI and APP0 segments). */
  header: Uint8Array
  fullSize: number
  metadata?: JpegExportMetadata | null
  width: number
  height: number
}): JpegMetadataInjectionPlan | null {
  const segment = createApp1ExifSegment({ metadata, width, height })
  if (!segment) return null
  const insertionOffset = findJpegMetadataInsertionOffset(header, fullSize)
  if (insertionOffset === null) return null
  return { insertionOffset, segment }
}

/** SHA-256 of `jpeg` as it will be delivered once `plan` is applied. */
export function sha256OfJpegWithMetadata(
  jpeg: Uint8Array,
  plan: JpegMetadataInjectionPlan | null,
): string {
  const hasher = createStreamingSha256()
  if (!plan) {
    hasher.update(jpeg)
    return hasher.digestHex()
  }
  hasher.update(jpeg.subarray(0, plan.insertionOffset))
  hasher.update(plan.segment)
  hasher.update(jpeg.subarray(plan.insertionOffset))
  return hasher.digestHex()
}

export async function preserveJpegMetadata({
  jpeg,
  metadata,
  width,
  height,
}: PreserveJpegMetadataInput) {
  if (!createApp1ExifSegment({ metadata, width, height })) return jpeg

  const header = await readBlobHead(jpeg)
  const plan = planJpegMetadataInjection({
    header,
    fullSize: jpeg.size,
    metadata,
    width,
    height,
  })
  if (!plan) return jpeg

  return new Blob(
    [
      jpeg.slice(0, plan.insertionOffset),
      plan.segment as BlobPart,
      jpeg.slice(plan.insertionOffset),
    ],
    { type: jpeg.type || 'image/jpeg' },
  )
}

export type PreserveJpegMetadataBytesInput = {
  jpeg: Uint8Array
  metadata?: JpegExportMetadata | null
  width: number
  height: number
}

export function preserveJpegMetadataBytes({
  jpeg,
  metadata,
  width,
  height,
}: PreserveJpegMetadataBytesInput): Uint8Array {
  const plan = planJpegMetadataInjection({
    header: jpeg.subarray(0, Math.min(jpeg.length, JPEG_HEADER_SCAN_BYTES)),
    fullSize: jpeg.length,
    metadata,
    width,
    height,
  })
  if (!plan) return jpeg

  const result = new Uint8Array(jpeg.length + plan.segment.length)
  result.set(jpeg.subarray(0, plan.insertionOffset), 0)
  result.set(plan.segment, plan.insertionOffset)
  result.set(
    jpeg.subarray(plan.insertionOffset),
    plan.insertionOffset + plan.segment.length,
  )
  return result
}

/** Leading bytes that can hold every APP0 segment a JPEG encoder emits. */
export const JPEG_HEADER_SCAN_BYTES = 65536
