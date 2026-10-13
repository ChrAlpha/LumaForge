import {
  reportGpuPreviewFailure,
  resolvePreviewBackend,
} from '~/lib/preview/gpu-backend'

import type { WebGPUProcessingPipeline } from './pipeline'

export type { PipelineStats, RawUploadInput } from './contract'

/** Public renderer contract, without the executor's private resource state. */
export type PreviewPipelineBackend = Pick<
  WebGPUProcessingPipeline,
  keyof WebGPUProcessingPipeline
>

export interface RawProcessingPipelineOptions {
  /**
   * Whether this pipeline's failures move the whole preview to the CPU
   * executor. Only the primary preview does; auxiliary pipelines (the
   * original compare layer, reference snapshots) report to their owner, which
   * degrades compare along `dual-gpu -> jpeg-fallback -> processed-only`.
   */
  reportFailures?: boolean
}

/**
 * Stable preview boundary shared by interactive, compare, and export clients.
 * Construction is synchronous; `initialize()` resolves the preview backend and
 * lazy-loads the WebGPU executor. A CPU backend is never rendered from here.
 */
export class RawProcessingPipeline {
  private activeRenderer: WebGPUProcessingPipeline | null = null
  private backendName: 'webgpu' | null = null
  private disposed = false
  private readonly disposeListeners = new Set<() => void>()
  private initialization: Promise<void> | null = null
  private readonly reportFailures: boolean

  constructor(
    private readonly canvas: HTMLCanvasElement,
    { reportFailures = true }: RawProcessingPipelineOptions = {},
  ) {
    this.reportFailures = reportFailures
  }

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
        this.renderer.dispose()
        throw new Error('PREVIEW_PIPELINE_DISPOSED')
      }
      this.canvas.dataset.renderBackend = this.backendName
      this.renderer.onLost((error) => {
        if (!this.disposed && this.reportFailures)
          reportGpuPreviewFailure(error)
      })
    } catch (error) {
      if (
        !this.disposed &&
        this.reportFailures &&
        this.backendName === 'webgpu'
      )
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
    const renderer = this.renderer
    try {
      return renderer.uploadLUT(...args)
    } catch (error) {
      // The executor drops its LUT on a failed upload. A primary preview
      // without the selected LUT would misstate the look, so it moves to the
      // CPU executor; the caller still sees the failure.
      if (!this.disposed && this.reportFailures) reportGpuPreviewFailure(error)
      throw error
    }
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

  getLutData() {
    return this.activeRenderer?.getLutData() ?? null
  }

  render() {
    return this.renderer.render()
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

  getLastSnapshotPlan() {
    return this.renderer.getLastSnapshotPlan()
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

  /**
   * Owners hear about disposal whoever triggers it, including export memory
   * evacuation through a published handle. Each listener runs once, after the
   * renderer is released; subscribers that arrive after disposal hear at once.
   */
  onDisposed(listener: () => void): () => void {
    if (this.disposed) {
      listener()
      return () => {}
    }
    this.disposeListeners.add(listener)
    return () => {
      this.disposeListeners.delete(listener)
    }
  }

  /** Releases the renderer once; repeated calls are no-ops. */
  dispose() {
    if (this.disposed) return
    this.disposed = true
    try {
      this.activeRenderer?.dispose()
    } finally {
      const listeners = [...this.disposeListeners]
      this.disposeListeners.clear()
      for (const listener of listeners) listener()
    }
  }
}
