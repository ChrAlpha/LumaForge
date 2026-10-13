import { LINEAR_PROPHOTO_LUMINANCE } from './tone'

export const USER_TEMPERATURE_MIN = -100
export const USER_TEMPERATURE_MAX = 100
export const USER_TINT_MIN = -100
export const USER_TINT_MAX = 100
export const COLOR_BALANCE_TEMP_MAX_EV = 0.22
export const COLOR_BALANCE_TINT_MAX_EV = 0.16
export const COLOR_BALANCE_TINT_RED_BLUE_SHARE = 0.35

export interface LumaColorBalanceParams {
  userTemperature: number
  userTint: number
}

export interface ResolvedColorBalanceParams extends LumaColorBalanceParams {
  gain: readonly [number, number, number]
  operator: 'linear-prophoto-relative-rgb-gain'
  luminanceCoefficients: readonly [number, number, number]
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

function finiteOrDefault(value: unknown, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export function normalizeColorBalanceParams(
  input?: Partial<LumaColorBalanceParams> | null,
): LumaColorBalanceParams {
  return {
    userTemperature: clamp(
      finiteOrDefault(input?.userTemperature, 0),
      USER_TEMPERATURE_MIN,
      USER_TEMPERATURE_MAX,
    ),
    userTint: clamp(
      finiteOrDefault(input?.userTint, 0),
      USER_TINT_MIN,
      USER_TINT_MAX,
    ),
  }
}

export function resolveColorBalanceParams(
  input?: Partial<LumaColorBalanceParams> | null,
): ResolvedColorBalanceParams {
  const normalized = normalizeColorBalanceParams(input)
  if (normalized.userTemperature === 0 && normalized.userTint === 0) {
    return {
      ...normalized,
      gain: [1, 1, 1],
      operator: 'linear-prophoto-relative-rgb-gain',
      luminanceCoefficients: LINEAR_PROPHOTO_LUMINANCE,
    }
  }

  const temperatureNorm = normalized.userTemperature / 100
  const tintNorm = normalized.userTint / 100

  const rawR = Math.pow(
    2,
    temperatureNorm * COLOR_BALANCE_TEMP_MAX_EV +
      tintNorm * COLOR_BALANCE_TINT_MAX_EV * COLOR_BALANCE_TINT_RED_BLUE_SHARE,
  )
  const rawG = Math.pow(2, -tintNorm * COLOR_BALANCE_TINT_MAX_EV)
  const rawB = Math.pow(
    2,
    -temperatureNorm * COLOR_BALANCE_TEMP_MAX_EV +
      tintNorm * COLOR_BALANCE_TINT_MAX_EV * COLOR_BALANCE_TINT_RED_BLUE_SHARE,
  )

  const luminance =
    rawR * LINEAR_PROPHOTO_LUMINANCE[0] +
    rawG * LINEAR_PROPHOTO_LUMINANCE[1] +
    rawB * LINEAR_PROPHOTO_LUMINANCE[2]
  const lumaScale = 1 / Math.max(luminance, 1e-6)

  return {
    ...normalized,
    gain: [rawR * lumaScale, rawG * lumaScale, rawB * lumaScale],
    operator: 'linear-prophoto-relative-rgb-gain',
    luminanceCoefficients: LINEAR_PROPHOTO_LUMINANCE,
  }
}
