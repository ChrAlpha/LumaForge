import {
  reportGpuPreviewFailure,
  resolvePreviewBackend,
} from '~/lib/preview/gpu-backend'

import type { WebGPUProcessingPipeline } from './pipeline'

export type {
  ExportRenderStats,
  PipelineStats,
  PipelineTelemetrySnapshot,
  PipelineTransformPath,
  RawUploadInput,
  RawUploadInputFormat,
  RenderOptions,
} from './contract'

/** Public renderer contract, without the executor's private resource state. */
export type PreviewPipelineBackend = Pick<
  WebGPUProcessingPipeline,
  keyof WebGPUProcessingPipeline
>

/**
 * Stable preview boundary shared by interactive, compare, and export clients.
 * Construction is synchronous; `initialize()` resolves the preview backend and
 * lazy-loads the WebGPU executor. A CPU backend is never rendered from here.
 */
export class RawProcessingPipeline {
  private activeRenderer: WebGPUProcessingPipeline | null = null
  private backendName: 'webgpu' | null = null
  private disposed = false
  private initialization: Promise<void> | null = null

  constructor(private readonly canvas: HTMLCanvasElement) {}

  private get renderer(): WebGPUProcessingPipeline {
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
      const facts = await resolvePreviewBackend()
      if (this.disposed) throw new Error('PREVIEW_PIPELINE_DISPOSED')
      if (facts.backend !== 'webgpu') throw new Error('GPU_PREVIEW_UNAVAILABLE')
      this.backendName = 'webgpu'
      const { WebGPUProcessingPipeline } = await import('./pipeline')
      if (this.disposed) throw new Error('PREVIEW_PIPELINE_DISPOSED')
      this.activeRenderer = new WebGPUProcessingPipeline(this.canvas)
      await this.renderer.initialize()
      if (this.disposed) {
        this.renderer.dispose({ releaseContext: true })
        throw new Error('PREVIEW_PIPELINE_DISPOSED')
      }
      this.canvas.dataset.renderBackend = this.backendName
      this.renderer.onLost(() => {
        if (!this.disposed) reportGpuPreviewFailure()
      })
    } catch (error) {
      if (!this.disposed && this.backendName === 'webgpu')
        reportGpuPreviewFailure()
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
  waitForGpu(): Promise<void> {
    return this.renderer.waitForGpu()
  }

  readProcessedPixelsAsync(): Promise<Float32Array | null> {
    return this.renderer.readProcessedPixelsAsync()
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
    return this.activeRenderer?.getResourceStats() ?? { estimatedBytes: 0 }
  }

  dispose(...args: Parameters<PreviewPipelineBackend['dispose']>) {
    this.disposed = true
    return this.activeRenderer?.dispose(...args)
  }
}
