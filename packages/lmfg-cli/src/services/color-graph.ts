import type {
  ExportColorGraphDescriptor,
  LUTData,
  RawRenderExposure,
  SupportedExportColorGraphDescriptor,
  UserColorIntent,
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
  invertManifestRenderParams,
  projectManifestRenderParams,
} from '@lumaforge/render-engine'

import { LmfgError } from '../protocol/errors'
import type { RenderParams, UserColorParamKey } from '../schemas/params'
import {
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

/**
 * The CLI params fields for a user color. HSL that shifts nothing becomes
 * `null`, the same as a params file that states none.
 */
function fromUserColorIntent(
  color: UserColorIntent,
): Pick<RenderParams, UserColorParamKey | 'selective_color'> {
  const fields = {} as Record<UserColorParamKey, number>
  for (const [key, shared] of USER_COLOR_PARAM_ENTRIES) {
    fields[key] = color[shared]
  }
  return {
    ...fields,
    selective_color: isSelectiveColorNeutral(color.selectiveColor)
      ? null
      : color.selectiveColor,
  }
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

/**
 * Inverse of `toManifestRenderParams`: rebuild CLI params from a manifest so a
 * render can be replayed. The recorded raw-render exposure becomes an explicit
 * EV; a manifest that records no strength gets the CLI default. The LUT
 * reference is resolved separately by the caller. Callers verify the
 * manifest's own signature first: this reads, it does not verify.
 */
export function manifestToRenderParams(
  params: ManifestRenderParams,
): RenderParams {
  const intent = invertManifestRenderParams(params)
  return parseRenderParams({
    ...fromUserColorIntent(intent.userColor),
    intensity: intent.intensity ?? PARAM_DEFAULTS.intensity,
    raw_render_exposure: intent.rawRenderExposure?.ev ?? 'auto',
    lut: null,
  })
}
