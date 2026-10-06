import type { LumaColorBalanceParams } from './color-balance'
import {
  normalizeColorBalanceParams,
  USER_TEMPERATURE_MAX,
  USER_TEMPERATURE_MIN,
  USER_TINT_MAX,
  USER_TINT_MIN,
} from './color-balance'
import type { LumaColorSaturationParams } from './saturation'
import {
  normalizeSaturationParams,
  USER_SATURATION_MAX,
  USER_SATURATION_MIN,
  USER_VIBRANCE_MAX,
  USER_VIBRANCE_MIN,
} from './saturation'
import type {
  LumaColorSelectiveColorParams,
  SelectiveColorBandsInput,
} from './selective-color'
import {
  HSL_BAND_IDS,
  HSL_SHIFT_AXES,
  HSL_SHIFT_MAX,
  HSL_SHIFT_MIN,
  NEUTRAL_SELECTIVE_COLOR,
  normalizeSelectiveColorParams,
} from './selective-color'
import type { LumaColorToneParams } from './tone'
import {
  normalizeToneParams,
  USER_CONTRAST_MAX,
  USER_CONTRAST_MIN,
  USER_EXPOSURE_EV_MAX,
  USER_EXPOSURE_EV_MIN,
  USER_REGIONAL_TONE_MAX,
  USER_REGIONAL_TONE_MIN,
} from './tone'
import type { BuiltinStylePreset } from './types'

/*
 * The color a user asks for, apart from how the photo is being viewed.
 *
 * `UserColorIntent` is the user's tone, color balance, saturation and HSL.
 * `LookSelection` is the look on top: none, a built-in preset or a custom
 * LUT, and its continuous strength. `ColorGraphIntent` is both together, the
 * full identity of the color graph a user asked for. View state (view mode,
 * compare split), RAW render exposure, LUT bytes and geometry are not part of
 * it.
 *
 * The look strength has no shared default: each entry point (app, CLI) passes
 * its own when it normalizes.
 */

/**
 * Freeze a list that must name every member of `Union`; leaving one out
 * fails to compile.
 */
function exhaustiveList<Union extends string>() {
  return <const List extends readonly Union[]>(
    list: List &
      ([Exclude<Union, List[number]>] extends [never] ? unknown : never),
  ): List => Object.freeze(list)
}

export type LookStyleKind = 'none' | 'builtin' | 'custom'

export const LOOK_STYLE_KINDS = exhaustiveList<LookStyleKind>()([
  'none',
  'builtin',
  'custom',
])

export const BUILTIN_STYLE_PRESETS = exhaustiveList<BuiltinStylePreset>()([
  'neutral',
  'warm',
  'cool',
  'film-soft',
  'film-contrast',
  'cinematic',
  'fade',
  'mono',
])

/** The user's numeric color fields, in pipeline order. */
export const USER_COLOR_SCALAR_KEYS = Object.freeze([
  'userExposureEv',
  'userContrast',
  'userHighlights',
  'userShadows',
  'userWhites',
  'userBlacks',
  'userTemperature',
  'userTint',
  'userSaturation',
  'userVibrance',
] as const)

export type UserColorScalarKey = (typeof USER_COLOR_SCALAR_KEYS)[number]

export const USER_COLOR_INTENT_KEYS = Object.freeze([
  ...USER_COLOR_SCALAR_KEYS,
  'selectiveColor',
] as const)

export const LOOK_SELECTION_KEYS = Object.freeze([
  'styleKind',
  'builtinPreset',
  'intensity',
] as const)

export const COLOR_GRAPH_INTENT_KEYS = Object.freeze([
  ...LOOK_SELECTION_KEYS,
  ...USER_COLOR_INTENT_KEYS,
] as const)

/** Every user color field, each one required. */
export interface UserColorIntent
  extends
    Readonly<LumaColorToneParams>,
    Readonly<LumaColorBalanceParams>,
    LumaColorSaturationParams,
    LumaColorSelectiveColorParams {}

/** User color as it may arrive: any field missing, HSL partial or null. */
export type UserColorIntentInput = Readonly<
  Partial<Record<UserColorScalarKey, number>>
> & {
  readonly selectiveColor?: SelectiveColorBandsInput | null
}

/**
 * Complete user color whose HSL may be missing, as in the legacy params.
 * Missing HSL reads as neutral.
 */
export type UserColorIntentSource = Omit<UserColorIntent, 'selectiveColor'> &
  Partial<Pick<UserColorIntent, 'selectiveColor'>>

/** The look applied on top of the user color, built-in presets included. */
export interface LookSelection {
  readonly styleKind: LookStyleKind
  readonly builtinPreset: BuiltinStylePreset | null
  /** Look strength, continuous in 0..1. */
  readonly intensity: number
}

export type LookSelectionInput = Readonly<Partial<LookSelection>>

/** The full color identity a user asked for: look and user color. */
export interface ColorGraphIntent extends LookSelection, UserColorIntent {}

export type ColorGraphIntentInput = LookSelectionInput & UserColorIntentInput

/** A complete intent whose HSL may be missing; legacy params are one. */
export type ColorGraphIntentSource = LookSelection & UserColorIntentSource

export interface LookIntensityEntry {
  /** The strength this entry point gives a look that states none. */
  readonly defaultIntensity: number
}

export interface ColorFieldBounds {
  readonly min: number
  readonly max: number
}

function bounds(min: number, max: number): ColorFieldBounds {
  return Object.freeze({ min, max })
}

/** The range each user field is clamped to. */
export const USER_COLOR_FIELD_BOUNDS: Readonly<
  Record<UserColorScalarKey, ColorFieldBounds>
> = Object.freeze({
  userExposureEv: bounds(USER_EXPOSURE_EV_MIN, USER_EXPOSURE_EV_MAX),
  userContrast: bounds(USER_CONTRAST_MIN, USER_CONTRAST_MAX),
  userHighlights: bounds(USER_REGIONAL_TONE_MIN, USER_REGIONAL_TONE_MAX),
  userShadows: bounds(USER_REGIONAL_TONE_MIN, USER_REGIONAL_TONE_MAX),
  userWhites: bounds(USER_REGIONAL_TONE_MIN, USER_REGIONAL_TONE_MAX),
  userBlacks: bounds(USER_REGIONAL_TONE_MIN, USER_REGIONAL_TONE_MAX),
  userTemperature: bounds(USER_TEMPERATURE_MIN, USER_TEMPERATURE_MAX),
  userTint: bounds(USER_TINT_MIN, USER_TINT_MAX),
  userSaturation: bounds(USER_SATURATION_MIN, USER_SATURATION_MAX),
  userVibrance: bounds(USER_VIBRANCE_MIN, USER_VIBRANCE_MAX),
})

/** The range every axis of every HSL band is clamped to. */
export const HSL_SHIFT_BOUNDS = bounds(HSL_SHIFT_MIN, HSL_SHIFT_MAX)

export const LOOK_INTENSITY_MIN = 0
export const LOOK_INTENSITY_MAX = 1
export const LOOK_INTENSITY_BOUNDS = bounds(
  LOOK_INTENSITY_MIN,
  LOOK_INTENSITY_MAX,
)

function clampLookIntensity(value: number): number {
  return Math.min(LOOK_INTENSITY_MAX, Math.max(LOOK_INTENSITY_MIN, value))
}

function isLookIntensity(value: number): boolean {
  return (
    Number.isFinite(value) &&
    value >= LOOK_INTENSITY_MIN &&
    value <= LOOK_INTENSITY_MAX
  )
}

/**
 * Clamp a look strength into 0..1, keeping it continuous. A strength that is
 * not a finite number becomes the caller's `defaultIntensity`, which must
 * itself lie in 0..1.
 */
export function normalizeLookIntensity(
  value: unknown,
  defaultIntensity: number,
): number {
  if (!isLookIntensity(defaultIntensity)) {
    throw new RangeError(
      `defaultIntensity must be a number in [${LOOK_INTENSITY_MIN}, ${LOOK_INTENSITY_MAX}], got ${defaultIntensity}`,
    )
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return defaultIntensity
  }
  return clampLookIntensity(value)
}

function includes<T extends string>(
  list: readonly T[],
  value: unknown,
): value is T {
  return (list as readonly unknown[]).includes(value)
}

/**
 * Validate a look selection field by field: an unknown style kind becomes
 * `'none'`, an unknown preset becomes `null`, and the strength goes through
 * `normalizeLookIntensity`.
 */
export function normalizeLookSelection(
  input: LookSelectionInput | null | undefined,
  entry: LookIntensityEntry,
): LookSelection {
  const intensity = normalizeLookIntensity(
    input?.intensity,
    entry.defaultIntensity,
  )
  const styleKind = input?.styleKind
  const builtinPreset = input?.builtinPreset
  return {
    styleKind: includes(LOOK_STYLE_KINDS, styleKind) ? styleKind : 'none',
    builtinPreset: includes(BUILTIN_STYLE_PRESETS, builtinPreset)
      ? builtinPreset
      : null,
    intensity,
  }
}

/**
 * Normalize user color through the tone, color balance, saturation and HSL
 * normalizers: non-finite fields become neutral, fields are clamped to their
 * bounds, and missing HSL bands or axes are neutral.
 */
export function normalizeUserColorIntent(
  input?: UserColorIntentInput | null,
): UserColorIntent {
  const tone = normalizeToneParams(input)
  const balance = normalizeColorBalanceParams(input)
  const saturation = normalizeSaturationParams(input)
  return {
    userExposureEv: tone.userExposureEv,
    userContrast: tone.userContrast,
    userHighlights: tone.userHighlights,
    userShadows: tone.userShadows,
    userWhites: tone.userWhites,
    userBlacks: tone.userBlacks,
    userTemperature: balance.userTemperature,
    userTint: balance.userTint,
    userSaturation: saturation.userSaturation,
    userVibrance: saturation.userVibrance,
    selectiveColor: normalizeSelectiveColorParams(input),
  }
}

/** Normalize a full intent; `entry` supplies the default look strength. */
export function normalizeColorGraphIntent(
  input: ColorGraphIntentInput | null | undefined,
  entry: LookIntensityEntry,
): ColorGraphIntent {
  return {
    ...normalizeLookSelection(input, entry),
    ...normalizeUserColorIntent(input),
  }
}

/** Neutral user color; deeply frozen. */
export const NEUTRAL_USER_COLOR_INTENT: UserColorIntent = Object.freeze({
  ...normalizeUserColorIntent(),
  selectiveColor: NEUTRAL_SELECTIVE_COLOR,
})

/**
 * Copy the user color out of a larger record without changing a value.
 * Missing HSL becomes the shared neutral record.
 */
export function pickUserColorIntent(
  source: UserColorIntentSource,
): UserColorIntent {
  return {
    userExposureEv: source.userExposureEv,
    userContrast: source.userContrast,
    userHighlights: source.userHighlights,
    userShadows: source.userShadows,
    userWhites: source.userWhites,
    userBlacks: source.userBlacks,
    userTemperature: source.userTemperature,
    userTint: source.userTint,
    userSaturation: source.userSaturation,
    userVibrance: source.userVibrance,
    selectiveColor: source.selectiveColor ?? NEUTRAL_SELECTIVE_COLOR,
  }
}

/** Copy the look selection out of a larger record without changing a value. */
export function pickLookSelection(source: LookSelection): LookSelection {
  return {
    styleKind: source.styleKind,
    builtinPreset: source.builtinPreset,
    intensity: source.intensity,
  }
}

/** Copy the full intent out of a larger record, such as legacy params. */
export function pickColorGraphIntent(
  source: ColorGraphIntentSource,
): ColorGraphIntent {
  return { ...pickLookSelection(source), ...pickUserColorIntent(source) }
}

/** User fields as the color graph reads them, in a fixed order. */
function userColorIdentity(source: UserColorIntentSource): unknown[] {
  const normalized = normalizeUserColorIntent(source)
  return [
    ...USER_COLOR_SCALAR_KEYS.map((key) => normalized[key]),
    HSL_BAND_IDS.map((id) =>
      HSL_SHIFT_AXES.map((axis) => normalized.selectiveColor[id][axis]),
    ),
  ]
}

/** JSON has no non-finite numbers; spell them out so they stay distinct. */
function encodeNumber(value: number): number | string {
  return Number.isFinite(value) ? value : String(value)
}

/**
 * Identity of the user color. Fields are read the way the color graph reads
 * them, so key order, missing or neutral HSL, and values outside the bounds
 * that clamp to the same value share one signature.
 */
export function userColorIntentSignature(
  source: UserColorIntentSource,
): string {
  return JSON.stringify(userColorIdentity(source))
}

/**
 * Identity of the full intent: the look selection as given, its strength
 * included and never filled in or snapped, plus the user color as the color
 * graph reads it. Anything else on the source (view state, RAW render
 * exposure, LUT data, geometry) is ignored.
 */
export function colorGraphIntentSignature(
  source: ColorGraphIntentSource,
): string {
  return JSON.stringify([
    source.styleKind,
    source.builtinPreset,
    encodeNumber(source.intensity),
    ...userColorIdentity(source),
  ])
}

export function userColorIntentEquals(
  left: UserColorIntentSource,
  right: UserColorIntentSource,
): boolean {
  return userColorIntentSignature(left) === userColorIntentSignature(right)
}

export function colorGraphIntentEquals(
  left: ColorGraphIntentSource,
  right: ColorGraphIntentSource,
): boolean {
  return colorGraphIntentSignature(left) === colorGraphIntentSignature(right)
}
