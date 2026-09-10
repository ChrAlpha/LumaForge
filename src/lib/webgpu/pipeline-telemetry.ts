import type { LUTData, ProcessingParams } from '@lumaforge/luma-color-runtime'
import { resolveExportColorGraph } from '@lumaforge/luma-color-runtime'

import type { WebGLCapabilities } from '~/lib/gl/context'
import type {
  PipelineTelemetrySnapshot,
  PipelineTransformPath,
  RawUploadInput,
} from '~/lib/gl/pipeline'
import { isLUTProfileRenderable } from '~/lib/gl/webgl-pipeline'

export function webGPUCapabilities(
  device: GPUDevice,
  adapter: GPUAdapter,
): WebGLCapabilities {
  const info = adapter.info
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

export function webGPUTelemetry(
  params: ProcessingParams,
  lut: LUTData | null,
  input: RawUploadInput | null,
): PipelineTelemetrySnapshot {
  const graph = resolveExportColorGraph({ ...params, lut: lut ?? null })
  const profile = graph.supported ? graph.lutProfile : null
  let transformPath: PipelineTransformPath = 'no-lut'
  if (params.styleKind === 'builtin') transformPath = 'builtin-style'
  else if (params.styleKind === 'custom' && lut) {
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
    inputFormat: input?.layout === 'rgb-u16' ? 'uint16-rgb' : 'float-rgba',
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
