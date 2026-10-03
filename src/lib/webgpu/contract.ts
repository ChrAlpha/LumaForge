/**
 * Renderer-neutral preview contract shared by the GPU preview executor and the
 * app. Nothing here touches a graphics API.
 */

import type { LUTRole, TransferFunctionId } from '@lumaforge/luma-color-runtime'

export type {
  BuiltinStylePreset,
  LUTContractResolution,
  LUTData,
  LUTInputProfile,
  ProcessingParams,
} from '@lumaforge/luma-color-runtime'

export interface PreviewGpuCapabilities {
  webgl2: boolean
  maxTextureSize: number
  max3DTextureSize: number
  floatTextures: boolean
  floatTexturesLinear: boolean
  halfFloatTextures: boolean
  halfFloatTexturesLinear: boolean
  colorBufferFloat: boolean
  colorBufferHalfFloat: boolean
  maxVertexUniformVectors: number
  maxFragmentUniformVectors: number
  maxVaryingVectors: number
  fragmentHighFloatPrecision: number
  fragmentHighFloatRangeMin: number
  fragmentHighFloatRangeMax: number
  toneHighPrecision: boolean
  rendererInfo: string
  vendorInfo: string
}

export type ProcessTargetPrecision = 'rgba16f' | 'rgba8'

export type PipelineCapabilityWarningCode = 'LOW_PRECISION_RENDER_TARGET'

export interface PipelineCapabilityWarning {
  code: PipelineCapabilityWarningCode
  message: string
}

export interface PipelineStats {
  uploadTime: number
  lutUploadTime: number
  processTime: number
  totalTime: number
  inputSize: { width: number; height: number }
  previewSize: { width: number; height: number }
  inputFormat: RawUploadInputFormat
  transformPath: PipelineTransformPath
  lutRole: LUTRole | null
  lutInputTransfer: TransferFunctionId | null
  lutOutputTransfer: TransferFunctionId | null
  lutSize: number | null
  processTargetPrecision: ProcessTargetPrecision
  capabilityWarnings: PipelineCapabilityWarning[]
}

export interface RenderOptions {
  waitForGpu?: boolean
}

export type RawUploadInput =
  | {
      data: Float32Array
      width: number
      height: number
      layout: 'rgba-float32'
      colorSpace: 'display-srgb-preview'
    }
  | {
      data: Uint16Array
      width: number
      height: number
      layout: 'rgb-u16'
      colorSpace: 'linear-prophoto-rgb'
      renderExposureEv: number
      renderExposureMultiplier: number
    }

export type RawUploadInputFormat = 'float-rgba' | 'uint16-rgb'

export type PipelineTransformPath =
  | 'no-lut'
  | 'builtin-style'
  | 'display-lut'
  | 'scene-creative-lut'
  | 'combined-output-lut'
  | 'technical-output-lut'
  | 'disabled-lut'

export interface PipelineTelemetrySnapshot {
  inputFormat: RawUploadInputFormat
  transformPath: PipelineTransformPath
  lutRole: LUTRole | null
  lutInputTransfer: TransferFunctionId | null
  lutOutputTransfer: TransferFunctionId | null
  lutSize: number | null
  processTargetPrecision: ProcessTargetPrecision
  capabilityWarnings: PipelineCapabilityWarning[]
}

export interface ExportRenderStats extends PipelineTelemetrySnapshot {
  strategy: 'full-frame' | 'tiled' | 'fail'
  width: number
  height: number
  tileCount: number
  planningTime: number
  renderTime: number
  totalTime: number
  reason?:
    | 'texture-limit'
    | 'memory-budget'
    | 'canvas-limit'
    | 'gpu-limit'
    | 'render-failure'
  failureCode?: string
  failureMessage?: string
  retryable?: boolean
}

export function describeRawUploadInput(input: RawUploadInput): {
  inputFormat: RawUploadInputFormat
  channelCount: 3 | 4
  bytesPerPixel: 6 | 16
} {
  if (input.layout === 'rgb-u16') {
    return {
      inputFormat: 'uint16-rgb',
      channelCount: 3,
      bytesPerPixel: 6,
    }
  }

  return {
    inputFormat: 'float-rgba',
    channelCount: 4,
    bytesPerPixel: 16,
  }
}
