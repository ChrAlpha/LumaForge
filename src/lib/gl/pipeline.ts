import {
  getPreviewBackendSnapshot,
  reportGpuPreviewFailure,
  resolvePreviewBackend,
} from '~/lib/preview/gpu-backend'

import { RawProcessingPipeline as WebGLPipeline } from './webgl-pipeline'

export * from './webgl-pipeline'

/** Public renderer contract, without the backend's private resource state. */
export type PreviewPipelineBackend = Pick<WebGLPipeline, keyof WebGLPipeline>

type Renderer = PreviewPipelineBackend & {
  waitForGpu?: () => Promise<void>
  readProcessedPixelsAsync?: () => Promise<Float32Array | null>
  onLost?: (listener: (error: Error) => void) => () => void
  getResourceStats?: () => { estimatedBytes: number }
}

/** Stable preview boundary shared by interactive, compare, and export clients. */
export class RawProcessingPipeline implements PreviewPipelineBackend {
  private activeRenderer: Renderer | null = null
  private backendName: 'webgpu' | 'webgl2' | null = null
  private disposed = false
  private initialization: Promise<void> | null = null

  constructor(private readonly canvas: HTMLCanvasElement) {
    // Preserve the existing synchronous WebGL interface in environments with
    // no WebGPU API. WebGPU-capable browsers select a backend asynchronously.
    if (
      typeof navigator === 'undefined' ||
      !navigator.gpu ||
      getPreviewBackendSnapshot()?.backend === 'webgl2'
    ) {
      this.activeRenderer = new WebGLPipeline(canvas)
      this.backendName = 'webgl2'
    }
  }

  private get renderer(): Renderer {
    if (!this.activeRenderer)
      throw new Error('PREVIEW_PIPELINE_NOT_INITIALIZED')
    return this.activeRenderer
  }

  get backend() {
    return this.backendName
  }

  initialize(): Promise<void> {
    return (this.initialization ??= this.initializeRenderer())
  }

  private async initializeRenderer() {
    try {
      if (this.disposed) throw new Error('PREVIEW_PIPELINE_DISPOSED')
      if (!this.activeRenderer) {
        const facts = await resolvePreviewBackend()
        if (this.disposed) throw new Error('PREVIEW_PIPELINE_DISPOSED')
        if (facts.backend === 'cpu') throw new Error('GPU_PREVIEW_UNAVAILABLE')
        this.backendName = facts.backend
        if (facts.backend === 'webgpu') {
          const { WebGPUProcessingPipeline } =
            await import('~/lib/webgpu/pipeline')
          if (this.disposed) throw new Error('PREVIEW_PIPELINE_DISPOSED')
          this.activeRenderer = new WebGPUProcessingPipeline(this.canvas)
        } else this.activeRenderer = new WebGLPipeline(this.canvas)
      }
      await this.renderer.initialize()
      if (this.disposed) {
        this.renderer.dispose({ releaseContext: true })
        throw new Error('PREVIEW_PIPELINE_DISPOSED')
      }
      this.canvas.dataset.renderBackend = this.backendName!
      this.renderer.onLost?.((error) => {
        if (!this.disposed) reportGpuPreviewFailure(error)
      })
    } catch (error) {
      if (!this.disposed && this.backendName === 'webgpu')
        reportGpuPreviewFailure(error)
      throw error
    }
  }

  uploadImage(...args: Parameters<PreviewPipelineBackend['uploadImage']>) {
    return this.renderer.uploadImage(...args)
  }

  clearImage() {
    return this.renderer.clearImage()
  }

  uploadLUT(...args: Parameters<PreviewPipelineBackend['uploadLUT']>) {
    return this.renderer.uploadLUT(...args)
  }

  clearLUT() {
    return this.renderer.clearLUT()
  }

  setParams(...args: Parameters<PreviewPipelineBackend['setParams']>) {
    return this.renderer.setParams(...args)
  }

  getParams() {
    return this.renderer.getParams()
  }

  render(...args: Parameters<PreviewPipelineBackend['render']>) {
    return this.renderer.render(...args)
  }

  /** Wait only when a consumer needs completed pixels; never issue a new draw. */
  async waitForGpu(): Promise<void> {
    if (this.renderer.waitForGpu) await this.renderer.waitForGpu()
    else this.canvas.getContext('webgl2')?.finish()
  }

  readProcessedPixels() {
    return this.renderer.readProcessedPixels()
  }

  async readProcessedPixelsAsync(): Promise<Float32Array | null> {
    if (this.renderer.readProcessedPixelsAsync)
      return this.renderer.readProcessedPixelsAsync()
    return this.renderer.readProcessedPixels()
  }

  renderToHiddenCanvas(
    ...args: Parameters<PreviewPipelineBackend['renderToHiddenCanvas']>
  ) {
    return this.renderer.renderToHiddenCanvas(...args)
  }

  getLastExportStats() {
    return this.renderer.getLastExportStats()
  }

  resize(...args: Parameters<PreviewPipelineBackend['resize']>) {
    return this.renderer.resize(...args)
  }

  getCapabilities() {
    return this.renderer.getCapabilities()
  }

  getInputDimensions() {
    return this.renderer.getInputDimensions()
  }

  getResourceStats() {
    return this.activeRenderer?.getResourceStats?.() ?? { estimatedBytes: 0 }
  }

  dispose(...args: Parameters<PreviewPipelineBackend['dispose']>) {
    this.disposed = true
    return this.activeRenderer?.dispose(...args)
  }
}
