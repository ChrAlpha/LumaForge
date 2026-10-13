// Shared projection of user color intent onto manifest `render_params`.
//
// `render_params` records the user color, the look strength, the RAW render
// exposure and the geometry. It never records the look selection (style kind,
// built-in preset) or the LUT; readers take those from the manifest `lut`
// identity and their own context, never from `render_params`.

import type {
  RawRenderExposureSource,
  UserColorIntentInput,
} from '@lumaforge/luma-color-runtime'
import {
  isSelectiveColorNeutral,
  normalizeUserColorIntent,
} from '@lumaforge/luma-color-runtime'

import type { GeometryParams, RenderParams } from './render-manifest'

/** The RAW render exposure a manifest records, with its provenance. */
export interface RecordedRawRenderExposure {
  readonly ev: number
  readonly source: RawRenderExposureSource
}

export interface ManifestRenderParamsInput {
  /** User color; missing fields and HSL read as neutral. */
  readonly userColor: UserColorIntentInput
  /** Look strength the color graph used, continuous in 0..1; recorded as is. */
  readonly intensity: number
  readonly rawRenderExposure: RecordedRawRenderExposure
  /** Present only when a geometry was applied at full resolution. */
  readonly geometry?: GeometryParams
}

/**
 * Project user color intent onto the manifest `render_params` shape. User
 * fields are recorded the way the color graph reads them (non-finite values
 * neutral, values clamped to their bounds). Selective color is recorded as
 * all eight bands, and omitted when it shifts nothing.
 */
export function projectManifestRenderParams(
  input: ManifestRenderParamsInput,
): RenderParams {
  const color = normalizeUserColorIntent(input.userColor)
  return {
    ...(input.geometry ? { geometry: input.geometry } : {}),
    exposure_ev: color.userExposureEv,
    tone_curve: {
      contrast: color.userContrast,
      highlights: color.userHighlights,
      shadows: color.userShadows,
      whites: color.userWhites,
      blacks: color.userBlacks,
    },
    color_balance: {
      temperature: color.userTemperature,
      tint: color.userTint,
    },
    saturation: {
      saturation: color.userSaturation,
      vibrance: color.userVibrance,
    },
    ...(isSelectiveColorNeutral(color.selectiveColor)
      ? {}
      : { selective_color: color.selectiveColor }),
    intensity: input.intensity,
    raw_render_exposure_ev: input.rawRenderExposure.ev,
    raw_render_exposure_source: input.rawRenderExposure.source,
  }
}
