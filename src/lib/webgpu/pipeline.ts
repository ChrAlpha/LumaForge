import type { LUTData } from '@lumaforge/luma-color-runtime'
import { pickColorGraphIntent } from '@lumaforge/luma-color-runtime'

import { GPUReadbackJobs } from './async-resources'
import type {
  PipelineStats,
  PreviewGpuCapabilities,
  RawUploadInput,
} from './contract'
import type { WebGPUDeviceLease } from './device'
import { acquireWebGPUDevice } from './device'
import { WebGPUFrameScheduler } from './frame-scheduler'
import { WebGPUImages } from './images'
import { WebGPUProgramSelection } from './program-selection'
import type { WebGPUPrograms } from './programs'
import { getWebGPUPrograms } from './programs'
import type { SnapshotPlan } from './snapshot'
import { planSnapshotRender, renderSnapshot } from './snapshot'
import { getShaderSpecialization } from './specialization'
import { readFloat16Texture } from './texture-data'
import { UNIFORM_BUFFER_SIZE } from './uniform-layout'
import type { GpuPreviewParams } from './uniforms'
import { DEFAULT_PARAMS, packUniforms } from './uniforms'

/** WebGPU preview executor. Full resolution authoritative export stays in its worker. */
export class WebGPUProcessingPipeline {
  readonly backend = 'webgpu' as const
  private lease: WebGPUDeviceLease | null = null
  private frames: WebGPUFrameScheduler | null = null
  private variants: WebGPUProgramSelection | null = null
  private get programs(): WebGPUPrograms {
    return this.variants!.current
  }
  private images: WebGPUImages | null = null
  private context: GPUCanvasContext | null = null
  private uniformBuffer: GPUBuffer | null = null
  private uniformGroup!: GPUBindGroup
  private readonly uniformData = new ArrayBuffer(UNIFORM_BUFFER_SIZE)
  private readonly uniformView = new DataView(this.uniformData)
  private params: GpuPreviewParams = { ...DEFAULT_PARAMS }
  private dirty = true
  private disposed = false
  private lost = false
  private lostError: Error | null = null
  private initialization: Promise<void> | null = null
  private lastSnapshotPlan: (SnapshotPlan & { tileCount: number }) | null = null
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
      const format = navigator.gpu.getPreferredCanvasFormat()
      const generic = await getWebGPUPrograms(lease.device, format)
      if (this.disposed || this.lost)
        throw new Error('WEBGPU_INITIALIZATION_CANCELLED')
      this.variants = new WebGPUProgramSelection(
        lease.device,
        format,
        generic,
        () => {
          this.dirty = true
          if (
            this.images?.input &&
            this.context &&
            !this.disposed &&
            !this.lost
          )
            this.render()
        },
      )
      await this.variants.select(getShaderSpecialization(this.params, null))
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
      this.frames = new WebGPUFrameScheduler(
        () => this.drawFrame(),
        () => lease.device.queue.onSubmittedWorkDone(),
        (error) =>
          this.fail(error instanceof Error ? error : new Error(String(error))),
      )
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
    this.lostError = error
    for (const listener of this.lossListeners) listener(error)
  }

  /** Subscribers that arrive after a loss still hear about it. */
  onLost(listener: (error: Error) => void) {
    if (this.lostError && !this.disposed) listener(this.lostError)
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
    try {
      this.assertReady().images.uploadLUT(lut)
    } finally {
      this.prepareVariant()
    }
  }
  clearLUT() {
    this.images?.clearLUT()
    this.dirty = true
    this.prepareVariant()
  }
  setParams(params: Partial<GpuPreviewParams>) {
    for (const key of Object.keys(params) as (keyof GpuPreviewParams)[]) {
      if (params[key] !== this.params[key]) {
        this.dirty = true
        break
      }
    }
    this.params = { ...this.params, ...params }
    this.prepareVariant()
  }
  private prepareVariant() {
    if (this.disposed || this.lost || !this.variants) return
    void this.variants
      .select(
        getShaderSpecialization(this.params, this.images?.lutData ?? null),
      )
      .catch((error) => this.fail(error))
  }
  getParams(): GpuPreviewParams {
    return { ...this.params }
  }
  /** The LUT the pipeline holds, as its last successful upload left it. */
  getLutData(): LUTData | null {
    return this.images?.lutData ?? null
  }

  private exposure() {
    const source = this.images?.inputUpload
    return source && Number.isFinite(source.renderExposureMultiplier)
      ? source.renderExposureMultiplier
      : 1
  }

  /** Requests a frame; await `waitForGpu()` when completed pixels matter. */
  render(): PipelineStats {
    const { images } = this.assertReady()
    const start = performance.now()
    if (images.input && this.context) this.frames!.request()
    this.assertReady()
    return {
      processTime: performance.now() - start,
      inputSize: this.getInputDimensions(),
      previewSize: { width: this.canvas.width, height: this.canvas.height },
    }
  }

  private drawFrame() {
    const { device, images } = this.assertReady()
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
        images.encodeProcess(
          encoder,
          this.programs.processU16,
          this.uniformGroup,
        )
        this.processDraws++
        this.dirty = false
      }
      images.encodeOutput(
        encoder,
        this.programs.output,
        this.context.getCurrentTexture().createView(),
      )
      device.queue.submit([encoder.finish()])
    }
  }

  async waitForGpu() {
    await this.variants?.wait()
    await this.frames?.wait()
    this.assertReady()
  }
  async readProcessedPixelsAsync(): Promise<Float32Array | null> {
    const { device, images } = this.assertReady()
    if (!images.processed) return null
    const scope = this.readbacks.create()
    try {
      if (this.dirty) this.render()
      await this.waitForGpu()
      scope.assertActive()
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
    budgetBytes,
  }: {
    width: number
    height: number
    /** Snapshot memory budget; defaults to the planner's. */
    budgetBytes?: number
  }) {
    const { device, images } = this.assertReady()
    if (!images.inputUpload) throw new Error('EXPORT_SOURCE_MISSING')
    const plan = planSnapshotRender({
      width,
      height,
      maxTextureSize: device.limits.maxTextureDimension2D,
      lutSize: images.lutData?.size ?? 0,
      budgetBytes,
    })
    this.lastSnapshotPlan = {
      ...plan,
      tileCount:
        plan.strategy === 'tiled'
          ? Math.ceil(width / plan.tileWidth) *
            Math.ceil(height / plan.tileHeight)
          : Number(plan.strategy === 'full-frame'),
    }
    if (plan.strategy === 'fail') {
      throw new Error(
        plan.reason === 'canvas-limit'
          ? 'EXPORT_CANVAS_LIMIT_EXCEEDED'
          : 'EXPORT_GPU_LIMIT_EXCEEDED',
      )
    }
    const scope = this.readbacks.create()
    try {
      // The snapshot reuses the retained processed target with export view mode.
      // Any subsequent interactive frame must restore the live view parameters.
      this.dirty = true
      return await renderSnapshot({
        device,
        programs: this.programs,
        images,
        color: pickColorGraphIntent(this.params),
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
    } finally {
      scope.dispose()
    }
  }

  /** The last HQ snapshot's plan, with its tile count. */
  getLastSnapshotPlan() {
    return this.lastSnapshotPlan ? { ...this.lastSnapshotPlan } : null
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
  getCapabilities(): PreviewGpuCapabilities {
    const { device } = this.assertReady()
    const info = this.lease!.adapter.info
    return {
      maxTextureSize: device.limits.maxTextureDimension2D,
      max3DTextureSize: device.limits.maxTextureDimension3D,
      float32Filterable: device.features.has('float32-filterable'),
      rendererInfo: info.description || info.device || 'WebGPU',
      vendorInfo: info.vendor,
    }
  }
  getResourceStats() {
    return {
      backend: this.backend,
      shaderVariant: this.variants?.activeKey ?? 'generic',
      frames: this.frames?.getStats(),
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
  dispose() {
    this.disposed = true
    this.frames?.dispose()
    this.variants?.dispose()
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
