import { describe, expect, it } from 'vitest'

import { createTestDecodedImage } from '../../test-support/builders'
import { sampleRgb16Frame } from './bounded-rgb16-frame'

describe('sampleRgb16Frame', () => {
  it('samples a large HQ frame under its cap without mutating or detaching source pixels', () => {
    const data = new Uint16Array(Array.from({ length: 4 * 4 * 3 }, (_, i) => i))
    const image = createTestDecodedImage({
      width: 4,
      height: 4,
      source: 'bounded-hq',
      data,
    })
    const result = sampleRgb16Frame(image, 4)!
    expect([result.width, result.height]).toEqual([2, 2])
    expect([...result.data]).toEqual([
      15, 16, 17, 21, 22, 23, 39, 40, 41, 45, 46, 47,
    ])
    expect(data.byteLength).toBe(96)
    expect(data[0]).toBe(0)
    expect(result.data).not.toBe(data)
  })

  it('does not copy a frame that fits and refuses a buffer that does not match its size', () => {
    const image = createTestDecodedImage({
      width: 1,
      height: 1,
      source: 'bounded-hq',
      data: new Uint16Array([10, 20, 30]),
    })
    expect(sampleRgb16Frame(image, 4)?.data).toBe(image.data)
    expect(sampleRgb16Frame({ ...image, width: 2 }, 4)).toBeNull()
  })
})
