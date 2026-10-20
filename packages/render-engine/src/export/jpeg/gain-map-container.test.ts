import {
  HDR_GAIN_MAP_ALTERNATE_HEADROOM,
  HDR_GAIN_MAP_LOG2_MAX,
  HDR_GAIN_MAP_LOG2_MIN,
  HDR_GAIN_MAP_OFFSET,
} from '@lumaforge/luma-color-runtime'
import { describe, expect, it } from 'vitest'

import {
  assertGainMapJpeg,
  createGainMapContainer,
  verifyGainMapJpeg,
} from './gain-map-container'
import { createIccProfile } from './icc-profile'
import {
  planJpegMetadataInjection,
  preserveJpegMetadata,
  preserveJpegMetadataBytes,
} from './jpeg-metadata'

const APP0_JFIF = Uint8Array.of(
  0xFF,
  0xE0,
  0x00,
  0x10,
  0x4A,
  0x46,
  0x49,
  0x46,
  0x00,
  0x01,
  0x01,
  0x00,
  0x00,
  0x01,
  0x00,
  0x01,
  0x00,
  0x00,
)

/** SOI, JFIF APP0, a stand-in for the tables and scan, EOI. */
function fakeJpeg(scan: number[]) {
  return Uint8Array.from([
    0xFF,
    0xD8,
    ...APP0_JFIF,
    0xFF,
    0xDB,
    ...scan,
    0xFF,
    0xD9,
  ])
}

function concat(...parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

const primary = fakeJpeg([1, 2, 3, 4, 5, 6, 7, 8])
const gainMap = fakeJpeg([9, 10, 11])
const stored = concat(primary, createGainMapContainer(gainMap))
const layout = { primaryByteLength: primary.length }
const metadata = { make: 'Test', model: 'Camera', iso: 100 }

function deliver(withMetadata: boolean) {
  return preserveJpegMetadataBytes({
    jpeg: stored,
    metadata: withMetadata ? metadata : null,
    width: 4,
    height: 2,
    gainMap: layout,
  })
}

/** The APP2 payloads of the first image, keyed by identifier. */
function app2Segments(bytes: Uint8Array) {
  const segments: Uint8Array[] = []
  let offset = 2
  while (bytes[offset] === 0xFF && bytes[offset + 1] >= 0xE0) {
    const length = (bytes[offset + 2] << 8) | bytes[offset + 3]
    if (bytes[offset + 1] === 0xE2) {
      segments.push(bytes.subarray(offset + 4, offset + 2 + length))
    }
    offset += 2 + length
  }
  return segments
}

function readMpf(delivered: Uint8Array) {
  let offset = 2
  while (delivered[offset] === 0xFF && delivered[offset + 1] >= 0xE0) {
    const length = (delivered[offset + 2] << 8) | delivered[offset + 3]
    const payload = delivered.subarray(offset + 4, offset + 2 + length)
    if (String.fromCharCode(...payload.subarray(0, 3)) === 'MPF') {
      const view = new DataView(payload.buffer, payload.byteOffset)
      const tiff = offset + 8
      return {
        primarySize: view.getUint32(4 + 50 + 4),
        gainMapSize: view.getUint32(4 + 50 + 16 + 4),
        gainMapStart: tiff + view.getUint32(4 + 50 + 16 + 8),
      }
    }
    offset += 2 + length
  }
  throw new Error('no MPF segment')
}

describe('createIccProfile', () => {
  it('writes the same ICC v4.4 bytes every time, with a cicp tag', () => {
    const profile = createIccProfile({
      description: 'BT.2020 linear',
      gamut: 'rec2020',
      transfer: 'linear',
    })
    const view = new DataView(profile.buffer)

    expect(view.getUint32(0)).toBe(profile.length)
    expect(view.getUint32(8)).toBe(0x04_40_00_00)
    expect(String.fromCharCode(...profile.subarray(36, 40))).toBe('acsp')
    expect(profile).toEqual(
      createIccProfile({
        description: 'BT.2020 linear',
        gamut: 'rec2020',
        transfer: 'linear',
      }),
    )
    const tagCount = view.getUint32(128)
    const tags = new Map<string, Uint8Array>()
    for (let index = 0; index < tagCount; index += 1) {
      const entry = 132 + index * 12
      const signature = String.fromCharCode(
        ...profile.subarray(entry, entry + 4),
      )
      const offset = view.getUint32(entry + 4)
      tags.set(
        signature,
        profile.subarray(offset, offset + view.getUint32(entry + 8)),
      )
    }
    expect(Array.from(tags.get('cicp')!.subarray(8, 12))).toEqual([9, 8, 0, 1])
    // The primaries add up to the PCS white (D50).
    const white = [0, 0, 0]
    for (const signature of ['rXYZ', 'gXYZ', 'bXYZ']) {
      const xyz = new DataView(tags.get(signature)!.slice().buffer)
      for (let axis = 0; axis < 3; axis += 1) {
        white[axis] += xyz.getInt32(8 + axis * 4) / 65_536
      }
    }
    expect(white[0]).toBeCloseTo(0.9642, 3)
    expect(white[1]).toBeCloseTo(1, 3)
    expect(white[2]).toBeCloseTo(0.8249, 3)
  })
})

describe('gain-map JPEG delivery', () => {
  it('indexes the gain map right after the primary and its EXIF', () => {
    for (const withMetadata of [false, true]) {
      const delivered = deliver(withMetadata)
      const mpf = readMpf(delivered)
      const inserted = delivered.length - stored.length

      expect(mpf.primarySize).toBe(primary.length + inserted)
      expect(mpf.gainMapStart).toBe(mpf.primarySize)
      expect(mpf.primarySize + mpf.gainMapSize).toBe(delivered.length)
      expect(
        Array.from(delivered.subarray(mpf.gainMapStart, mpf.gainMapStart + 2)),
      ).toEqual([0xFF, 0xD8])
      expect(() => assertGainMapJpeg(delivered)).not.toThrow()
      // Everything after the inserted block is the stored bytes unchanged.
      const insertionOffset = 2 + APP0_JFIF.length
      expect(delivered.subarray(insertionOffset + inserted)).toEqual(
        stored.subarray(insertionOffset),
      )
      expect(delivered[insertionOffset + 1]).toBe(0xE1)
    }
  })

  it('records the gain map metadata the color runtime defines', () => {
    const delivered = deliver(false)
    const iso = app2Segments(
      delivered.subarray(readMpf(delivered).gainMapStart),
    ).find((payload) =>
      String.fromCharCode(...payload.subarray(0, 27)).startsWith('urn:iso'),
    )!
    const view = new DataView(iso.buffer, iso.byteOffset + 28)
    const denominator = view.getUint32(5)
    const rational = (offset: number) => view.getInt32(offset) / denominator

    expect(view.getUint8(4)).toBe(0x80 | 0x08)
    expect(rational(9)).toBe(0)
    expect(rational(13)).toBeCloseTo(HDR_GAIN_MAP_ALTERNATE_HEADROOM, 5)
    for (let channel = 0; channel < 3; channel += 1) {
      const base = 17 + channel * 20
      expect(rational(base)).toBeCloseTo(HDR_GAIN_MAP_LOG2_MIN, 5)
      expect(rational(base + 4)).toBeCloseTo(HDR_GAIN_MAP_LOG2_MAX, 5)
      expect(rational(base + 8)).toBe(1)
      expect(rational(base + 12)).toBeCloseTo(HDR_GAIN_MAP_OFFSET, 5)
      expect(rational(base + 16)).toBeCloseTo(HDR_GAIN_MAP_OFFSET, 5)
    }
  })

  it('delivers the same bytes from a Blob and verifies them by range', async () => {
    const delivered = deliver(true)
    const blob = await preserveJpegMetadata({
      jpeg: new Blob([stored as BlobPart], { type: 'image/jpeg' }),
      metadata,
      width: 4,
      height: 2,
      gainMap: layout,
    })
    const bytes = new Uint8Array(await blob.arrayBuffer())

    expect(bytes).toEqual(delivered)
    await expect(
      verifyGainMapJpeg({
        byteLength: blob.size,
        read: async (start, end) =>
          new Uint8Array(await blob.slice(start, end).arrayBuffer()),
      }),
    ).resolves.toBeUndefined()
  })

  it('refuses bytes a decoder would show only as SDR', () => {
    const withoutIndex = preserveJpegMetadataBytes({
      jpeg: stored,
      metadata,
      width: 4,
      height: 2,
    })
    const delivered = deliver(false)
    const truncated = delivered.subarray(0, delivered.length - 1)
    const bareGainMap = concat(primary, gainMap)
    const misplaced = preserveJpegMetadataBytes({
      jpeg: bareGainMap,
      metadata: null,
      width: 4,
      height: 2,
      gainMap: layout,
    })

    for (const bytes of [withoutIndex, truncated, misplaced, primary]) {
      expect(() => assertGainMapJpeg(bytes)).toThrow(
        'JPEG_GAIN_MAP_VERIFICATION_FAILED',
      )
    }
  })

  it('throws when a stored gain-map export has no place for its segments', () => {
    expect(() =>
      planJpegMetadataInjection({
        header: Uint8Array.of(0, 1, 2),
        fullSize: 3,
        metadata: null,
        width: 1,
        height: 1,
        gainMap: { primaryByteLength: 2 },
      }),
    ).toThrow('JPEG_GAIN_MAP_LAYOUT_INVALID')
    expect(() =>
      planJpegMetadataInjection({
        header: stored,
        fullSize: primary.length,
        metadata: null,
        width: 1,
        height: 1,
        gainMap: layout,
      }),
    ).toThrow('JPEG_GAIN_MAP_LAYOUT_INVALID')
  })
})
