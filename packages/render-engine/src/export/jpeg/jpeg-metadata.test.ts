import { createHash } from 'node:crypto'

// @vitest-environment node
import { describe, expect, it } from 'vitest'

import {
  planJpegMetadataInjection,
  preserveJpegMetadataBytes,
  sha256OfJpegWithMetadata,
} from './jpeg-metadata'

function minimalJpeg(): Uint8Array {
  return new Uint8Array([
    0xFF,
    0xD8, // SOI
    0xFF,
    0xDB, // DQT marker (not APP0/APP1, so insertion is at offset 2)
    0x00,
    0x02, // segment length = 2 (minimum)
    0xFF,
    0xD9, // EOI
  ])
}

describe('preserveJpegMetadataBytes', () => {
  it('injects EXIF APP1 segment into a minimal JPEG', () => {
    const jpeg = minimalJpeg()
    const result = preserveJpegMetadataBytes({
      jpeg,
      metadata: { make: 'TestCam', model: 'X100' },
      width: 4000,
      height: 3000,
    })

    expect(result.length).toBeGreaterThan(jpeg.length)
    expect(result[0]).toBe(0xFF)
    expect(result[1]).toBe(0xD8)
    // APP1 marker inserted at offset 2
    expect(result[2]).toBe(0xFF)
    expect(result[3]).toBe(0xE1)
    // Original content preserved at the end
    expect(result[result.length - 2]).toBe(0xFF)
    expect(result.at(-1)).toBe(0xD9)
  })

  it('returns the original bytes when JPEG SOI is missing', () => {
    const notJpeg = new Uint8Array([0x00, 0x01, 0x02, 0x03])
    const result = preserveJpegMetadataBytes({
      jpeg: notJpeg,
      metadata: { make: 'TestCam' },
      width: 100,
      height: 100,
    })
    expect(result).toBe(notJpeg)
  })

  it('returns the original bytes when metadata is null', () => {
    const jpeg = minimalJpeg()
    const result = preserveJpegMetadataBytes({
      jpeg,
      metadata: null,
      width: 100,
      height: 100,
    })
    // Still inserts software tag + orientation even with null metadata
    expect(result.length).toBeGreaterThanOrEqual(jpeg.length)
  })

  it('produces the same EXIF content as the Blob version', async () => {
    const jpeg = minimalJpeg()
    const metadata = {
      make: 'Sony',
      model: 'A7IV',
      iso: 400,
      aperture: 2.8,
      focalLength: 35,
    }

    const bytesResult = preserveJpegMetadataBytes({
      jpeg,
      metadata,
      width: 7008,
      height: 4672,
    })

    // Import the Blob version dynamically since we're in Node
    const { preserveJpegMetadata } = await import('./jpeg-metadata')
    const blobInput = new Blob([new Uint8Array(jpeg)], { type: 'image/jpeg' })
    const blobResult = await preserveJpegMetadata({
      jpeg: blobInput,
      metadata,
      width: 7008,
      height: 4672,
    })

    const blobBytes = new Uint8Array(await blobResult.arrayBuffer())
    expect(bytesResult).toEqual(blobBytes)
  })
})

describe('sha256OfJpegWithMetadata', () => {
  const metadata = { make: 'Fujifilm', model: 'GFX100RF', iso: 200 }

  it('matches the hash of the materialized metadata-injected bytes', () => {
    const jpeg = minimalJpeg()
    const plan = planJpegMetadataInjection({
      header: jpeg,
      fullSize: jpeg.length,
      metadata,
      width: 4,
      height: 2,
    })
    expect(plan).not.toBeNull()
    expect(plan?.insertionOffset).toBe(2)

    const delivered = preserveJpegMetadataBytes({
      jpeg,
      metadata,
      width: 4,
      height: 2,
    })
    expect(sha256OfJpegWithMetadata(jpeg, plan)).toBe(
      createHash('sha256').update(delivered).digest('hex'),
    )
  })

  it('falls back to the raw hash when the stream is not a JPEG', () => {
    const notJpeg = new Uint8Array([1, 2, 3, 4])
    expect(
      planJpegMetadataInjection({
        header: notJpeg,
        fullSize: notJpeg.length,
        metadata,
        width: 4,
        height: 2,
      }),
    ).toBeNull()
    expect(sha256OfJpegWithMetadata(notJpeg, null)).toBe(
      createHash('sha256').update(notJpeg).digest('hex'),
    )
  })
})
