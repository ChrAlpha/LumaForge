/**
 * Renderer-neutral preview contract shared by the GPU preview executor and the
 * app. Nothing here touches a graphics API.
 */

export interface PreviewGpuCapabilities {
  maxTextureSize: number
  max3DTextureSize: number
  float32Filterable: boolean
  rendererInfo: string
  vendorInfo: string
}

export interface PipelineStats {
  processTime: number
  inputSize: { width: number; height: number }
  previewSize: { width: number; height: number }
}

/** The only GPU source: the decoder's linear ProPhoto RGB16 render. */
export interface RawUploadInput {
  data: Uint16Array
  width: number
  height: number
  renderExposureEv: number
  renderExposureMultiplier: number
}
