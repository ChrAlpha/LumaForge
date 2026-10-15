import { describe, expect, expectTypeOf, it } from 'vitest'

import { normalizeColorBalanceParams } from './color-balance'
import type { ExportColorGraphInput } from './color-graph'
import { resolveExportColorGraph } from './color-graph'
import { generateIdentityLUT, toLUTData } from './cube-parser'
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
  isHSLBandNeutral,
  isSelectiveColorNeutral,
  NEUTRAL_HSL_BAND,
  NEUTRAL_SELECTIVE_COLOR,
  normalizeSelectiveColorParams,
} from './selective-color'
import { normalizeToneParams } from './tone'
import type { LUTData } from './types'
import type {
  ColorGraphIntent,
  ColorGraphIntentInput,
  LookSelection,
  UserColorIntent,
  UserColorIntentInput,
} from './user-color-intent'
import {
  BUILTIN_STYLE_PRESETS,
  COLOR_GRAPH_INTENT_KEYS,
  colorGraphIntentSignature,
  HSL_SHIFT_BOUNDS,
  LOOK_SELECTION_KEYS,
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
  userColorIntentSignature,
} from './user-color-intent'

// The app starts a fresh look at 0.7; the CLI renders at 1 unless told
// otherwise. The package owns neither default, so each entry passes its own.
const APP_ENTRY = { defaultIntensity: 0.7 } as const
const CLI_ENTRY = { defaultIntensity: 1 } as const

/** A complete intent: a custom look over edited user color and HSL. */
const EDITED: ColorGraphIntent = Object.freeze({
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
  selectiveColor: Object.freeze({
    ...NEUTRAL_SELECTIVE_COLOR,
    orange: Object.freeze({ hue: 6, saturation: -12, lightness: 4 }),
  }),
})

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

function sameColorGraphIntent(left: ColorGraphIntent, right: ColorGraphIntent) {
  return colorGraphIntentSignature(left) === colorGraphIntentSignature(right)
}

function sameUserColorIntent(left: UserColorIntent, right: UserColorIntent) {
  return userColorIntentSignature(left) === userColorIntentSignature(right)
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
    ...toLUTData(generateIdentityLUT(2)),
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
  it('names exactly the fields of each intent type', () => {
    expect([...COLOR_GRAPH_INTENT_KEYS].sort()).toEqual(
      Object.keys(EDITED).sort(),
    )
    expectTypeOf<keyof ColorGraphIntent>().toEqualTypeOf<
      (typeof COLOR_GRAPH_INTENT_KEYS)[number]
    >()
    expectTypeOf<keyof LookSelection>().toEqualTypeOf<
      (typeof LOOK_SELECTION_KEYS)[number]
    >()
    expectTypeOf<keyof UserColorIntent>().toEqualTypeOf<
      (typeof USER_COLOR_INTENT_KEYS)[number]
    >()
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
  it('states the range each normalizer clamps to', () => {
    for (const key of USER_COLOR_SCALAR_KEYS) {
      const { min, max } = USER_COLOR_FIELD_BOUNDS[key]
      const at = (value: number) =>
        normalizeUserColorIntent(
          Object.fromEntries([[key, value]]) as UserColorIntentInput,
        )[key]
      expect(at(max + 1000)).toBe(max)
      expect(at(min - 1000)).toBe(min)
    }
    for (const axis of HSL_SHIFT_AXES) {
      const clamped = normalizeSelectiveColorParams({
        selectiveColor: { red: shift(axis, 1000), blue: shift(axis, -1000) },
      })
      expect(clamped.red[axis]).toBe(HSL_SHIFT_BOUNDS.max)
      expect(clamped.blue[axis]).toBe(HSL_SHIFT_BOUNDS.min)
    }
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
      ...EDITED,
      viewMode: 'compare',
      compareSplit: 0.25,
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
    expect(graphIntent).toEqual(EDITED)
    expect(graphIntent).not.toHaveProperty('viewMode')
    expect(graphIntent).not.toHaveProperty('extra')
  })

  it('is idempotent', () => {
    const inputs: (ColorGraphIntentInput | undefined)[] = [
      undefined,
      {},
      messy,
      EDITED,
      { ...EDITED, selectiveColor: undefined },
      { ...EDITED, intensity: Number.NaN },
      { ...EDITED, intensity: 1.6, userContrast: -900 },
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
    expect(sameColorGraphIntent(app, cli)).toBe(false)
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
  it('copies the intent out of a larger record without changing a value', () => {
    const record = {
      ...EDITED,
      rawRenderExposure: { ev: 1, multiplier: 2, source: 'user' },
      lut: displayLookLut(),
    }
    const picked = pickColorGraphIntent(record)

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
      selectiveColor: bands({
        orange: { hue: 6, saturation: -12, lightness: 4 },
      }),
    })
    expect(Object.keys(picked)).toEqual([...COLOR_GRAPH_INTENT_KEYS])
    expect(picked.selectiveColor).toBe(EDITED.selectiveColor)
    expect(picked).not.toHaveProperty('rawRenderExposure')
    expect(picked).not.toHaveProperty('lut')

    // Picking copies; clamping is normalization's job.
    expect(
      pickUserColorIntent({ ...EDITED, userContrast: 400 }).userContrast,
    ).toBe(400)
    expect(Object.keys(pickUserColorIntent(record))).toEqual([
      ...USER_COLOR_INTENT_KEYS,
    ])
    expect(pickLookSelection(record)).toEqual({
      styleKind: 'custom',
      builtinPreset: null,
      intensity: 0.37,
    })
  })
})

describe('identity', () => {
  const base: ColorGraphIntent = {
    ...EDITED,
    selectiveColor: bands({
      green: { hue: -25, saturation: 10, lightness: 5 },
    }),
  }

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
    expect(sameColorGraphIntent(reordered, base)).toBe(true)
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
    expect(sameColorGraphIntent(decorated, base)).toBe(true)
    const otherView = { ...decorated, viewMode: 'processed', compareSplit: 0 }
    expect(sameColorGraphIntent(otherView, decorated)).toBe(true)
  })

  it('shares one identity for every spelling of neutral HSL', () => {
    const neutral: ColorGraphIntent = {
      ...EDITED,
      selectiveColor: NEUTRAL_SELECTIVE_COLOR,
    }
    const explicit: ColorGraphIntent = { ...EDITED, selectiveColor: bands() }
    // HSL as it may arrive, before normalization fills it in.
    const inputs: ColorGraphIntentInput[] = [
      { ...EDITED, selectiveColor: undefined },
      { ...EDITED, selectiveColor: null },
      { ...EDITED, selectiveColor: {} },
      { ...EDITED, selectiveColor: { red: { hue: 0 } } },
      { ...EDITED, selectiveColor: { blue: { saturation: Number.NaN } } },
      { ...EDITED, selectiveColor: { green: { lightness: -0 } } },
    ]
    const expected = colorGraphIntentSignature(neutral)

    expect(colorGraphIntentSignature(explicit)).toBe(expected)
    expect(sameColorGraphIntent(explicit, neutral)).toBe(true)
    expect(sameUserColorIntent(explicit, neutral)).toBe(true)
    for (const input of inputs) {
      const normalized = normalizeColorGraphIntent(input, APP_ENTRY)
      expect(isSelectiveColorNeutral(normalized.selectiveColor)).toBe(true)
      expect(colorGraphIntentSignature(normalized)).toBe(expected)
      expect(
        sameUserColorIntent(normalizeUserColorIntent(input), neutral),
      ).toBe(true)
    }
    expect(sameColorGraphIntent(EDITED, neutral)).toBe(false)
  })

  it('changes with any continuous look strength', () => {
    const strengths = [0, 0.37, 0.3700001, 0.4, 0.7, 1]
    const signatures = strengths.map((intensity) =>
      colorGraphIntentSignature({ ...base, intensity }),
    )

    expect(new Set(signatures).size).toBe(strengths.length)
    expect(
      sameColorGraphIntent(
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
      expect(sameColorGraphIntent(changed, base)).toBe(false)
      expect(sameUserColorIntent(changed, base)).toBe(false)
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
        expect(sameColorGraphIntent(shifted, base)).toBe(false)
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
    expect(sameUserColorIntent(otherLook, base)).toBe(true)
    expect(sameColorGraphIntent(otherLook, base)).toBe(false)
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
    const inputs: ColorGraphIntent[] = [
      EDITED,
      base,
      { ...base, intensity: 0 },
      { ...base, styleKind: 'builtin', builtinPreset: 'cinematic' },
      { ...EDITED, userSaturation: 250, userWhites: Number.NaN },
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

describe('retained built-in presets', () => {
  it('keep a built-in look a valid selection', () => {
    for (const builtinPreset of BUILTIN_STYLE_PRESETS) {
      const builtin = normalizeColorGraphIntent(
        { ...EDITED, styleKind: 'builtin', builtinPreset },
        APP_ENTRY,
      )

      expect(builtin).toEqual({
        ...EDITED,
        styleKind: 'builtin',
        builtinPreset,
      })
    }
  })
})

describe('executor boundary', () => {
  /** The edited intent with its HSL left out, as persisted data can be. */
  const { selectiveColor: _omitted, ...WITHOUT_HSL } = EDITED

  it('requires HSL wherever a complete intent is read', () => {
    expectTypeOf<typeof WITHOUT_HSL>().not.toExtend<ColorGraphIntent>()
    expectTypeOf<typeof WITHOUT_HSL>().not.toExtend<UserColorIntent>()
    expectTypeOf<ColorGraphIntent>().not.toHaveProperty('viewMode')
    expectTypeOf<ColorGraphIntent>().not.toHaveProperty('compareSplit')
    expectTypeOf(pickUserColorIntent)
      .parameter(0)
      .toEqualTypeOf<UserColorIntent>()
    expectTypeOf(pickColorGraphIntent)
      .parameter(0)
      .toEqualTypeOf<ColorGraphIntent>()
    expectTypeOf(userColorIntentSignature)
      .parameter(0)
      .toEqualTypeOf<UserColorIntent>()
    expectTypeOf(colorGraphIntentSignature)
      .parameter(0)
      .toEqualTypeOf<ColorGraphIntent>()
    expectTypeOf<ExportColorGraphInput['selectiveColor']>().toEqualTypeOf<
      UserColorIntent['selectiveColor']
    >()
    expectTypeOf<
      ColorGraphIntent & { lut: LUTData | null }
    >().toExtend<ExportColorGraphInput>()
    expectTypeOf<
      typeof WITHOUT_HSL & { lut: LUTData | null }
    >().not.toExtend<ExportColorGraphInput>()
  })

  it('takes partial input only through normalization', () => {
    const normalized = normalizeColorGraphIntent(WITHOUT_HSL, APP_ENTRY)
    const neutralHsl: ColorGraphIntent = {
      ...EDITED,
      selectiveColor: NEUTRAL_SELECTIVE_COLOR,
    }
    const lut = displayLookLut()

    expect(normalized).toEqual(neutralHsl)
    expect(normalizeUserColorIntent(WITHOUT_HSL)).toEqual(
      pickUserColorIntent(neutralHsl),
    )
    expect(colorGraphIntentSignature(normalized)).toBe(
      colorGraphIntentSignature(neutralHsl),
    )
    expect(resolveExportColorGraph({ ...normalized, lut })).toEqual(
      resolveExportColorGraph({ ...neutralHsl, lut }),
    )
    expectTypeOf(normalizeUserColorIntent)
      .parameter(0)
      .toEqualTypeOf<UserColorIntentInput | null | undefined>()
    expectTypeOf<typeof WITHOUT_HSL>().toExtend<ColorGraphIntentInput>()
  })
})
