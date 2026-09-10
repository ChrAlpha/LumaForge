import type { LUTData, ProcessingParams } from '@lumaforge/luma-color-runtime'
import { resolveExportColorGraph } from '@lumaforge/luma-color-runtime'

import type { WebGLCapabilities } from '~/lib/gl/context'
import type { ExportRenderOptions } from '~/lib/gl/export'
import { ExportRenderError } from '~/lib/gl/export'
import type {
  ExportRenderStats,
  PipelineStats,
  PipelineTelemetrySnapshot,
  PipelineTransformPath,
  RawUploadInput,
  RenderOptions,
} from '~/lib/gl/pipeline'
import { isLUTProfileRenderable } from '~/lib/gl/webgl-pipeline'

import { GPUReadbackJobs } from './async-resources'
import type { WebGPUDeviceLease } from './device'
import { acquireWebGPUDevice } from './device'
import { WebGPUImages } from './images'
import type { WebGPUPrograms } from './programs'
import { getWebGPUPrograms } from './programs'
import { planSnapshotRender, renderSnapshot } from './snapshot'
import { readFloat16Texture } from './texture-data'
import { UNIFORM_BUFFER_SIZE } from './uniform-layout'
import { DEFAULT_PARAMS, packUniforms } from './uniforms'

/** WebGPU preview executor. Full resolution authoritative export stays in its worker. */
export class WebGPUProcessingPipeline {
  readonly backend = 'webgpu' as const
  private lease: WebGPUDeviceLease | null = null
  private programs!: WebGPUPrograms
  private images: WebGPUImages | null = null
  private context: GPUCanvasContext | null = null
  private uniformBuffer: GPUBuffer | null = null
  private uniformGroup!: GPUBindGroup
  private readonly uniformData = new ArrayBuffer(UNIFORM_BUFFER_SIZE)
  private readonly uniformView = new DataView(this.uniformData)
  private params: ProcessingParams = { ...DEFAULT_PARAMS }
  private dirty = true
  private disposed = false
  private lost = false
  private initialization: Promise<void> | null = null
  private lastExportStats: ExportRenderStats | null = null
  private lossListeners = new Set<(error: Error) => void>()
  private uniformUploads = 0
  private processDraws = 0
  private readonly readbacks = new GPUReadbackJobs()

  constructor(private readonly canvas: HTMLCanvasElement) {}

  initialize(): Promise<void> {
    return (this.initialization ??= this.initializeResources())
  }

  private async initializeResources() {
    try {
      const lease = await acquireWebGPUDevice()
      this.lease = lease
      if (this.disposed) throw new Error('WEBGPU_INITIALIZATION_CANCELLED')
      lease.onLost((info) =>
        this.fail(new Error(`WEBGPU_DEVICE_LOST: ${info.message}`)),
      )
      this.programs = await getWebGPUPrograms(
        lease.device,
        navigator.gpu.getPreferredCanvasFormat(),
      )
      if (this.disposed || this.lost)
        throw new Error('WEBGPU_INITIALIZATION_CANCELLED')
      this.images = new WebGPUImages(lease.device, this.programs)
      this.uniformBuffer = lease.device.createBuffer({
        label: 'raw-preview-uniforms',
        size: UNIFORM_BUFFER_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      })
      this.uniformGroup = lease.device.createBindGroup({
        layout: this.programs.uniformLayout,
        entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
      })
      // Bind the visible canvas only after all asynchronous initialization has
      // succeeded, allowing the facade to choose a fallback before this point.
      this.context = this.canvas.getContext('webgpu')
      if (!this.context) throw new Error('WEBGPU_CANVAS_UNAVAILABLE')
      this.context.configure({
        device: lease.device,
        format: navigator.gpu.getPreferredCanvasFormat(),
        alphaMode: 'opaque',
      })
      lease.device.addEventListener('uncapturederror', this.onDeviceError)
    } catch (error) {
      this.dispose()
      throw error
    }
  }

  private onDeviceError = (event: GPUUncapturedErrorEvent) => {
    this.fail(new Error(`WEBGPU_VALIDATION_ERROR: ${event.error.message}`))
  }

  private fail(error: Error) {
    if (this.disposed || this.lost) return
    this.lost = true
    for (const listener of this.lossListeners) listener(error)
  }

  onLost(listener: (error: Error) => void) {
    this.lossListeners.add(listener)
    return () => {
      this.lossListeners.delete(listener)
    }
  }

  private assertReady() {
    if (this.disposed || this.lost || !this.lease || !this.images)
      throw new Error('WEBGPU_PIPELINE_UNAVAILABLE')
    return { device: this.lease.device, images: this.images }
  }

  uploadImage(input: RawUploadInput) {
    this.readbacks.dispose()
    this.assertReady().images.uploadImage(input)
    this.dirty = true
  }
  clearImage() {
    this.readbacks.dispose()
    this.images?.clearImage()
    this.dirty = true
  }
  uploadLUT(lut: LUTData) {
    this.dirty = true
    this.assertReady().images.uploadLUT(lut)
  }
  clearLUT() {
    this.images?.clearLUT()
    this.dirty = true
  }
  setParams(params: Partial<ProcessingParams>) {
    for (const key of Object.keys(params) as (keyof ProcessingParams)[]) {
      if (params[key] !== this.params[key]) {
        this.dirty = true
        break
      }
    }
    this.params = { ...this.params, ...params }
  }
  getParams() {
    return { ...this.params }
  }

  private exposure() {
    const source = this.images?.inputUpload
    return source?.layout === 'rgb-u16' &&
      Number.isFinite(source.renderExposureMultiplier)
      ? source.renderExposureMultiplier
      : 1
  }

  render(options: RenderOptions = {}): PipelineStats {
    if (options.waitForGpu) throw new Error('WEBGPU_ASYNC_WAIT_REQUIRED')
    const { device, images } = this.assertReady()
    const start = performance.now()
    if (images.input && images.processedView && this.context) {
      const encoder = device.createCommandEncoder({
        label: 'raw-preview-frame',
      })
      if (this.dirty) {
        images.updateSelectiveColor(this.params.selectiveColor)
        packUniforms(
          this.uniformView,
          this.params,
          images.lutData,
          this.exposure(),
          images.selectiveActive,
        )
        device.queue.writeBuffer(this.uniformBuffer!, 0, this.uniformData)
        this.uniformUploads++
        this.encodeProcess(encoder, images.processedView, this.uniformGroup)
        this.dirty = false
      }
      this.encodeOutput(
        encoder,
        this.context.getCurrentTexture().createView(),
        images.outputGroup!,
        this.programs.output,
      )
      device.queue.submit([encoder.finish()])
    }
    const elapsed = performance.now() - start
    return {
      uploadTime: images.uploadTime,
      lutUploadTime: images.lutUploadTime,
      processTime: elapsed,
      totalTime: elapsed,
      inputSize: this.getInputDimensions(),
      previewSize: { width: this.canvas.width, height: this.canvas.height },
      ...this.telemetry(),
    }
  }

  private encodeProcess(
    encoder: GPUCommandEncoder,
    target: GPUTextureView,
    uniforms: GPUBindGroup,
  ) {
    const images = this.images!
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: target,
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: [0, 0, 0, 1],
        },
      ],
    })
    pass.setPipeline(
      images.inputUpload?.layout === 'rgb-u16'
        ? this.programs.processU16
        : this.programs.processFloat,
    )
    pass.setBindGroup(0, uniforms)
    pass.setBindGroup(1, images.inputGroup!)
    pass.setBindGroup(2, images.lutGroup)
    pass.setBindGroup(3, images.selectiveGroup)
    pass.draw(3)
    pass.end()
    this.processDraws++
  }

  private encodeOutput(
    encoder: GPUCommandEncoder,
    target: GPUTextureView,
    source: GPUBindGroup,
    pipeline: GPURenderPipeline,
  ) {
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: target,
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: [0, 0, 0, 1],
        },
      ],
    })
    pass.setPipeline(pipeline)
    pass.setBindGroup(0, source)
    pass.draw(3)
    pass.end()
  }

  async waitForGpu() {
    await this.assertReady().device.queue.onSubmittedWorkDone()
    this.assertReady()
  }
  readProcessedPixels(): Float32Array | null {
    throw new Error('WEBGPU_ASYNC_READBACK_REQUIRED')
  }
  async readProcessedPixelsAsync(): Promise<Float32Array | null> {
    const { device, images } = this.assertReady()
    if (!images.processed) return null
    if (this.dirty) this.render()
    const scope = this.readbacks.create()
    try {
      const result = await readFloat16Texture(device, images.processed, scope)
      this.assertReady()
      return result
    } finally {
      scope.dispose()
    }
  }

  async renderToHiddenCanvas({
    width,
    height,
    exportOptions,
  }: {
    width: number
    height: number
    exportOptions?: ExportRenderOptions
  }) {
    const { device, images } = this.assertReady()
    if (!images.inputUpload) throw new Error('EXPORT_SOURCE_MISSING')
    const start = performance.now()
    const plan = planSnapshotRender({
      width,
      height,
      maxTextureSize: device.limits.maxTextureDimension2D,
      source: images.inputUpload,
      lutSize: images.lutData?.size ?? 0,
      exportOptions,
    })
    const planningTime = performance.now() - start
    const stats = {
      ...this.telemetry(),
      width,
      height,
      planningTime,
      renderTime: 0,
      totalTime: planningTime,
      tileCount: 0,
    }
    if (plan.strategy === 'fail') {
      this.lastExportStats = {
        ...stats,
        strategy: 'fail',
        reason: plan.reason,
        retryable: plan.retryable,
      }
      throw ExportRenderError.fromFailedPlan(plan)
    }
    const scope = this.readbacks.create()
    try {
      // The snapshot reuses the retained processed target with export view mode.
      // Any subsequent interactive frame must restore the live view parameters.
      this.dirty = true
      const canvas = await renderSnapshot({
        device,
        programs: this.programs,
        images,
        params: this.params,
        exposure: this.exposure(),
        width,
        height,
        plan,
        assertReady: () => {
          scope.assertActive()
          this.assertReady()
        },
        scope,
      })
      const totalTime = performance.now() - start
      this.lastExportStats = {
        ...stats,
        strategy: plan.strategy,
        tileCount:
          plan.strategy === 'tiled'
            ? Math.ceil(width / plan.tileWidth) *
              Math.ceil(height / plan.tileHeight)
            : 1,
        renderTime: totalTime - planningTime,
        totalTime,
      }
      return canvas
    } catch (error) {
      this.lastExportStats = {
        ...stats,
        strategy: 'fail',
        reason: 'render-failure',
        failureMessage: error instanceof Error ? error.message : String(error),
        retryable: true,
        totalTime: performance.now() - start,
      }
      throw error
    } finally {
      scope.dispose()
    }
  }

  getLastExportStats() {
    return this.lastExportStats ? { ...this.lastExportStats } : null
  }
  resize(width: number, height: number) {
    if (this.canvas.width !== width) this.canvas.width = width
    if (this.canvas.height !== height) this.canvas.height = height
  }
  getInputDimensions() {
    return {
      width: this.images?.inputUpload?.width ?? 0,
      height: this.images?.inputUpload?.height ?? 0,
    }
  }
  getCapabilities(): WebGLCapabilities {
    const { device } = this.assertReady()
    const info = this.lease!.adapter.info
    return {
      webgl2: false,
      maxTextureSize: device.limits.maxTextureDimension2D,
      max3DTextureSize: device.limits.maxTextureDimension3D,
      floatTextures: true,
      floatTexturesLinear: device.features.has('float32-filterable'),
      halfFloatTextures: true,
      halfFloatTexturesLinear: true,
      colorBufferFloat: true,
      colorBufferHalfFloat: true,
      maxVertexUniformVectors: 0,
      maxFragmentUniformVectors: 0,
      maxVaryingVectors: 0,
      fragmentHighFloatPrecision: 23,
      fragmentHighFloatRangeMin: 127,
      fragmentHighFloatRangeMax: 127,
      toneHighPrecision: true,
      rendererInfo: info.description || info.device || 'WebGPU',
      vendorInfo: info.vendor,
    }
  }
  getResourceStats() {
    return {
      backend: this.backend,
      estimatedBytes:
        (this.images?.estimatedBytes ?? 0) +
        (this.uniformBuffer ? UNIFORM_BUFFER_SIZE : 0) +
        this.readbacks.estimatedBytes,
      textureAllocations: this.images?.textureAllocations ?? 0,
      uploadedBytes: this.images?.uploadedBytes ?? 0,
      uniformUploads: this.uniformUploads,
      processDraws: this.processDraws,
    }
  }
  private telemetry(): PipelineTelemetrySnapshot {
    const lut = this.images?.lutData
    const graph = resolveExportColorGraph({ ...this.params, lut: lut ?? null })
    const profile = graph.supported ? graph.lutProfile : null
    let transformPath: PipelineTransformPath = 'no-lut'
    if (this.params.styleKind === 'builtin') transformPath = 'builtin-style'
    else if (this.params.styleKind === 'custom' && lut) {
      if (!isLUTProfileRenderable(lut.profileResolution))
        transformPath = 'disabled-lut'
      else if (lut.profileResolution?.kind === 'confirmed') {
        const roles = {
          'display-look': 'display-lut',
          'scene-creative': 'scene-creative-lut',
          'combined-look-output': 'combined-output-lut',
          'technical-output': 'technical-output-lut',
        } as const
        transformPath = roles[lut.profileResolution.profile.role]
      }
    }
    return {
      inputFormat:
        this.images?.inputUpload?.layout === 'rgb-u16'
          ? 'uint16-rgb'
          : 'float-rgba',
      transformPath,
      lutRole: profile?.role ?? null,
      lutInputTransfer: profile?.inputTransfer ?? null,
      lutOutputTransfer:
        profile?.outputTransfer ??
        (profile?.role === 'display-look' ? profile.inputTransfer : null),
      lutSize: lut?.size ?? null,
      processTargetPrecision: 'rgba16f',
      capabilityWarnings: [],
    }
  }
  dispose(_options: { releaseContext?: boolean } = {}) {
    this.disposed = true
    this.readbacks.dispose()
    this.lease?.device.removeEventListener(
      'uncapturederror',
      this.onDeviceError,
    )
    this.context?.unconfigure()
    this.context = null
    this.images?.dispose()
    this.images = null
    this.uniformBuffer?.destroy()
    this.uniformBuffer = null
    this.lease?.release()
    this.lease = null
    this.lossListeners.clear()
  }
}
