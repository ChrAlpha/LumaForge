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
  isSelectiveColorNeutral,
  normalizeUserColorIntent,
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
  projectManifestRenderParams,
} from '@lumaforge/render-engine'

import { LmfgError } from '../protocol/errors'
import type { RenderParams, UserColorParamKey } from '../schemas/params'
import {
  HSL_BAND_IDS,
  PARAM_DEFAULTS,
  parseRenderParams,
  USER_COLOR_PARAM_KEYS,
} from '../schemas/params'

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
  return projectManifestRenderParams({
    userColor: toUserColorIntent(params),
    intensity: params.intensity,
    rawRenderExposure: { ev: exposure.ev, source: exposure.source },
  })
}

/** The recorded HSL bands under their CLI shape; unknown bands are not read. */
function recordedSelectiveColor(
  recorded: ManifestRenderParams['selective_color'],
): Record<string, unknown> | null {
  if (!recorded) return null
  const bands = HSL_BAND_IDS.filter((id) => recorded[id]).map((id) => {
    const band = recorded[id]
    return [
      id,
      { hue: band.hue, saturation: band.saturation, lightness: band.lightness },
    ]
  })
  return bands.length > 0 ? Object.fromEntries(bands) : null
}

/**
 * Inverse of `toManifestRenderParams`: rebuild CLI params from a manifest so a
 * render can be replayed. The recorded values go through the params schema as
 * written, so a value outside it is refused rather than clamped. Sections an
 * older writer did not record read as neutral, a missing strength as the CLI
 * default, and the recorded raw-render exposure becomes an explicit EV. HSL
 * that shifts nothing reads as none. The LUT reference is resolved separately
 * by the caller. Callers verify the manifest's own signature first: this
 * reads, it does not verify.
 */
export function manifestToRenderParams(
  params: ManifestRenderParams,
): RenderParams {
  const parsed = parseRenderParams({
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
    intensity: params.intensity ?? PARAM_DEFAULTS.intensity,
    raw_render_exposure:
      typeof params.raw_render_exposure_ev === 'number'
        ? params.raw_render_exposure_ev
        : 'auto',
    selective_color: recordedSelectiveColor(params.selective_color),
    lut: null,
  })
  return isSelectiveColorNeutral(parsed.selective_color)
    ? { ...parsed, selective_color: null }
    : parsed
}
