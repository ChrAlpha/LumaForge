export const USER_EXPOSURE_EV_MIN = -5
export const USER_EXPOSURE_EV_MAX = 5
export const USER_CONTRAST_MIN = -100
export const USER_CONTRAST_MAX = 100
export const USER_REGIONAL_TONE_MIN = -100
export const USER_REGIONAL_TONE_MAX = 100
export const USER_CONTRAST_PIVOT = 0.18
export const USER_REGIONAL_TONE_PIVOT = 0.18
export const LINEAR_PROPHOTO_LUMINANCE = [
  0.2880402, 0.7118741, 0.0000857,
] as const

export interface LumaColorToneParams {
  userExposureEv: number
  userContrast: number
  userHighlights: number
  userShadows: number
  userWhites: number
  userBlacks: number
}

export interface ResolvedToneParams extends LumaColorToneParams {
  userExposureMultiplier: number
  userContrastFactor: number
  contrastPivot: number
  regionalTonePivot: number
  luminanceCoefficients: readonly [number, number, number]
}

export interface RegionalToneScaleInput {
  highlights: number
  shadows: number
  whites: number
  blacks: number
  pivot?: number
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

function finiteOrDefault(value: unknown, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export function userExposureMultiplierFromEv(ev: number) {
  return Math.pow(2, ev)
}

export function contrastFactorFromAmount(amount: number) {
  return Math.pow(2, amount / 200)
}

function regionalAmountToEv(amount: number, maxAbsEv: number) {
  return (amount / 100) * maxAbsEv
}

function smoothstep(edge0: number, edge1: number, value: number) {
  if (value <= edge0) return 0
  if (value >= edge1) return 1
  const t = (value - edge0) / (edge1 - edge0)
  return t * t * (3 - 2 * t)
}

// The scale contrast applies to an RGB triple of linear luminance `luminance`:
// the luminance maps through a power curve around the pivot, so black and
// the pivot stay put and RGB ratios are kept.
export function contrastScaleFromLuminance(
  luminance: number,
  factor: number,
  pivot: number,
) {
  if (luminance <= 0) return 0
  const targetY = pivot * Math.pow(luminance / pivot, factor)
  return targetY / luminance
}

export function hasRegionalTone(input: RegionalToneScaleInput) {
  return (
    input.highlights !== 0 ||
    input.shadows !== 0 ||
    input.whites !== 0 ||
    input.blacks !== 0
  )
}

// Called only for positive luminance with some regional tone set.
function regionalToneEvFromLuminance(
  luminance: number,
  input: RegionalToneScaleInput,
) {
  const logLuminance = Math.log2(
    luminance / (input.pivot ?? USER_REGIONAL_TONE_PIVOT),
  )
  const highlightsMask = smoothstep(-1, 3, logLuminance)
  const shadowsMask = 1 - smoothstep(-4, 1, logLuminance)
  const whitesMask = smoothstep(2, 5.5, logLuminance)
  const blacksMask = 1 - smoothstep(-8, -3, logLuminance)

  return (
    highlightsMask * regionalAmountToEv(input.highlights, 1.25) +
    shadowsMask * regionalAmountToEv(input.shadows, 1.25) +
    whitesMask * regionalAmountToEv(input.whites, 1) +
    blacksMask * regionalAmountToEv(input.blacks, 1)
  )
}

export function regionalToneScaleFromLuminance(
  luminance: number,
  input: RegionalToneScaleInput,
) {
  if (!hasRegionalTone(input)) return 1
  if (luminance <= 0) return 0
  return Math.pow(2, regionalToneEvFromLuminance(luminance, input))
}

export function normalizeToneParams(
  input?: Partial<LumaColorToneParams> | null,
): LumaColorToneParams {
  return {
    userExposureEv: clamp(
      finiteOrDefault(input?.userExposureEv, 0),
      USER_EXPOSURE_EV_MIN,
      USER_EXPOSURE_EV_MAX,
    ),
    userContrast: clamp(
      finiteOrDefault(input?.userContrast, 0),
      USER_CONTRAST_MIN,
      USER_CONTRAST_MAX,
    ),
    userHighlights: clamp(
      finiteOrDefault(input?.userHighlights, 0),
      USER_REGIONAL_TONE_MIN,
      USER_REGIONAL_TONE_MAX,
    ),
    userShadows: clamp(
      finiteOrDefault(input?.userShadows, 0),
      USER_REGIONAL_TONE_MIN,
      USER_REGIONAL_TONE_MAX,
    ),
    userWhites: clamp(
      finiteOrDefault(input?.userWhites, 0),
      USER_REGIONAL_TONE_MIN,
      USER_REGIONAL_TONE_MAX,
    ),
    userBlacks: clamp(
      finiteOrDefault(input?.userBlacks, 0),
      USER_REGIONAL_TONE_MIN,
      USER_REGIONAL_TONE_MAX,
    ),
  }
}

export function resolveToneParams(
  input?: Partial<LumaColorToneParams> | null,
): ResolvedToneParams {
  const normalized = normalizeToneParams(input)
  return {
    ...normalized,
    userExposureMultiplier: userExposureMultiplierFromEv(
      normalized.userExposureEv,
    ),
    userContrastFactor: contrastFactorFromAmount(normalized.userContrast),
    contrastPivot: USER_CONTRAST_PIVOT,
    regionalTonePivot: USER_REGIONAL_TONE_PIVOT,
    luminanceCoefficients: LINEAR_PROPHOTO_LUMINANCE,
  }
}
