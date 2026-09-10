import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  decodeFloat16,
  padLut,
  readFloat16Texture,
  uploadRgb16,
  validateImageUpload,
} from './texture-data'

afterEach(() => vi.unstubAllGlobals())

describe('webGPU texture data contract', () => {
  it('decodes half precision normal, subnormal, signed zero and special values', () => {
    expect([0x3C00, 0x3800, 0xC000, 1, 0x7BFF].map(decodeFloat16)).toEqual([
      1,
      0.5,
      -2,
      2 ** -24,
      65504,
    ])
    expect(Object.is(decodeFloat16(0x8000), -0)).toBe(true)
    expect(decodeFloat16(0x7C00)).toBe(Infinity)
    expect(decodeFloat16(0x7E00)).toBeNaN()
  })

  it('rejects truncated and over-limit image uploads before allocating', () => {
    const input = {
      data: new Uint16Array(6),
      width: 2,
      height: 1,
      layout: 'rgb-u16' as const,
      colorSpace: 'linear-prophoto-rgb' as const,
      renderExposureEv: 0,
      renderExposureMultiplier: 1,
    }
    expect(() => validateImageUpload(input, 2)).not.toThrow()
    expect(() => validateImageUpload(input, 1)).toThrow(
      'GPU_IMAGE_LAYOUT_INVALID',
    )
    expect(() => validateImageUpload({ ...input, height: 2 }, 2)).toThrow(
      'GPU_IMAGE_LAYOUT_INVALID',
    )
  })

  it('preserves LUT and integer RGB channels and adds opaque alpha', () => {
    expect(padLut(new Float32Array([1, 2, 3, 4, 5, 6]))).toEqual(
      new Float32Array([1, 2, 3, 1, 4, 5, 6, 1]),
    )
    const writeTexture = vi.fn()
    uploadRgb16(
      { queue: { writeTexture } } as unknown as GPUDevice,
      {} as GPUTexture,
      {
        width: 1,
        height: 2,
        layout: 'rgb-u16',
        colorSpace: 'linear-prophoto-rgb',
        data: new Uint16Array([1, 2, 3, 65535, 42, 0]),
        renderExposureEv: 0,
        renderExposureMultiplier: 1,
      },
    )
    expect(writeTexture.mock.calls[0][1]).toEqual(
      new Uint16Array([1, 2, 3, 65535, 65535, 42, 0, 65535]),
    )
  })

  it.each([false, true])(
    'readback strips row padding and releases staging (failure=%s)',
    async (fail) => {
      vi.stubGlobal('GPUBufferUsage', { COPY_DST: 8, MAP_READ: 1 })
      vi.stubGlobal('GPUMapMode', { READ: 1 })
      const data = new Uint16Array(256)
      data.set([0x3C00, 0x3800, 0, 0x3C00])
      data.set([0x4000, 0xC000, 1, 0x3C00], 128)
      const buffer = {
        mapAsync: fail
          ? vi.fn().mockRejectedValue(new Error('lost'))
          : vi.fn().mockResolvedValue(undefined),
        getMappedRange: () => data.buffer,
        mapState: fail ? 'unmapped' : 'mapped',
        unmap: vi.fn(),
        destroy: vi.fn(),
      }
      const copyTextureToBuffer = vi.fn()
      const device = {
        createBuffer: vi.fn(() => buffer),
        createCommandEncoder: () => ({ copyTextureToBuffer, finish: vi.fn() }),
        queue: { submit: vi.fn() },
      } as unknown as GPUDevice
      const promise = readFloat16Texture(device, {
        width: 1,
        height: 2,
      } as GPUTexture)
      if (fail) await expect(promise).rejects.toThrow('lost')
      else
        expect(await promise).toEqual(
          new Float32Array([1, 0.5, 0, 1, 2, -2, 2 ** -24, 1]),
        )
      expect(copyTextureToBuffer.mock.calls[0][1].bytesPerRow).toBe(256)
      expect(buffer.destroy).toHaveBeenCalledOnce()
      expect(buffer.unmap).toHaveBeenCalledTimes(fail ? 0 : 1)
    },
  )
})
