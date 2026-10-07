import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  MAX_IMAGE_BYTES,
  MAX_RAW_BYTES,
  validateImageInput,
} from './image-input'

describe('transform demo image boundary', () => {
  it('keeps the demo input byte bounds', () => {
    expect(MAX_IMAGE_BYTES).toBe(64 * 1024 * 1024)
    expect(MAX_RAW_BYTES).toBe(160 * 1024 * 1024)
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
    expect(
      validateImageInput({ name: 'a.jpg', type: '', size: MAX_IMAGE_BYTES }),
    ).toBe('image')
    expect(
      validateImageInput({ name: 'a.nef', type: '', size: MAX_RAW_BYTES }),
    ).toBe('raw')
  })
})

describe('transform demo presentation ownership', () => {
  it('sizes previews with the production helper instead of a local copy', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/modules/transform-demo/image-input.ts'),
      'utf8',
    )
    expect(source).toMatch(/from '~\/lib\/transform\/preview-dimensions'/)
    expect(source).not.toMatch(/function previewDimensions/)
  })

  it('consumes production frame types and canvas, not demo copies', () => {
    for (const file of [
      'demo-sample.ts',
      'image-input.ts',
      'useTransformDemo.ts',
    ]) {
      const source = readFileSync(
        resolve(process.cwd(), 'src/modules/transform-demo', file),
        'utf8',
      )
      expect(source, file).not.toMatch(
        /from '\.\/(?:preview-types|transform-types|transform-render|worker-protocol|transform\.worker|TransformCanvas)'/,
      )
    }
  })
})
