import { describe, expect, expectTypeOf, it } from 'vitest'

import { normalizeColorBalanceParams } from './color-balance'
import type { ExportColorGraphInput } from './color-graph'
import { resolveExportColorGraph } from './color-graph'
import type { LUTColorProfile } from './registry'
import { getLUTColorProfile } from './registry'
import { normalizeSaturationParams } from './saturation'
import type {
  HSLBandId,
  HSLBandShift,
  HSLShiftAxis,
  SelectiveColorBandsInput,
} from './selective-color'
import {
  HSL_BAND_IDS,
  HSL_SHIFT_AXES,
  HSL_SHIFT_MAX,
  HSL_SHIFT_MIN,
  isHSLBandNeutral,
  isSelectiveColorNeutral,
  NEUTRAL_HSL_BAND,
  NEUTRAL_SELECTIVE_COLOR,
  normalizeSelectiveColorParams,
} from './selective-color'
import { normalizeToneParams } from './tone'
import type { LUTData, ProcessingParams } from './types'
import type {
  ColorGraphIntent,
  ColorGraphIntentInput,
  ColorGraphIntentSource,
  LookSelection,
  UserColorIntent,
  UserColorIntentInput,
} from './user-color-intent'
import {
  BUILTIN_STYLE_PRESETS,
  COLOR_GRAPH_INTENT_KEYS,
  colorGraphIntentEquals,
  colorGraphIntentSignature,
  HSL_SHIFT_BOUNDS,
  LOOK_INTENSITY_BOUNDS,
  LOOK_INTENSITY_MAX,
  LOOK_INTENSITY_MIN,
  LOOK_SELECTION_KEYS,
  LOOK_STYLE_KINDS,
  NEUTRAL_USER_COLOR_INTENT,
  normalizeColorGraphIntent,
  normalizeLookIntensity,
  normalizeLookSelection,
  normalizeUserColorIntent,
  pickColorGraphIntent,
  pickLookSelection,
  pickUserColorIntent,
  USER_COLOR_FIELD_BOUNDS,
  USER_COLOR_INTENT_KEYS,
  USER_COLOR_SCALAR_KEYS,
  userColorIntentEquals,
  userColorIntentSignature,
} from './user-color-intent'

// The app starts a fresh look at 0.7; the CLI renders at 1 unless told
// otherwise. The package owns neither default, so each entry passes its own.
const APP_ENTRY = { defaultIntensity: 0.7 } as const
const CLI_ENTRY = { defaultIntensity: 1 } as const

/** A legacy params record: view fields present, `selectiveColor` absent. */
const LEGACY_PARAMS: ProcessingParams = {
  intensity: 0.37,
  viewMode: 'compare',
  compareSplit: 0.25,
  styleKind: 'custom',
  builtinPreset: null,
  userExposureEv: 0.5,
  userContrast: 12,
  userHighlights: -20,
  userShadows: 30,
  userWhites: 4,
  userBlacks: -6,
  userTemperature: 18,
  userTint: -7,
  userSaturation: 9,
  userVibrance: 15,
}

function bands(
  overrides: Partial<Record<HSLBandId, HSLBandShift>> = {},
): Record<HSLBandId, HSLBandShift> {
  return Object.fromEntries(
    HSL_BAND_IDS.map((id) => [
      id,
      overrides[id] ?? { hue: 0, saturation: 0, lightness: 0 },
    ]),
  ) as Record<HSLBandId, HSLBandShift>
}

/** Input the types would reject, as persisted or hand-written data can be. */
function loose<T>(value: unknown): T {
  return value as T
}

function shift(axis: HSLShiftAxis, value: number): Partial<HSLBandShift> {
  return { [axis]: value }
}

function displayLookLut(): LUTData {
  const profile = getLUTColorProfile('rec709-gamma24') as LUTColorProfile
  return {
    size: 2,
    data: new Float32Array(24),
    domainMin: [0, 0, 0],
    domainMax: [1, 1, 1],
    inputProfile: 'display-srgb',
    profileResolution: { kind: 'confirmed', confidence: 'user', profile },
  }
}

describe('normalizers the color intent reuses', () => {
  it('map non-finite user fields to neutral and clamp to the editing range', () => {
    expect(
      normalizeToneParams({
        userExposureEv: Number.NaN,
        userContrast: 250,
        userHighlights: Number.NEGATIVE_INFINITY,
        userShadows: -101,
        userWhites: 100,
        userBlacks: 12.5,
      }),
    ).toEqual({
      userExposureEv: 0,
      userContrast: 100,
      userHighlights: 0,
      userShadows: -100,
      userWhites: 100,
      userBlacks: 12.5,
    })
    expect(
      normalizeColorBalanceParams({
        userTemperature: Number.POSITIVE_INFINITY,
        userTint: -140,
      }),
    ).toEqual({ userTemperature: 0, userTint: -100 })
    expect(
      normalizeSaturationParams({
        userSaturation: Number.NaN,
        userVibrance: 300,
      }),
    ).toEqual({ userSaturation: 0, userVibrance: 100 })
  })

  it('fill partial HSL with neutral bands and axes, clamp, and drop unknown bands', () => {
    const normalized = normalizeSelectiveColorParams({
      selectiveColor: loose<SelectiveColorBandsInput>({
        red: { hue: 140 },
        blue: { saturation: Number.NaN, lightness: -0.5 },
        cyan: { hue: 10 },
      }),
    })

    expect(normalized).toEqual(
      bands({
        red: { hue: 100, saturation: 0, lightness: 0 },
        blue: { hue: 0, saturation: 0, lightness: -0.5 },
      }),
    )
    expect(normalized).not.toHaveProperty('cyan')
    expect(normalizeSelectiveColorParams(undefined)).toEqual(bands())
    expect(normalizeSelectiveColorParams({ selectiveColor: null })).toEqual(
      bands(),
    )
    expect(
      normalizeSelectiveColorParams(loose({ selectiveColor: 'red' })),
    ).toEqual(bands())
  })
})

describe('field sets', () => {
  it('lists every field once, in a fixed order', () => {
    expect(USER_COLOR_SCALAR_KEYS).toEqual([
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
    ])
    expect(USER_COLOR_INTENT_KEYS).toEqual([
      ...USER_COLOR_SCALAR_KEYS,
      'selectiveColor',
    ])
    expect(LOOK_SELECTION_KEYS).toEqual([
      'styleKind',
      'builtinPreset',
      'intensity',
    ])
    expect(COLOR_GRAPH_INTENT_KEYS).toEqual([
      ...LOOK_SELECTION_KEYS,
      ...USER_COLOR_INTENT_KEYS,
    ])
    expect(new Set(COLOR_GRAPH_INTENT_KEYS).size).toBe(
      COLOR_GRAPH_INTENT_KEYS.length,
    )
    expect(LOOK_STYLE_KINDS).toEqual(['none', 'builtin', 'custom'])
    expect(BUILTIN_STYLE_PRESETS).toEqual([
      'neutral',
      'warm',
      'cool',
      'film-soft',
      'film-contrast',
      'cinematic',
      'fade',
      'mono',
    ])
    for (const list of [
      USER_COLOR_SCALAR_KEYS,
      USER_COLOR_INTENT_KEYS,
      LOOK_SELECTION_KEYS,
      COLOR_GRAPH_INTENT_KEYS,
      LOOK_STYLE_KINDS,
      BUILTIN_STYLE_PRESETS,
    ]) {
      expect(Object.isFrozen(list)).toBe(true)
    }
  })

  it('covers every legacy params field except the view', () => {
    const everyLegacyField = {
      ...LEGACY_PARAMS,
      selectiveColor: bands(),
    } satisfies Required<ProcessingParams>
    const legacyColorFields = Object.keys(everyLegacyField).filter(
      (key) => key !== 'viewMode' && key !== 'compareSplit',
    )

    expect([...COLOR_GRAPH_INTENT_KEYS].sort()).toEqual(
      legacyColorFields.sort(),
    )
    expectTypeOf<keyof ColorGraphIntent>().toEqualTypeOf<
      Exclude<keyof ProcessingParams, 'viewMode' | 'compareSplit'>
    >()
    expectTypeOf<keyof LookSelection>().toEqualTypeOf<
      (typeof LOOK_SELECTION_KEYS)[number]
    >()
    expectTypeOf<keyof UserColorIntent>().toEqualTypeOf<
      (typeof USER_COLOR_INTENT_KEYS)[number]
    >()
  })

  it('leaves view state, RAW render exposure, LUT data and geometry out', () => {
    for (const key of [
      'viewMode',
      'compareSplit',
      'rawRenderExposure',
      'lut',
      'geometry',
    ]) {
      expect(COLOR_GRAPH_INTENT_KEYS).not.toContain(key)
    }
    expectTypeOf<ColorGraphIntent>().not.toHaveProperty('viewMode')
    expectTypeOf<ColorGraphIntent>().not.toHaveProperty('compareSplit')
    expectTypeOf<ColorGraphIntent>().not.toHaveProperty('rawRenderExposure')
    expectTypeOf<ColorGraphIntent>().not.toHaveProperty('lut')
  })
})

describe('hsl bands, axes and neutral', () => {
  it('names the bands around the hue wheel and the three shift axes', () => {
    expect(HSL_BAND_IDS).toEqual([
      'red',
      'orange',
      'yellow',
      'green',
      'aqua',
      'blue',
      'purple',
      'magenta',
    ])
    expect(HSL_SHIFT_AXES).toEqual(['hue', 'saturation', 'lightness'])
    expect(Object.isFrozen(HSL_BAND_IDS)).toBe(true)
    expect(Object.isFrozen(HSL_SHIFT_AXES)).toBe(true)
    expect(Object.keys(normalizeSelectiveColorParams(undefined))).toEqual([
      ...HSL_BAND_IDS,
    ])
    expect(Object.keys(NEUTRAL_HSL_BAND)).toEqual([...HSL_SHIFT_AXES])
    expectTypeOf<(typeof HSL_BAND_IDS)[number]>().toEqualTypeOf<HSLBandId>()
    expectTypeOf<
      (typeof HSL_SHIFT_AXES)[number]
    >().toEqualTypeOf<HSLShiftAxis>()
  })

  it('freezes the neutral HSL and user intent all the way down', () => {
    expect(NEUTRAL_SELECTIVE_COLOR).toEqual(bands())
    expect(normalizeSelectiveColorParams(undefined)).toEqual(
      NEUTRAL_SELECTIVE_COLOR,
    )
    expect(Object.isFrozen(NEUTRAL_SELECTIVE_COLOR)).toBe(true)
    for (const id of HSL_BAND_IDS) {
      expect(Object.isFrozen(NEUTRAL_SELECTIVE_COLOR[id])).toBe(true)
    }
    expect(Object.isFrozen(NEUTRAL_HSL_BAND)).toBe(true)
    expect(() => {
      ;(NEUTRAL_SELECTIVE_COLOR.red as { hue: number }).hue = 5
    }).toThrow(TypeError)
    expect(NEUTRAL_SELECTIVE_COLOR.red.hue).toBe(0)

    expect(NEUTRAL_USER_COLOR_INTENT).toEqual(normalizeUserColorIntent())
    expect(Object.isFrozen(NEUTRAL_USER_COLOR_INTENT)).toBe(true)
    expect(NEUTRAL_USER_COLOR_INTENT.selectiveColor).toBe(
      NEUTRAL_SELECTIVE_COLOR,
    )
    expect(() => {
      ;(NEUTRAL_USER_COLOR_INTENT as { userContrast: number }).userContrast = 5
    }).toThrow(TypeError)
  })

  it('treats missing, partial, non-finite and explicit all-zero HSL as neutral', () => {
    expect(isSelectiveColorNeutral(undefined)).toBe(true)
    expect(isSelectiveColorNeutral(null)).toBe(true)
    expect(isSelectiveColorNeutral({})).toBe(true)
    expect(isSelectiveColorNeutral({ red: { hue: 0 } })).toBe(true)
    expect(isSelectiveColorNeutral({ blue: { saturation: Number.NaN } })).toBe(
      true,
    )
    expect(isSelectiveColorNeutral({ green: { lightness: -0 } })).toBe(true)
    expect(isSelectiveColorNeutral(bands())).toBe(true)
    expect(isSelectiveColorNeutral({ magenta: { lightness: 0.5 } })).toBe(false)
    expect(
      isSelectiveColorNeutral(
        bands({ aqua: { hue: -3, saturation: 0, lightness: 0 } }),
      ),
    ).toBe(false)
    expect(isHSLBandNeutral(NEUTRAL_HSL_BAND)).toBe(true)
    expect(isHSLBandNeutral({ hue: 0, saturation: 1, lightness: 0 })).toBe(
      false,
    )
  })
})

describe('bounds', () => {
  it('states the range each existing normalizer clamps to', () => {
    expect(USER_COLOR_FIELD_BOUNDS.userExposureEv).toEqual({ min: -5, max: 5 })
    for (const key of USER_COLOR_SCALAR_KEYS) {
      if (key !== 'userExposureEv') {
        expect(USER_COLOR_FIELD_BOUNDS[key]).toEqual({ min: -100, max: 100 })
      }
      const { min, max } = USER_COLOR_FIELD_BOUNDS[key]
      const at = (value: number) =>
        normalizeUserColorIntent(
          Object.fromEntries([[key, value]]) as UserColorIntentInput,
        )[key]
      expect(at(max + 1000)).toBe(max)
      expect(at(min - 1000)).toBe(min)
      expect(at(Number.NaN)).toBe(0)
      expect(at(Number.POSITIVE_INFINITY)).toBe(0)
    }
    expect(Object.keys(USER_COLOR_FIELD_BOUNDS)).toEqual([
      ...USER_COLOR_SCALAR_KEYS,
    ])
    expect(Object.isFrozen(USER_COLOR_FIELD_BOUNDS)).toBe(true)
    expect(Object.isFrozen(USER_COLOR_FIELD_BOUNDS.userTint)).toBe(true)

    expect(HSL_SHIFT_BOUNDS).toEqual({ min: HSL_SHIFT_MIN, max: HSL_SHIFT_MAX })
    expect(HSL_SHIFT_BOUNDS).toEqual({ min: -100, max: 100 })
    for (const axis of HSL_SHIFT_AXES) {
      const clamped = normalizeSelectiveColorParams({
        selectiveColor: { red: shift(axis, 1000), blue: shift(axis, -1000) },
      })
      expect(clamped.red[axis]).toBe(HSL_SHIFT_MAX)
      expect(clamped.blue[axis]).toBe(HSL_SHIFT_MIN)
    }

    expect(LOOK_INTENSITY_BOUNDS).toEqual({ min: 0, max: 1 })
    expect(LOOK_INTENSITY_BOUNDS).toEqual({
      min: LOOK_INTENSITY_MIN,
      max: LOOK_INTENSITY_MAX,
    })
  })
})

describe('normalize', () => {
  const messy = {
    userExposureEv: 9,
    userContrast: Number.NaN,
    userHighlights: -300,
    userShadows: 12.5,
    userWhites: Number.POSITIVE_INFINITY,
    userBlacks: -100,
    userTemperature: 150,
    userTint: Number.NaN,
    userSaturation: -101,
    userVibrance: 33,
    selectiveColor: { red: { hue: 140 }, magenta: { lightness: -40 } },
  }

  it('builds user color from the existing tone, balance, saturation and HSL normalizers', () => {
    const normalized = normalizeUserColorIntent(messy)

    expect(normalized).toEqual({
      ...normalizeToneParams(messy),
      ...normalizeColorBalanceParams(messy),
      ...normalizeSaturationParams(messy),
      selectiveColor: normalizeSelectiveColorParams(messy),
    })
    expect(normalized).toEqual({
      userExposureEv: 5,
      userContrast: 0,
      userHighlights: -100,
      userShadows: 12.5,
      userWhites: 0,
      userBlacks: -100,
      userTemperature: 100,
      userTint: 0,
      userSaturation: -100,
      userVibrance: 33,
      selectiveColor: bands({
        red: { hue: 100, saturation: 0, lightness: 0 },
        magenta: { hue: 0, saturation: 0, lightness: -40 },
      }),
    })
    expect(Object.keys(normalized)).toEqual([...USER_COLOR_INTENT_KEYS])
  })

  it('drops every field outside the intent', () => {
    const noisy = {
      ...LEGACY_PARAMS,
      selectiveColor: bands({ red: { hue: 10, saturation: 0, lightness: 0 } }),
      rawRenderExposure: { ev: 1, multiplier: 2, source: 'user' },
      lut: displayLookLut(),
      geometry: { rotateDeg: 3 },
      extra: 'kept nowhere',
    }

    const graphIntent = normalizeColorGraphIntent(noisy, APP_ENTRY)
    expect(Object.keys(graphIntent)).toEqual([...COLOR_GRAPH_INTENT_KEYS])
    expect(Object.keys(normalizeUserColorIntent(noisy))).toEqual([
      ...USER_COLOR_INTENT_KEYS,
    ])
    expect(Object.keys(normalizeLookSelection(noisy, APP_ENTRY))).toEqual([
      ...LOOK_SELECTION_KEYS,
    ])
    expect(Object.keys(pickColorGraphIntent(noisy))).toEqual([
      ...COLOR_GRAPH_INTENT_KEYS,
    ])
    expect(graphIntent).not.toHaveProperty('viewMode')
    expect(graphIntent).not.toHaveProperty('extra')
  })

  it('is idempotent', () => {
    const inputs: (ColorGraphIntentInput | undefined)[] = [
      undefined,
      {},
      messy,
      LEGACY_PARAMS,
      { ...LEGACY_PARAMS, intensity: Number.NaN },
      { ...LEGACY_PARAMS, intensity: 1.6, userContrast: -900 },
      { styleKind: 'builtin', builtinPreset: 'mono', intensity: 0.37 },
      loose<ColorGraphIntentInput>({ styleKind: 'sepia', builtinPreset: 'x' }),
    ]
    for (const input of inputs) {
      for (const entry of [APP_ENTRY, CLI_ENTRY]) {
        const once = normalizeColorGraphIntent(input, entry)
        const twice = normalizeColorGraphIntent(once, entry)
        expect(twice).toEqual(once)
        expect(colorGraphIntentSignature(twice)).toBe(
          colorGraphIntentSignature(once),
        )
      }
      const user = normalizeUserColorIntent(input)
      expect(normalizeUserColorIntent(user)).toEqual(user)
    }
  })

  it.each([
    [0, 0],
    [0.37, 0.37],
    [0.4, 0.4],
    [0.55, 0.55],
    [0.7, 0.7],
    [1, 1],
    [-0.25, 0],
    [1.4, 1],
  ])(
    'keeps a strength of %s continuous, never snapped to a detent',
    (value, expected) => {
      expect(normalizeLookIntensity(value, APP_ENTRY.defaultIntensity)).toBe(
        expected,
      )
      expect(normalizeLookIntensity(value, CLI_ENTRY.defaultIntensity)).toBe(
        expected,
      )
      expect(
        normalizeLookSelection(
          { styleKind: 'custom', intensity: value },
          APP_ENTRY,
        ).intensity,
      ).toBe(expected)
    },
  )

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    undefined,
    '0.5',
  ])('replaces a strength of %s with the entry default', (value) => {
    expect(normalizeLookIntensity(value, APP_ENTRY.defaultIntensity)).toBe(0.7)
    expect(normalizeLookIntensity(value, CLI_ENTRY.defaultIntensity)).toBe(1)
  })

  it('leaves the default strength to each entry point', () => {
    const lookWithoutStrength = {
      styleKind: 'custom',
      builtinPreset: null,
    } as const
    const app = normalizeColorGraphIntent(lookWithoutStrength, APP_ENTRY)
    const cli = normalizeColorGraphIntent(lookWithoutStrength, CLI_ENTRY)

    expect(app.intensity).toBe(0.7)
    expect(cli.intensity).toBe(1)
    expect(colorGraphIntentEquals(app, cli)).toBe(false)
    for (const intensity of [0, 0.37, 1]) {
      expect(
        normalizeLookSelection({ ...lookWithoutStrength, intensity }, APP_ENTRY)
          .intensity,
      ).toBe(intensity)
      expect(
        normalizeLookSelection({ ...lookWithoutStrength, intensity }, CLI_ENTRY)
          .intensity,
      ).toBe(intensity)
    }
    for (const invalid of [Number.NaN, -0.1, 1.5]) {
      expect(() => normalizeLookIntensity(0.5, invalid)).toThrow(RangeError)
      expect(() =>
        normalizeLookSelection(lookWithoutStrength, {
          defaultIntensity: invalid,
        }),
      ).toThrow(RangeError)
    }
  })

  it('ships no shared default strength', async () => {
    const runtime = await import('./index')
    const defaults = Object.keys(runtime).filter(
      (name) => /default/i.test(name) && /intensity|strength/i.test(name),
    )

    expect(defaults).toEqual([])
  })

  it('validates the look selection without rewriting valid values', () => {
    expect(
      normalizeLookSelection(
        { styleKind: 'builtin', builtinPreset: 'film-soft', intensity: 0.37 },
        CLI_ENTRY,
      ),
    ).toEqual({
      styleKind: 'builtin',
      builtinPreset: 'film-soft',
      intensity: 0.37,
    })
    for (const preset of BUILTIN_STYLE_PRESETS) {
      expect(
        normalizeLookSelection(
          { styleKind: 'builtin', builtinPreset: preset },
          APP_ENTRY,
        ).builtinPreset,
      ).toBe(preset)
    }
    expect(normalizeLookSelection(undefined, APP_ENTRY)).toEqual({
      styleKind: 'none',
      builtinPreset: null,
      intensity: 0.7,
    })
    expect(
      normalizeLookSelection(
        loose({ styleKind: 'sepia', builtinPreset: 'vivid', intensity: 0.2 }),
        APP_ENTRY,
      ),
    ).toEqual({ styleKind: 'none', builtinPreset: null, intensity: 0.2 })
    // A preset recorded next to another style kind is kept as given; the
    // selection is validated field by field, not rewritten.
    expect(
      normalizeLookSelection(
        { styleKind: 'custom', builtinPreset: 'warm', intensity: 1 },
        APP_ENTRY,
      ),
    ).toEqual({ styleKind: 'custom', builtinPreset: 'warm', intensity: 1 })
  })
})

describe('pick', () => {
  it('copies the intent out of legacy params without changing a value', () => {
    const picked = pickColorGraphIntent(LEGACY_PARAMS)

    expect(picked).toEqual({
      styleKind: 'custom',
      builtinPreset: null,
      intensity: 0.37,
      userExposureEv: 0.5,
      userContrast: 12,
      userHighlights: -20,
      userShadows: 30,
      userWhites: 4,
      userBlacks: -6,
      userTemperature: 18,
      userTint: -7,
      userSaturation: 9,
      userVibrance: 15,
      selectiveColor: NEUTRAL_SELECTIVE_COLOR,
    })
    expect(picked.selectiveColor).toBe(NEUTRAL_SELECTIVE_COLOR)
    expect(picked).not.toHaveProperty('viewMode')
    expect(picked).not.toHaveProperty('compareSplit')

    const hsl = bands({ red: { hue: 20, saturation: -5, lightness: 3 } })
    expect(
      pickColorGraphIntent({ ...LEGACY_PARAMS, selectiveColor: hsl })
        .selectiveColor,
    ).toBe(hsl)
    // Picking copies; clamping is normalization's job.
    expect(
      pickUserColorIntent({ ...LEGACY_PARAMS, userContrast: 400 }).userContrast,
    ).toBe(400)
    expect(Object.keys(pickUserColorIntent(LEGACY_PARAMS))).toEqual([
      ...USER_COLOR_INTENT_KEYS,
    ])
    expect(pickLookSelection(LEGACY_PARAMS)).toEqual({
      styleKind: 'custom',
      builtinPreset: null,
      intensity: 0.37,
    })
  })
})

describe('identity', () => {
  const base = pickColorGraphIntent({
    ...LEGACY_PARAMS,
    selectiveColor: bands({
      green: { hue: -25, saturation: 10, lightness: 5 },
    }),
  })

  it('ignores field order', () => {
    const reversed = Object.fromEntries(
      Object.entries(base).reverse(),
    ) as unknown as ColorGraphIntent
    const reorderedBands = Object.fromEntries(
      Object.entries(base.selectiveColor)
        .reverse()
        .map(([id, band]) => [
          id,
          {
            lightness: band.lightness,
            saturation: band.saturation,
            hue: band.hue,
          },
        ]),
    ) as Record<HSLBandId, HSLBandShift>
    const reordered = { ...reversed, selectiveColor: reorderedBands }

    expect(colorGraphIntentSignature(reordered)).toBe(
      colorGraphIntentSignature(base),
    )
    expect(colorGraphIntentEquals(reordered, base)).toBe(true)
    expect(userColorIntentSignature(reordered)).toBe(
      userColorIntentSignature(base),
    )
  })

  it('ignores view state, RAW render exposure, LUT data and geometry', () => {
    const decorated = {
      ...base,
      viewMode: 'original' as const,
      compareSplit: 0.9,
      rawRenderExposure: { ev: 1.5, multiplier: 2.83, source: 'user' },
      lut: displayLookLut(),
      geometry: { rotateDeg: 12 },
    }

    expect(colorGraphIntentSignature(decorated)).toBe(
      colorGraphIntentSignature(base),
    )
    expect(colorGraphIntentEquals(decorated, base)).toBe(true)
    const processedView: ProcessingParams = {
      ...LEGACY_PARAMS,
      viewMode: 'processed',
      compareSplit: 0,
    }
    const originalView: ProcessingParams = {
      ...LEGACY_PARAMS,
      viewMode: 'original',
      compareSplit: 1,
    }
    expect(colorGraphIntentSignature(processedView)).toBe(
      colorGraphIntentSignature(originalView),
    )
  })

  it('treats missing, partial-neutral and explicit-neutral HSL alike', () => {
    const variants: ColorGraphIntentSource[] = [
      LEGACY_PARAMS,
      { ...LEGACY_PARAMS, selectiveColor: undefined },
      {
        ...LEGACY_PARAMS,
        selectiveColor: loose<Record<HSLBandId, HSLBandShift>>({
          red: { hue: 0 },
        }),
      },
      {
        ...LEGACY_PARAMS,
        selectiveColor: loose<Record<HSLBandId, HSLBandShift>>({
          blue: { saturation: Number.NaN },
        }),
      },
      { ...LEGACY_PARAMS, selectiveColor: bands() },
      { ...LEGACY_PARAMS, selectiveColor: NEUTRAL_SELECTIVE_COLOR },
    ]
    const expected = colorGraphIntentSignature(variants[0])

    for (const variant of variants) {
      expect(colorGraphIntentSignature(variant)).toBe(expected)
      expect(colorGraphIntentEquals(variant, LEGACY_PARAMS)).toBe(true)
      expect(userColorIntentEquals(variant, LEGACY_PARAMS)).toBe(true)
    }
  })

  it('changes with any continuous look strength', () => {
    const strengths = [0, 0.37, 0.3700001, 0.4, 0.7, 1]
    const signatures = strengths.map((intensity) =>
      colorGraphIntentSignature({ ...base, intensity }),
    )

    expect(new Set(signatures).size).toBe(strengths.length)
    expect(
      colorGraphIntentEquals(
        { ...base, intensity: 0.37 },
        { ...base, intensity: 0.4 },
      ),
    ).toBe(false)
  })

  it('changes with the look selection and with every user field', () => {
    const looks: LookSelection[] = [
      { styleKind: 'none', builtinPreset: null, intensity: 0.37 },
      { styleKind: 'custom', builtinPreset: null, intensity: 0.37 },
      { styleKind: 'builtin', builtinPreset: 'warm', intensity: 0.37 },
      { styleKind: 'builtin', builtinPreset: 'cool', intensity: 0.37 },
      { styleKind: 'builtin', builtinPreset: null, intensity: 0.37 },
    ]
    const lookSignatures = looks.map((look) =>
      colorGraphIntentSignature({ ...base, ...look }),
    )
    expect(new Set(lookSignatures).size).toBe(looks.length)

    for (const key of USER_COLOR_SCALAR_KEYS) {
      const changed = { ...base, [key]: base[key] + 1 }
      expect(colorGraphIntentEquals(changed, base)).toBe(false)
      expect(userColorIntentEquals(changed, base)).toBe(false)
    }
    for (const id of HSL_BAND_IDS) {
      for (const axis of HSL_SHIFT_AXES) {
        const shifted = {
          ...base,
          selectiveColor: {
            ...base.selectiveColor,
            [id]: { ...base.selectiveColor[id], [axis]: 1 },
          },
        }
        expect(colorGraphIntentEquals(shifted, base)).toBe(false)
      }
    }
  })

  it('keeps user color identity apart from the look', () => {
    const otherLook = {
      ...base,
      styleKind: 'builtin' as const,
      builtinPreset: 'fade' as const,
      intensity: 1,
    }

    expect(userColorIntentSignature(otherLook)).toBe(
      userColorIntentSignature(base),
    )
    expect(userColorIntentEquals(otherLook, base)).toBe(true)
    expect(colorGraphIntentEquals(otherLook, base)).toBe(false)
  })

  it('follows what the export graph reads', () => {
    // User fields reach the graph through its own normalizers, so a value
    // outside the editing range shares its clamped value's identity.
    expect(colorGraphIntentSignature({ ...base, userContrast: 400 })).toBe(
      colorGraphIntentSignature({ ...base, userContrast: 100 }),
    )
    expect(colorGraphIntentSignature({ ...base, userTint: Number.NaN })).toBe(
      colorGraphIntentSignature({ ...base, userTint: 0 }),
    )
    expect(colorGraphIntentSignature({ ...base, userExposureEv: -0 })).toBe(
      colorGraphIntentSignature({ ...base, userExposureEv: 0 }),
    )

    // The look strength reaches the graph as given: identity keeps it, and
    // never fills in an entry default for a strength that is not finite.
    const notFinite = colorGraphIntentSignature({
      ...base,
      intensity: Number.NaN,
    })
    expect(notFinite).toBe(
      colorGraphIntentSignature({ ...base, intensity: Number.NaN }),
    )
    expect(notFinite).not.toBe(
      colorGraphIntentSignature({ ...base, intensity: 0.7 }),
    )
    expect(notFinite).not.toBe(
      colorGraphIntentSignature({ ...base, intensity: 1 }),
    )
    expect(notFinite).not.toBe(
      colorGraphIntentSignature({
        ...base,
        intensity: Number.POSITIVE_INFINITY,
      }),
    )
    expect(colorGraphIntentSignature({ ...base, intensity: 1.5 })).not.toBe(
      colorGraphIntentSignature({ ...base, intensity: 1 }),
    )
  })

  it('agrees with normalization for any intent inside the bounds', () => {
    const inputs: ColorGraphIntentSource[] = [
      LEGACY_PARAMS,
      base,
      { ...base, intensity: 0 },
      { ...base, styleKind: 'builtin', builtinPreset: 'cinematic' },
      { ...LEGACY_PARAMS, userSaturation: 250, userWhites: Number.NaN },
    ]
    for (const input of inputs) {
      expect(
        colorGraphIntentSignature(normalizeColorGraphIntent(input, APP_ENTRY)),
      ).toBe(colorGraphIntentSignature(input))
      expect(userColorIntentSignature(normalizeUserColorIntent(input))).toBe(
        userColorIntentSignature(input),
      )
    }
  })
})

describe('compatibility', () => {
  it('requires every field on the strict intents', () => {
    const { selectiveColor: _omitted, ...withoutHsl } =
      NEUTRAL_USER_COLOR_INTENT
    // @ts-expect-error the strict intent requires selectiveColor
    const strict: UserColorIntent = withoutHsl

    expect(strict).not.toHaveProperty('selectiveColor')
    expectTypeOf<UserColorIntent['selectiveColor']>().toEqualTypeOf<
      NonNullable<ProcessingParams['selectiveColor']>
    >()
    expectTypeOf<LookSelection['styleKind']>().toEqualTypeOf<
      ProcessingParams['styleKind']
    >()
    expectTypeOf<LookSelection['builtinPreset']>().toEqualTypeOf<
      ProcessingParams['builtinPreset']
    >()
  })

  it('keeps legacy params without selectiveColor valid graph input', () => {
    const lut = displayLookLut()
    const fromLegacy = resolveExportColorGraph({ ...LEGACY_PARAMS, lut })
    const fromIntent = resolveExportColorGraph({
      ...pickColorGraphIntent(LEGACY_PARAMS),
      lut,
    })

    expect(fromLegacy.supported).toBe(true)
    expect(fromIntent).toEqual(fromLegacy)
    expect(fromIntent).toMatchObject({
      steps: expect.arrayContaining([
        expect.objectContaining({
          kind: 'lut-output-to-srgb',
          intensity: 0.37,
        }),
      ]),
    })
    expectTypeOf<ProcessingParams>().toExtend<ColorGraphIntentSource>()
    expectTypeOf<ProcessingParams>().toExtend<UserColorIntentInput>()
    expectTypeOf<
      ProcessingParams & { lut: LUTData | null }
    >().toExtend<ExportColorGraphInput>()
    expectTypeOf<
      ColorGraphIntent & { lut: LUTData | null }
    >().toExtend<ExportColorGraphInput>()
    expectTypeOf<ExportColorGraphInput>().toEqualTypeOf<
      Parameters<typeof resolveExportColorGraph>[0]
    >()
  })

  it('keeps built-in looks a valid selection that export still refuses', () => {
    const builtin = normalizeColorGraphIntent(
      { ...LEGACY_PARAMS, styleKind: 'builtin', builtinPreset: 'film-soft' },
      APP_ENTRY,
    )

    expect(builtin).toMatchObject({
      styleKind: 'builtin',
      builtinPreset: 'film-soft',
      intensity: 0.37,
    })
    expect(resolveExportColorGraph({ ...builtin, lut: null })).toEqual({
      supported: false,
      reason: 'unsupported-pipeline',
      message:
        'Built-in styles are not supported by full-resolution JPEG export.',
      steps: [],
    })
  })
})
