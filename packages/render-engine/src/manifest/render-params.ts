// Shared projection of user color intent onto manifest `render_params`, and
// its inverse for readers that replay a manifest.
//
// `render_params` records the user color, the look strength, the RAW render
// exposure and the geometry. It never records the look selection (style kind,
// built-in preset) or the LUT; readers take those from the manifest `lut`
// identity and their own context, never from `render_params`.

import type {
  RawRenderExposureSource,
  UserColorIntent,
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

/** What `render_params` says about a render, read back. */
export interface ManifestRenderParamsIntent {
  readonly userColor: UserColorIntent
  readonly intensity: number
  readonly rawRenderExposure: RecordedRawRenderExposure
  readonly geometry: GeometryParams | null
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

/**
 * Read `render_params` back into user color intent. Omitted selective color
 * reads as neutral, the only field a current record may leave out; every
 * other field is read as recorded. The look selection and LUT are not part
 * of the result.
 *
 * This projects params already typed as `RenderParams`; it validates
 * nothing. A manifest read from outside must pass `parseRenderManifest`
 * first, which verifies its hash and holds every executable field to the
 * shape the current writers record.
 */
export function invertManifestRenderParams(
  params: RenderParams,
): ManifestRenderParamsIntent {
  return {
    userColor: normalizeUserColorIntent({
      userExposureEv: params.exposure_ev,
      userContrast: params.tone_curve.contrast,
      userHighlights: params.tone_curve.highlights,
      userShadows: params.tone_curve.shadows,
      userWhites: params.tone_curve.whites,
      userBlacks: params.tone_curve.blacks,
      userTemperature: params.color_balance.temperature,
      userTint: params.color_balance.tint,
      userSaturation: params.saturation.saturation,
      userVibrance: params.saturation.vibrance,
      selectiveColor: params.selective_color,
    }),
    intensity: params.intensity,
    rawRenderExposure: {
      ev: params.raw_render_exposure_ev,
      source: params.raw_render_exposure_source,
    },
    geometry: params.geometry ?? null,
  }
}
