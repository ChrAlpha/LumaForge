import { z } from 'zod'

export const LUT_ROLES = [
  'display-look',
  'scene-creative',
  'technical-output',
  'combined-look-output',
] as const
export const SIGNAL_RANGES = ['full', 'legal', 'unknown'] as const

export const LutContractInputSchema = z.strictObject({
  role: z.enum(LUT_ROLES),
  input_profile: z.string().min(1).optional(),
  input_gamut: z.string().min(1).optional(),
  input_transfer: z.string().min(1).optional(),
  input_range: z.enum(SIGNAL_RANGES).optional(),
  output_gamut: z.string().min(1).optional(),
  output_transfer: z.string().min(1).optional(),
  output_range: z.enum(SIGNAL_RANGES).optional(),
})

export const LutReferenceSchema = z.strictObject({
  path: z.string().min(1),
  contract: LutContractInputSchema.optional(),
})

const slider = (min: number, max: number) => z.number().min(min).max(max)

/** Field schemas without defaults — shared by the full and override shapes. */
const PARAM_FIELDS = {
  exposure_ev: slider(-5, 5),
  contrast: slider(-100, 100),
  highlights: slider(-100, 100),
  shadows: slider(-100, 100),
  whites: slider(-100, 100),
  blacks: slider(-100, 100),
  temperature: slider(-100, 100),
  tint: slider(-100, 100),
  saturation: slider(-100, 100),
  vibrance: slider(-100, 100),
  intensity: z.number().min(0).max(1),
  raw_render_exposure: z.union([z.literal('auto'), slider(-3, 3)]),
  lut: LutReferenceSchema.nullable(),
} as const

export const PARAM_DEFAULTS = {
  exposure_ev: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
  temperature: 0,
  tint: 0,
  saturation: 0,
  vibrance: 0,
  intensity: 1,
  raw_render_exposure: 'auto' as const,
  lut: null,
}

export const NUMERIC_PARAM_KEYS = [
  'exposure_ev',
  'contrast',
  'highlights',
  'shadows',
  'whites',
  'blacks',
  'temperature',
  'tint',
  'saturation',
  'vibrance',
  'intensity',
] as const
export type NumericParamKey = (typeof NUMERIC_PARAM_KEYS)[number]

export const RenderParamsSchema = z
  .strictObject({
    schema: z.literal('lmfg.params.v1').optional(),
    exposure_ev: PARAM_FIELDS.exposure_ev.default(PARAM_DEFAULTS.exposure_ev),
    contrast: PARAM_FIELDS.contrast.default(PARAM_DEFAULTS.contrast),
    highlights: PARAM_FIELDS.highlights.default(PARAM_DEFAULTS.highlights),
    shadows: PARAM_FIELDS.shadows.default(PARAM_DEFAULTS.shadows),
    whites: PARAM_FIELDS.whites.default(PARAM_DEFAULTS.whites),
    blacks: PARAM_FIELDS.blacks.default(PARAM_DEFAULTS.blacks),
    temperature: PARAM_FIELDS.temperature.default(PARAM_DEFAULTS.temperature),
    tint: PARAM_FIELDS.tint.default(PARAM_DEFAULTS.tint),
    saturation: PARAM_FIELDS.saturation.default(PARAM_DEFAULTS.saturation),
    vibrance: PARAM_FIELDS.vibrance.default(PARAM_DEFAULTS.vibrance),
    intensity: PARAM_FIELDS.intensity.default(PARAM_DEFAULTS.intensity),
    raw_render_exposure: PARAM_FIELDS.raw_render_exposure.default(
      PARAM_DEFAULTS.raw_render_exposure,
    ),
    lut: PARAM_FIELDS.lut.default(PARAM_DEFAULTS.lut),
  })
  .transform(({ schema: _schema, ...rest }) => rest)

export const RenderParamsOverrideSchema = z.strictObject({
  exposure_ev: PARAM_FIELDS.exposure_ev.optional(),
  contrast: PARAM_FIELDS.contrast.optional(),
  highlights: PARAM_FIELDS.highlights.optional(),
  shadows: PARAM_FIELDS.shadows.optional(),
  whites: PARAM_FIELDS.whites.optional(),
  blacks: PARAM_FIELDS.blacks.optional(),
  temperature: PARAM_FIELDS.temperature.optional(),
  tint: PARAM_FIELDS.tint.optional(),
  saturation: PARAM_FIELDS.saturation.optional(),
  vibrance: PARAM_FIELDS.vibrance.optional(),
  intensity: PARAM_FIELDS.intensity.optional(),
  raw_render_exposure: PARAM_FIELDS.raw_render_exposure.optional(),
  lut: PARAM_FIELDS.lut.optional(),
})

export type RenderParamsInput = z.input<typeof RenderParamsSchema>
export type RenderParams = z.output<typeof RenderParamsSchema>
export type RenderParamsOverride = z.output<typeof RenderParamsOverrideSchema>
export type LutReference = z.output<typeof LutReferenceSchema>
export type LutContractInput = z.output<typeof LutContractInputSchema>

export function parseRenderParams(input: unknown): RenderParams {
  return RenderParamsSchema.parse(input ?? {})
}

export function mergeRenderParams(
  base: RenderParams,
  override: RenderParamsOverride,
): RenderParams {
  const merged: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(override)) {
    if (value !== undefined) merged[key] = value
  }
  return RenderParamsSchema.parse(merged)
}
