import type {
  ExportColorGraphDescriptor,
  ExportColorGraphStep,
  LUTData,
  RawRenderExposure,
  SupportedExportColorGraphDescriptor,
} from '@lumaforge/luma-color-runtime'
import {
  exposureMultiplierFromEv,
  resolveExportColorGraph,
  resolveRawRenderExposure,
} from '@lumaforge/luma-color-runtime'
import type {
  ColorGraphIdentity,
  RenderParams as ManifestRenderParams,
} from '@lumaforge/render-engine'
import { canonicalizeJson, sha256Hex } from '@lumaforge/render-engine'

import { LmfgError } from '../protocol/errors'
import type { RenderParams } from '../schemas/params'

export type ExposureSourceFrame = {
  data: Uint16Array
  width: number
  height: number
}

export function resolveExposure(
  params: RenderParams,
  source: {
    baselineExposure: number | undefined
    frame: ExposureSourceFrame | null
  },
): RawRenderExposure {
  if (params.raw_render_exposure !== 'auto') {
    const ev = params.raw_render_exposure
    return { ev, multiplier: exposureMultiplierFromEv(ev), source: 'user' }
  }
  return resolveRawRenderExposure({
    metadata: { baselineExposure: source.baselineExposure },
    image: source.frame,
  })
}

export function buildColorGraph(
  params: RenderParams,
  lut: LUTData | null,
  exposure: RawRenderExposure,
): ExportColorGraphDescriptor {
  return resolveExportColorGraph({
    styleKind: lut ? 'custom' : 'none',
    intensity: params.intensity,
    builtinPreset: null,
    lut,
    rawRenderExposure: exposure,
    userExposureEv: params.exposure_ev,
    userContrast: params.contrast,
    userHighlights: params.highlights,
    userShadows: params.shadows,
    userWhites: params.whites,
    userBlacks: params.blacks,
    userTemperature: params.temperature,
    userTint: params.tint,
    userSaturation: params.saturation,
    userVibrance: params.vibrance,
  })
}

export function requireSupportedGraph(
  graph: ExportColorGraphDescriptor,
): SupportedExportColorGraphDescriptor {
  if (graph.supported) return graph
  const unsupportedOutput = /output (?:transfer|range)/i.test(graph.message)
  throw new LmfgError(
    unsupportedOutput
      ? 'lut.contract.unsupported_output'
      : 'lut.contract.incomplete',
    {
      message: graph.message,
      retryable: true,
      suggestedNextActions: [
        'lmfg lut contract infer --lut <file.cube>',
        'lmfg lut contract validate --lut <file.cube> --contract <contract.json>',
      ],
    },
  )
}

export type ColorGraphDescriptorV1 = {
  descriptor_version: 1
  output_gamut: string
  output_transfer: string
  lut_profile: unknown
  steps: unknown[]
}

function toJsonSafe(value: unknown): unknown {
  if (ArrayBuffer.isView(value))
    return Array.from(value as unknown as ArrayLike<number>)
  if (Array.isArray(value)) return value.map(toJsonSafe)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        toJsonSafe(item),
      ]),
    )
  }
  return value
}

function describeStep(step: ExportColorGraphStep): unknown {
  if (step.kind === 'lut3d') {
    const bytes = new Uint8Array(
      step.data.buffer,
      step.data.byteOffset,
      step.data.byteLength,
    )
    return {
      kind: 'lut3d',
      size: step.size,
      domain_min: [...step.domainMin],
      domain_max: [...step.domainMax],
      data_length: step.data.length,
      data_sha256: sha256Hex(bytes),
      data_encoding: 'float32-le',
    }
  }
  return toJsonSafe(step)
}

export function describeColorGraph(
  graph: SupportedExportColorGraphDescriptor,
): ColorGraphDescriptorV1 {
  return {
    descriptor_version: 1,
    output_gamut: graph.outputGamut,
    output_transfer: graph.outputTransfer,
    lut_profile: toJsonSafe(graph.lutProfile),
    steps: graph.steps.map(describeStep),
  }
}

const TEXT_ENCODER = new TextEncoder()

export function fingerprintColorGraph(
  descriptor: ColorGraphDescriptorV1,
): string {
  return sha256Hex(TEXT_ENCODER.encode(canonicalizeJson(descriptor)))
}

export function toColorGraphIdentity(
  graph: SupportedExportColorGraphDescriptor,
): ColorGraphIdentity {
  const descriptor = describeColorGraph(graph)
  return { fingerprint: fingerprintColorGraph(descriptor), descriptor }
}

export function toManifestRenderParams(
  params: RenderParams,
  exposure: RawRenderExposure,
): ManifestRenderParams {
  return {
    exposure_ev: params.exposure_ev,
    tone_curve: {
      contrast: params.contrast,
      highlights: params.highlights,
      shadows: params.shadows,
      whites: params.whites,
      blacks: params.blacks,
    },
    color_balance: { temperature: params.temperature, tint: params.tint },
    saturation: { saturation: params.saturation, vibrance: params.vibrance },
    intensity: params.intensity,
    raw_render_exposure_ev: exposure.ev,
    raw_render_exposure_source: exposure.source,
  }
}
