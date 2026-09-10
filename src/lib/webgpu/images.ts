import type { LUTData, ProcessingParams } from '@lumaforge/luma-color-runtime'
import {
  LUT_SIZE,
  normalizeSelectiveColorParams,
  resolveSelectiveColorParams,
} from '@lumaforge/luma-color-runtime'

import type { RawUploadInput } from '~/lib/gl/pipeline'

import type { WebGPUPrograms } from './programs'
import { padLut, uploadRgb16, validateImageUpload } from './texture-data'

/** Textures and bind groups change only with source, LUT, or dimensions. */
export class WebGPUImages {
  input: GPUTexture | null = null
  processed: GPUTexture | null = null
  processedView: GPUTextureView | null = null
  inputGroup: GPUBindGroup | null = null
  outputGroup: GPUBindGroup | null = null
  lutGroup!: GPUBindGroup
  selectiveGroup!: GPUBindGroup
  inputUpload: RawUploadInput | null = null
  lutData: LUTData | null = null
  selectiveActive = false
  uploadTime = 0
  lutUploadTime = 0
  textureAllocations = 0
  uploadedBytes = 0
  private lut: GPUTexture | null = null
  private fallback: GPUTexture
  private selective: GPUTexture
  private selectiveSignature = ''
  private readonly selectiveData = new Float32Array(LUT_SIZE * 4)
  private readonly linear: GPUSampler
  private readonly nearest: GPUSampler

  constructor(
    private readonly device: GPUDevice,
    private readonly programs: WebGPUPrograms,
  ) {
    this.linear = device.createSampler({
      minFilter: 'linear',
      magFilter: 'linear',
    })
    this.nearest = device.createSampler()
    this.fallback = this.createTexture([1, 1, 1], 'rgba32float', '3d')
    device.queue.writeTexture(
      { texture: this.fallback },
      new Float32Array([0, 0, 0, 1]),
      { bytesPerRow: 16 },
      [1, 1, 1],
    )
    this.selective = this.createTexture([LUT_SIZE, 1], 'rgba32float')
    this.selectiveGroup = device.createBindGroup({
      layout: programs.selectiveLayout,
      entries: [{ binding: 0, resource: this.selective.createView() }],
    })
    this.rebindLut()
    this.updateSelectiveColor(undefined)
  }

  private createTexture(
    size: [number, number] | [number, number, number],
    format: GPUTextureFormat,
    dimension: GPUTextureDimension = '2d',
  ) {
    const texture = this.device.createTexture({
      label: `raw-preview-${format}`,
      size,
      format,
      dimension,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    })
    this.textureAllocations++
    return texture
  }

  uploadImage(input: RawUploadInput) {
    validateImageUpload(input, this.device.limits.maxTextureDimension2D)
    const start = performance.now()
    const format = input.layout === 'rgb-u16' ? 'rgba16uint' : 'rgba32float'
    if (
      !this.input ||
      this.input.width !== input.width ||
      this.input.height !== input.height ||
      this.input.format !== format
    ) {
      this.clearImage()
      this.input = this.createTexture([input.width, input.height], format)
      this.inputGroup = this.device.createBindGroup({
        layout:
          input.layout === 'rgb-u16'
            ? this.programs.inputU16Layout
            : this.programs.inputFloatLayout,
        entries: [
          { binding: 0, resource: this.input.createView() },
          { binding: 1, resource: this.nearest },
        ],
      })
      this.processed = this.device.createTexture({
        label: 'raw-preview-processed',
        size: [input.width, input.height],
        format: 'rgba16float',
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.RENDER_ATTACHMENT |
          GPUTextureUsage.COPY_SRC,
      })
      this.textureAllocations++
      this.processedView = this.processed.createView()
      this.outputGroup = this.outputGroupFor(this.processedView)
    }
    if (input.layout === 'rgb-u16') uploadRgb16(this.device, this.input, input)
    else
      this.device.queue.writeTexture(
        { texture: this.input },
        input.data as Float32Array<ArrayBuffer>,
        { bytesPerRow: input.width * 16 },
        [input.width, input.height],
      )
    this.inputUpload = input
    this.uploadedBytes +=
      input.width * input.height * (input.layout === 'rgb-u16' ? 8 : 16)
    this.uploadTime = performance.now() - start
  }

  clearImage() {
    this.input?.destroy()
    this.processed?.destroy()
    this.input = this.processed = null
    this.processedView = null
    this.inputGroup = this.outputGroup = null
    this.inputUpload = null
    this.uploadTime = 0
  }

  outputGroupFor(view: GPUTextureView) {
    return this.device.createBindGroup({
      layout: this.programs.outputLayout,
      entries: [
        { binding: 0, resource: view },
        { binding: 1, resource: this.linear },
      ],
    })
  }

  uploadLUT(lut: LUTData) {
    if (
      !Number.isSafeInteger(lut.size) ||
      lut.size < 2 ||
      lut.size > this.device.limits.maxTextureDimension3D ||
      lut.data.length !== lut.size ** 3 * 3
    ) {
      throw new Error('GPU_LUT_LAYOUT_INVALID')
    }
    if (this.lutData?.data === lut.data && this.lutData.size === lut.size) {
      this.lutData = lut
      return
    }
    const start = performance.now()
    if (!this.lut || this.lut.width !== lut.size) {
      this.lut?.destroy()
      this.lut = this.createTexture(
        [lut.size, lut.size, lut.size],
        'rgba32float',
        '3d',
      )
      this.rebindLut()
    }
    this.device.queue.writeTexture(
      { texture: this.lut },
      padLut(lut.data),
      { bytesPerRow: lut.size * 16, rowsPerImage: lut.size },
      [lut.size, lut.size, lut.size],
    )
    this.uploadedBytes += lut.size ** 3 * 16
    this.lutData = lut
    this.lutUploadTime = performance.now() - start
  }

  clearLUT() {
    this.lut?.destroy()
    this.lut = null
    this.lutData = null
    this.lutUploadTime = 0
    this.rebindLut()
  }

  private rebindLut() {
    this.lutGroup = this.device.createBindGroup({
      layout: this.programs.lutLayout,
      entries: [
        {
          binding: 0,
          resource: (this.lut ?? this.fallback).createView({ dimension: '3d' }),
        },
        {
          binding: 1,
          resource: this.device.features.has('float32-filterable')
            ? this.linear
            : this.nearest,
        },
      ],
    })
  }

  updateSelectiveColor(bands: ProcessingParams['selectiveColor']) {
    const normalized = normalizeSelectiveColorParams({ selectiveColor: bands })
    const signature = JSON.stringify(normalized)
    if (signature === this.selectiveSignature) return
    resolveSelectiveColorParams({ selectiveColor: bands }, this.selectiveData)
    this.selectiveActive = Object.values(normalized).some(
      (band) => band.hue !== 0 || band.saturation !== 0 || band.lightness !== 0,
    )
    this.device.queue.writeTexture(
      { texture: this.selective },
      this.selectiveData,
      { bytesPerRow: LUT_SIZE * 16 },
      [LUT_SIZE, 1],
    )
    this.uploadedBytes += this.selectiveData.byteLength
    this.selectiveSignature = signature
  }

  get estimatedBytes() {
    const input = this.inputUpload
    return (
      (input
        ? input.width * input.height * (input.layout === 'rgb-u16' ? 16 : 24)
        : 0) +
      (this.lutData?.size ?? 0) ** 3 * 16 +
      LUT_SIZE * 16 +
      16
    )
  }

  dispose() {
    this.clearImage()
    this.lut?.destroy()
    this.lut = null
    this.lutData = null
    this.fallback.destroy()
    this.selective.destroy()
  }
}
