import { describe, expect, it } from 'vitest'

import type { DecodedImage } from '~/lib/raw/decoder'

import { createCpuRecoverySource } from './cpu-recovery-source'

describe('bounded CPU recovery source', () => {
  it('samples a large HQ frame under its cap without mutating or detaching source pixels', () => {
    const data = new Uint16Array(Array.from({ length: 4 * 4 * 3 }, (_, i) => i))
    const image = {
      width: 4,
      height: 4,
      layout: 'rgb-u16',
      colorSpace: 'linear-prophoto-rgb',
      source: 'bounded-hq',
      data,
    } as DecodedImage
    const result = createCpuRecoverySource(image, 4)!
    expect([result.width, result.height]).toEqual([2, 2])
    expect([...result.data]).toEqual([
      15, 16, 17, 21, 22, 23, 39, 40, 41, 45, 46, 47,
    ])
    expect(data.byteLength).toBe(96)
    expect(data[0]).toBe(0)
    expect(result.data).not.toBe(data)
  })
  it('does not copy an already-bounded frame and refuses incompatible color buffers', () => {
    const image = {
      width: 1,
      height: 1,
      layout: 'rgb-u16',
      colorSpace: 'linear-prophoto-rgb',
      source: 'bounded-hq',
      data: new Uint16Array([10, 20, 30]),
    } as DecodedImage
    expect(createCpuRecoverySource(image)?.data).toBe(image.data)
    expect(createCpuRecoverySource({ ...image, width: 2 })).toBeNull()
    expect(
      createCpuRecoverySource({ ...image, colorSpace: 'display-srgb-preview' }),
    ).toBeNull()
  })
})
