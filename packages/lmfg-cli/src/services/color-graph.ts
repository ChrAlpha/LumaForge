import type {
  ExportColorGraphDescriptor,
  LUTData,
  RawRenderExposure,
  SupportedExportColorGraphDescriptor,
  UserColorIntentInput,
  UserColorScalarKey,
} from '@lumaforge/luma-color-runtime'
import {
  exposureMultiplierFromEv,
  HSL_BAND_IDS,
  normalizeUserColorIntent,
  resolveExportColorGraph,
  resolveRawRenderExposure,
} from '@lumaforge/luma-color-runtime'
import type { RenderParams as ManifestRenderParams } from '@lumaforge/render-engine'
import { projectManifestRenderParams } from '@lumaforge/render-engine'

import { LmfgError } from '../protocol/errors'
import type { RenderParams, UserColorParamKey } from '../schemas/params'
import { parseRenderParams, USER_COLOR_PARAM_KEYS } from '../schemas/params'

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

const USER_COLOR_PARAM_ENTRIES = Object.entries(USER_COLOR_PARAM_KEYS) as [
  UserColorParamKey,
  UserColorScalarKey,
][]

/** The user color a CLI params record asks for, under the shared field names. */
function toUserColorIntent(params: RenderParams): UserColorIntentInput {
  const intent: Partial<Record<UserColorScalarKey, number>> = {}
  for (const [key, shared] of USER_COLOR_PARAM_ENTRIES) {
    intent[shared] = params[key]
  }
  return { ...intent, selectiveColor: params.selective_color }
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
    ...normalizeUserColorIntent(toUserColorIntent(params)),
  })
}

/**
 * A LUT reaches the graph only through `resolveLutContract`, which refuses an
 * unsupported output under its own code first; a pipeline the graph still
 * refuses is reported as an incomplete contract, as an export that refuses
 * its pipeline is.
 */
export function requireSupportedGraph(
  graph: ExportColorGraphDescriptor,
): SupportedExportColorGraphDescriptor {
  if (graph.supported) return graph
  throw new LmfgError('lut.contract.incomplete', {
    message: graph.message,
    retryable: true,
    suggestedNextActions: [
      'lmfg lut contract infer --lut <file.cube>',
      'lmfg lut contract validate --lut <file.cube> --contract <contract.json>',
    ],
  })
}

export function toManifestRenderParams(
  params: RenderParams,
  exposure: RawRenderExposure,
): ManifestRenderParams {
  return projectManifestRenderParams({
    userColor: toUserColorIntent(params),
    intensity: params.intensity,
    rawRenderExposure: { ev: exposure.ev, source: exposure.source },
  })
}

/** The recorded HSL bands under their CLI shape; a current record holds all eight. */
function recordedSelectiveColor(
  recorded: ManifestRenderParams['selective_color'],
): Record<string, unknown> | null {
  if (!recorded) return null
  return Object.fromEntries(
    HSL_BAND_IDS.map((id) => {
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
}

/**
 * Inverse of `toManifestRenderParams`: rebuild CLI params from a manifest so a
 * render can be replayed. Every value is read as recorded and goes through the
 * params schema as written, so a value outside it is refused rather than
 * clamped, and the recorded raw-render exposure becomes an explicit EV. The
 * LUT reference is resolved separately by the caller. Callers read the
 * manifest through `parseRenderManifest` first, which refuses a record
 * missing any of these fields: this reads, it does not verify or fill
 * anything in.
 */
export function manifestToRenderParams(
  params: ManifestRenderParams,
): RenderParams {
  return parseRenderParams({
    exposure_ev: params.exposure_ev,
    contrast: params.tone_curve.contrast,
    highlights: params.tone_curve.highlights,
    shadows: params.tone_curve.shadows,
    whites: params.tone_curve.whites,
    blacks: params.tone_curve.blacks,
    temperature: params.color_balance.temperature,
    tint: params.color_balance.tint,
    saturation: params.saturation.saturation,
    vibrance: params.saturation.vibrance,
    intensity: params.intensity,
    raw_render_exposure: params.raw_render_exposure_ev,
    selective_color: recordedSelectiveColor(params.selective_color),
    lut: null,
  })
}
