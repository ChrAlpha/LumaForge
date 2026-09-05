import type {
  ExportColorGraphDescriptor,
  HSLBandId,
  HSLBandShift,
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
  ColorGraphDescriptor,
  ColorGraphIdentity,
  RenderParams as ManifestRenderParams,
} from '@lumaforge/render-engine'
import {
  COLOR_GRAPH_DESCRIPTOR_VERSION,
  colorGraphIdentity,
  describeColorGraph,
  fingerprintColorGraph,
} from '@lumaforge/render-engine'

import { LmfgError } from '../protocol/errors'
import type { RenderParams, SelectiveColorInput } from '../schemas/params'
import { HSL_BAND_IDS, parseRenderParams } from '../schemas/params'

// The descriptor and fingerprint live in `@lumaforge/render-engine/manifest`
// so the browser app and the CLI hash color graphs identically.
export {
  COLOR_GRAPH_DESCRIPTOR_VERSION,
  describeColorGraph,
  fingerprintColorGraph,
}
export type { ColorGraphDescriptor }

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

export function toColorGraphIdentity(
  graph: SupportedExportColorGraphDescriptor,
): ColorGraphIdentity {
  return colorGraphIdentity(graph)
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
