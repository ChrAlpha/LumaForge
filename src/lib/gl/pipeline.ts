import { RawProcessingPipeline as WebGLPipeline } from './webgl-pipeline'

export * from './webgl-pipeline'

/** Public renderer contract, without the backend's private resource state. */
export type PreviewPipelineBackend = Pick<WebGLPipeline, keyof WebGLPipeline>

/** Stable preview boundary shared by interactive, compare, and export clients. */
export class RawProcessingPipeline implements PreviewPipelineBackend {
  private readonly renderer: PreviewPipelineBackend

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new WebGLPipeline(canvas)
  }

  get backend(): 'webgl2' {
    return 'webgl2'
  }

  initialize(): Promise<void> {
    return this.renderer.initialize()
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
    this.canvas.getContext('webgl2')?.finish()
  }

  readProcessedPixels() {
    return this.renderer.readProcessedPixels()
  }

  async readProcessedPixelsAsync(): Promise<Float32Array | null> {
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

  dispose(...args: Parameters<PreviewPipelineBackend['dispose']>) {
    return this.renderer.dispose(...args)
  }
}
