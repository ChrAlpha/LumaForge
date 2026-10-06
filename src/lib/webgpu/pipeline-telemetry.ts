import type {
  ColorGraphIntentSource,
  LUTData,
} from '@lumaforge/luma-color-runtime'
import { resolvePreviewColorPlan } from '@lumaforge/render-engine/preview'

import type {
  PipelineTelemetrySnapshot,
  PipelineTransformPath,
  PreviewGpuCapabilities,
  RawUploadInput,
} from './contract'

export function webGPUCapabilities(
  device: GPUDevice,
  adapter: GPUAdapter,
): PreviewGpuCapabilities {
  const info = adapter.info
  return {
    maxTextureSize: device.limits.maxTextureDimension2D,
    max3DTextureSize: device.limits.maxTextureDimension3D,
    float32Filterable: device.features.has('float32-filterable'),
    rendererInfo: info.description || info.device || 'WebGPU',
    vendorInfo: info.vendor,
  }
}

export function webGPUTelemetry(
  params: ColorGraphIntentSource,
  lut: LUTData | null,
  input: RawUploadInput | null,
): PipelineTelemetrySnapshot {
  // Report what the preview draws, from the same policy as the shader.
  const plan = resolvePreviewColorPlan({
    intent: params,
    lut,
    executor: 'webgpu',
  })
  const profile = plan.graph?.lutProfile ?? null
  let transformPath: PipelineTransformPath = 'no-lut'
  if (plan.effective.styleKind === 'builtin') transformPath = 'builtin-style'
  else if (profile) {
    const roles = {
      'display-look': 'display-lut',
      'scene-creative': 'scene-creative-lut',
      'combined-look-output': 'combined-output-lut',
      'technical-output': 'technical-output-lut',
    } as const
    transformPath = roles[profile.role]
  } else if (plan.selected.styleKind === 'custom' && lut)
    transformPath = 'disabled-lut'
  return {
    inputFormat: input?.layout === 'rgb-u16' ? 'uint16-rgb' : 'float-rgba',
    transformPath,
    lutRole: profile?.role ?? null,
    lutInputTransfer: profile?.inputTransfer ?? null,
    lutOutputTransfer:
      profile?.outputTransfer ??
      (profile?.role === 'display-look' ? profile.inputTransfer : null),
    lutSize: lut?.size ?? null,
  }
}
