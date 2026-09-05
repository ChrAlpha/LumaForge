import type {
  ExportColorGraphDescriptor,
  ExportColorGraphStep,
  HSLBandId,
  HSLBandShift,
  LUTColorProfile,
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
import type { RenderParams, SelectiveColorInput } from '../schemas/params'
import { HSL_BAND_IDS, parseRenderParams } from '../schemas/params'

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

export function toSelectiveColorBands(
  input: SelectiveColorInput | null | undefined,
): Record<HSLBandId, HSLBandShift> | undefined {
  if (!input) return undefined
  const bands = {} as Record<HSLBandId, HSLBandShift>
  for (const id of HSL_BAND_IDS) {
    const band = input[id]
    bands[id] = {
      hue: band?.hue ?? 0,
      saturation: band?.saturation ?? 0,
      lightness: band?.lightness ?? 0,
    }
  }
  return bands
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
    selectiveColor: toSelectiveColorBands(params.selective_color),
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

export const COLOR_GRAPH_DESCRIPTOR_VERSION = 2 as const

export type ColorGraphLutProfileDescriptor = {
  role: string
  input: { gamut: string; transfer: string; range: string }
  output: { gamut: string; transfer: string; range: string }
}

export type ColorGraphDescriptorV1 = {
  descriptor_version: typeof COLOR_GRAPH_DESCRIPTOR_VERSION
  output_gamut: string
  output_transfer: string
  lut_profile: ColorGraphLutProfileDescriptor | null
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

/**
 * Only the effective color contract matters for the rendered result, so the
 * descriptor records that instead of the registry profile object (labels,
 * aliases, and optional-field presence would otherwise leak into the hash).
 */
function describeLutProfile(
  profile: LUTColorProfile | null,
): ColorGraphLutProfileDescriptor | null {
  if (!profile) return null
  const outputTransfer =
    profile.outputTransfer ??
    (profile.role === 'display-look' ? profile.inputTransfer : 'unknown')
  return {
    role: profile.role,
    input: {
      gamut: profile.inputGamut,
      transfer: profile.inputTransfer,
      range: profile.inputRange,
    },
    output: {
      gamut: profile.outputGamut ?? profile.inputGamut,
      transfer: outputTransfer,
      range: profile.outputRange ?? 'full',
    },
  }
}

export function describeColorGraph(
  graph: SupportedExportColorGraphDescriptor,
): ColorGraphDescriptorV1 {
  return {
    descriptor_version: COLOR_GRAPH_DESCRIPTOR_VERSION,
    output_gamut: graph.outputGamut,
    output_transfer: graph.outputTransfer,
    lut_profile: describeLutProfile(graph.lutProfile),
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
    ...(params.selective_color
      ? { selective_color: toSelectiveColorBands(params.selective_color) }
      : {}),
    intensity: params.intensity,
    raw_render_exposure_ev: exposure.ev,
    raw_render_exposure_source: exposure.source,
  }
}

/**
 * Inverse of `toManifestRenderParams`: rebuild CLI params from a manifest so a
 * render can be replayed. The recorded raw-render exposure becomes an explicit
 * EV; the LUT reference is resolved separately by the caller.
 */
export function manifestToRenderParams(
  params: ManifestRenderParams,
): RenderParams {
  const recorded = params.selective_color
  const selective = recorded
    ? Object.fromEntries(
        HSL_BAND_IDS.filter((id) => recorded[id]).map((id) => {
          const band = recorded[id]
          return [
            id,
            {
              hue: band.hue,
              saturation: band.saturation,
              lightness: band.lightness,
            },
          ]
        }),
      )
    : null
  return parseRenderParams({
    exposure_ev: params.exposure_ev,
    contrast: params.tone_curve?.contrast ?? 0,
    highlights: params.tone_curve?.highlights ?? 0,
    shadows: params.tone_curve?.shadows ?? 0,
    whites: params.tone_curve?.whites ?? 0,
    blacks: params.tone_curve?.blacks ?? 0,
    temperature: params.color_balance?.temperature ?? 0,
    tint: params.color_balance?.tint ?? 0,
    saturation: params.saturation?.saturation ?? 0,
    vibrance: params.saturation?.vibrance ?? 0,
    intensity: params.intensity ?? 1,
    raw_render_exposure:
      typeof params.raw_render_exposure_ev === 'number'
        ? params.raw_render_exposure_ev
        : 'auto',
    selective_color:
      selective && Object.keys(selective).length > 0 ? selective : null,
    lut: null,
  })
}
