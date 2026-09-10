import type { LUTData } from '@lumaforge/luma-color-runtime'
import { LUT_SIZE } from '@lumaforge/luma-color-runtime'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { WebGPUImages } from './images'
import type { WebGPUPrograms } from './programs'

function fixture(beforeConstruct?: (device: GPUDevice) => void) {
  const textures: {
    destroy: ReturnType<typeof vi.fn>
    createView: ReturnType<typeof vi.fn>
  }[] = []
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
  beforeConstruct?.(device)
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
  return { images, upload, textures, writeTexture, device }
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
  it.each([
    'fallback-allocation',
    'fallback-upload',
    'selective-allocation',
    'selective-binding',
    'fallback-rebinding',
    'selective-upload',
  ])('releases partial constructor textures after %s failure', (failure) => {
    let failedDevice!: GPUDevice
    const registeredByCaller = vi.fn()
    const expected = new Error(`constructor ${failure} failed`)
    const fail = () => {
      throw expected
    }
    expect(() => {
      const { images } = fixture((device) => {
        failedDevice = device
        const createTexture = vi.mocked(device.createTexture)
        const createBindGroup = vi.mocked(device.createBindGroup)
        const writeTexture = vi.mocked(device.queue.writeTexture)
        if (failure === 'fallback-allocation')
          createTexture.mockImplementationOnce(fail)
        else if (failure === 'selective-allocation')
          createTexture
            .mockImplementationOnce(createTexture.getMockImplementation()!)
            .mockImplementationOnce(fail)
        else if (failure === 'fallback-upload')
          writeTexture.mockImplementationOnce(fail)
        else if (failure === 'selective-upload')
          writeTexture
            .mockImplementationOnce(writeTexture.getMockImplementation()!)
            .mockImplementationOnce(fail)
        else if (failure === 'selective-binding')
          createBindGroup.mockImplementationOnce(fail)
        else
          createBindGroup
            .mockImplementationOnce(createBindGroup.getMockImplementation()!)
            .mockImplementationOnce(fail)
      })
      registeredByCaller(images)
    }).toThrow(expected)

    expect(registeredByCaller).not.toHaveBeenCalled()
    const allocated = vi
      .mocked(failedDevice.createTexture)
      .mock.results.filter((result) => result.type === 'return')
    expect(allocated).toHaveLength(
      failure === 'fallback-allocation'
        ? 0
        : failure === 'fallback-upload' || failure === 'selective-allocation'
          ? 1
          : 2,
    )
    for (const texture of allocated)
      expect(texture.value.destroy).toHaveBeenCalledOnce()
  })

  it.each(['validation', 'allocation', 'binding', 'upload', 'reused-upload'])(
    'clears a previous LUT after replacement %s failure while retaining the RAW image',
    (failure) => {
      const { images, upload, textures, writeTexture, device } = fixture()
      images.uploadImage(upload)
      const originalLut = {
        size: 2,
        data: new Float32Array(24),
        domainMin: [0, 0, 0],
        domainMax: [1, 1, 1],
      } as LUTData
      images.uploadLUT(originalLut)
      const source = images.input
      const processed = images.processed
      const previousTexture = textures.at(-1)!
      const replacementSize = failure === 'reused-upload' ? 2 : 3
      const replacement = {
        ...originalLut,
        size: replacementSize,
        data: new Float32Array(replacementSize ** 3 * 3),
      }
      const expected = new Error(`replacement ${failure} failed`)
      if (failure === 'validation') replacement.size = 257
      else if (failure === 'allocation')
        vi.mocked(device.createTexture).mockImplementationOnce(() => {
          throw expected
        })
      else if (failure === 'binding')
        vi.mocked(device.createBindGroup).mockImplementationOnce(() => {
          throw expected
        })
      else
        writeTexture.mockImplementationOnce(() => {
          throw expected
        })

      expect(() => images.uploadLUT(replacement)).toThrow(
        failure === 'validation' ? 'GPU_LUT_LAYOUT_INVALID' : expected,
      )

      expect(images.lutData).toBeNull()
      expect(previousTexture.destroy).toHaveBeenCalledOnce()
      if (failure === 'binding' || failure === 'upload')
        expect(textures.at(-1)!.destroy).toHaveBeenCalledOnce()
      const fallbackView = textures[0]!.createView.mock.results.at(-1)!.value
      const bindings = vi.mocked(device.createBindGroup).mock.calls.at(-1)![0]
      expect(Array.from(bindings.entries)[0]).toEqual({
        binding: 0,
        resource: fallbackView,
      })
      expect(images.input).toBe(source)
      expect(images.processed).toBe(processed)
      expect(images.inputUpload).toBe(upload)
      expect(source!.destroy).not.toHaveBeenCalled()
      expect(processed!.destroy).not.toHaveBeenCalled()

      images.uploadLUT(originalLut)
      expect(images.lutData).toBe(originalLut)
      images.dispose()
      for (const texture of textures)
        expect(texture.destroy).toHaveBeenCalledOnce()
    },
  )

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
