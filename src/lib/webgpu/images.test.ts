import type { LUTData } from '@lumaforge/luma-color-runtime'
import { LUT_SIZE } from '@lumaforge/luma-color-runtime'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { WebGPUImages } from './images'
import type { WebGPUPrograms } from './programs'

function fixture() {
  const textures: { destroy: ReturnType<typeof vi.fn> }[] = []
  const writeTexture = vi.fn()
  const device = {
    features: new Set<string>(),
    limits: { maxTextureDimension2D: 8192, maxTextureDimension3D: 256 },
    createSampler: vi.fn(() => ({})),
    createBindGroup: vi.fn(() => ({})),
    createTexture: vi.fn(({ size, format }) => {
      const texture = {
        width: size[0],
        height: size[1],
        format,
        destroy: vi.fn(),
        createView: vi.fn(() => ({})),
      }
      textures.push(texture)
      return texture
    }),
    queue: { writeTexture },
  } as unknown as GPUDevice
  const images = new WebGPUImages(device, {} as WebGPUPrograms)
  const upload = {
    data: new Uint16Array([100, 200, 300, 400, 500, 600]),
    width: 2,
    height: 1,
    layout: 'rgb-u16' as const,
    colorSpace: 'linear-prophoto-rgb' as const,
    renderExposureEv: 0,
    renderExposureMultiplier: 1,
  }
  return { images, upload, textures, writeTexture }
}

beforeEach(() =>
  vi.stubGlobal('GPUTextureUsage', {
    TEXTURE_BINDING: 4,
    COPY_DST: 2,
    RENDER_ATTACHMENT: 16,
    COPY_SRC: 1,
  }),
)
afterEach(() => vi.unstubAllGlobals())

describe('webGPU image lifecycle and memory', () => {
  it('reuses input, processed texture and bind groups for same-size replacements', () => {
    const { images, upload } = fixture()
    images.uploadImage(upload)
    const before = {
      input: images.input,
      processed: images.processed,
      group: images.inputGroup,
      allocations: images.textureAllocations,
    }
    images.uploadImage({ ...upload, data: new Uint16Array(6).fill(600) })
    expect(images.input).toBe(before.input)
    expect(images.processed).toBe(before.processed)
    expect(images.inputGroup).toBe(before.group)
    expect(images.textureAllocations).toBe(before.allocations)
    expect(images.estimatedBytes).toBe(32 + LUT_SIZE * 16 + 16)
    images.dispose()
  })
  it('invalid uploads preserve the current frame; clearing releases every image and source reference', () => {
    const { images, upload, textures } = fixture()
    images.uploadImage(upload)
    const input = images.input
    expect(() => images.uploadImage({ ...upload, width: 99999 })).toThrow(
      'GPU_IMAGE_LAYOUT_INVALID',
    )
    expect(images.input).toBe(input)
    images.clearImage()
    expect(images.inputUpload).toBeNull()
    expect(images.inputGroup).toBeNull()
    expect(images.outputGroup).toBeNull()
    images.dispose()
    for (const texture of textures)
      expect(texture.destroy).toHaveBeenCalledOnce()
  })
  it('replaces textures when dimensions change and releases the old pair', () => {
    const { images, upload } = fixture()
    images.uploadImage(upload)
    const previous = [images.input!, images.processed!]
    images.uploadImage({ ...upload, width: 1, height: 2 })
    expect(images.input!.width).toBe(1)
    expect(images.input!.height).toBe(2)
    previous.forEach((texture) =>
      expect(texture.destroy).toHaveBeenCalledOnce(),
    )
    images.dispose()
  })
  it('avoids LUT and selective-color uploads when content is unchanged', () => {
    const { images, writeTexture } = fixture()
    const lut = {
      size: 2,
      data: new Float32Array(24),
      domainMin: [0, 0, 0],
      domainMax: [1, 1, 1],
      title: 'identity',
    } as LUTData
    images.uploadLUT(lut)
    const count = writeTexture.mock.calls.length
    const allocationCount = images.textureAllocations
    images.uploadLUT({ ...lut })
    images.updateSelectiveColor(undefined)
    expect(writeTexture).toHaveBeenCalledTimes(count)
    expect(images.textureAllocations).toBe(allocationCount)
    images.clearLUT()
    expect(images.lutData).toBeNull()
    images.dispose()
  })
})
