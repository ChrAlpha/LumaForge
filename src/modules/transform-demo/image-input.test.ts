import { describe, expect, it } from 'vitest'

import { previewDimensions, validateImageInput } from './image-input'
import { MAX_IMAGE_BYTES, MAX_RAW_BYTES } from './preview-types'

describe('transform demo image boundary', () => {
  it('bounds landscape and portrait previews without upscaling', () => {
    expect(previewDimensions(6000, 4000)).toEqual({ width: 1600, height: 1067 })
    expect(previewDimensions(4000, 6000)).toEqual({ width: 1067, height: 1600 })
    expect(previewDimensions(640, 480)).toEqual({ width: 640, height: 480 })
    expect(() => previewDimensions(Infinity, 10)).toThrow('decode')
    expect(() => previewDimensions(0, 10)).toThrow('decode')
  })

  it('accepts supported RAW and raster files even when MIME is missing', () => {
    expect(
      validateImageInput({ name: 'photo.NEF', type: '', size: 20_000_000 }),
    ).toBe('raw')
    expect(
      validateImageInput({ name: 'photo.JPG', type: '', size: 5000 }),
    ).toBe('image')
    expect(
      validateImageInput({ name: 'photo', type: 'image/png', size: 5000 }),
    ).toBe('image')
  })

  it('rejects empty, unsupported, and oversized inputs before decoding', () => {
    expect(() =>
      validateImageInput({ name: 'a.svg', type: 'image/svg+xml', size: 5000 }),
    ).toThrow('unsupported')
    expect(() =>
      validateImageInput({ name: 'a.jpg', type: '', size: 0 }),
    ).toThrow('decode')
    expect(() =>
      validateImageInput({
        name: 'a.jpg',
        type: '',
        size: MAX_IMAGE_BYTES + 1,
      }),
    ).toThrow('too-large')
    expect(() =>
      validateImageInput({ name: 'a.nef', type: '', size: MAX_RAW_BYTES + 1 }),
    ).toThrow('too-large')
  })
})
