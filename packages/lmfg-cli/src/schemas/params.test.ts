// @vitest-environment node
import { describe, expect, it } from 'vitest'

import {
  mergeRenderParams,
  parseRenderParams,
  RenderParamsOverrideSchema,
} from './params'

describe('parseRenderParams', () => {
  it('fills defaults', () => {
    expect(parseRenderParams({})).toEqual({
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
      raw_render_exposure: 'auto',
      selective_color: null,
      lut: null,
    })
  })

  it('rejects unknown keys and out-of-range values', () => {
    expect(() => parseRenderParams({ exposure: 1 })).toThrow()
    expect(() => parseRenderParams({ exposure_ev: 9 })).toThrow()
    expect(() => parseRenderParams({ intensity: 2 })).toThrow()
  })

  it('accepts a LUT reference with a contract', () => {
    const params = parseRenderParams({
      lut: {
        path: 'look.cube',
        contract: {
          role: 'combined-look-output',
          input_profile: 'panasonic-vgamut-vlog',
          output_gamut: 'srgb-rec709',
          output_transfer: 'bt709',
          output_range: 'full',
        },
      },
    })
    expect(params.lut?.path).toBe('look.cube')
    expect(params.lut?.contract?.role).toBe('combined-look-output')
  })

  it('merges overrides without touching untouched keys', () => {
    const base = parseRenderParams({ contrast: 10 })
    const merged = mergeRenderParams(
      base,
      RenderParamsOverrideSchema.parse({ exposure_ev: 1 }),
    )
    expect(merged.contrast).toBe(10)
    expect(merged.exposure_ev).toBe(1)
    expect(base.exposure_ev).toBe(0)
  })
})

describe('selective color params', () => {
  it('accepts partial bands and rejects unknown bands or ranges', () => {
    const params = parseRenderParams({
      selective_color: {
        red: { hue: 10 },
        blue: { saturation: -20, lightness: 5 },
      },
    })
    expect(params.selective_color).toEqual({
      red: { hue: 10 },
      blue: { saturation: -20, lightness: 5 },
    })
    expect(() =>
      parseRenderParams({ selective_color: { pink: { hue: 1 } } }),
    ).toThrow()
    expect(() =>
      parseRenderParams({ selective_color: { red: { hue: 101 } } }),
    ).toThrow()
    expect(() =>
      parseRenderParams({ selective_color: { red: { tone: 1 } } }),
    ).toThrow()
  })

  it('merges candidate overrides by band and axis without mutating inputs', () => {
    const base = parseRenderParams({
      selective_color: { red: { hue: 10 }, blue: { saturation: -20 } },
    })
    const override = RenderParamsOverrideSchema.parse({
      selective_color: { red: { lightness: 5 }, yellow: { saturation: 15 } },
    })
    const baseBefore = structuredClone(base)
    const overrideBefore = structuredClone(override)

    const merged = mergeRenderParams(base, override)

    expect(merged.selective_color).toEqual({
      red: { hue: 10, lightness: 5 },
      yellow: { saturation: 15 },
      blue: { saturation: -20 },
    })
    expect(base).toEqual(baseBefore)
    expect(override).toEqual(overrideBefore)
    merged.selective_color!.blue!.saturation = 50
    merged.selective_color!.yellow!.saturation = 50
    expect(base).toEqual(baseBefore)
    expect(override).toEqual(overrideBefore)
  })

  it.each([
    {},
    { selective_color: undefined },
    { selective_color: {} },
    { selective_color: { red: {} } },
    { selective_color: { red: undefined } },
    { selective_color: { red: { hue: undefined } } },
  ])('preserves base adjustments for an omitted override: %j', (input) => {
    const base = parseRenderParams({
      selective_color: { red: { hue: 10 }, blue: { saturation: -20 } },
    })
    expect(
      mergeRenderParams(base, RenderParamsOverrideSchema.parse(input)),
    ).toEqual(base)
  })

  it('resets only an explicitly zeroed axis and clears all bands with null', () => {
    const base = parseRenderParams({
      selective_color: {
        red: { hue: 10, saturation: 20, lightness: 30 },
        blue: { saturation: -20 },
      },
    })
    expect(
      mergeRenderParams(base, { selective_color: { red: { hue: 0 } } })
        .selective_color,
    ).toEqual({
      red: { hue: 0, saturation: 20, lightness: 30 },
      blue: { saturation: -20 },
    })
    expect(
      mergeRenderParams(base, { selective_color: null }).selective_color,
    ).toBeNull()
  })

  it('adds adjustments to a null base without changing full parameter defaults', () => {
    expect(
      mergeRenderParams(parseRenderParams({}), {
        selective_color: { red: { hue: 10 } },
      }),
    ).toEqual(parseRenderParams({ selective_color: { red: { hue: 10 } } }))
    expect(
      mergeRenderParams(parseRenderParams({}), {}).selective_color,
    ).toBeNull()
  })

  it.each([{}, { red: {} }, { red: undefined }, { red: { hue: undefined } }])(
    'keeps a null base for an empty selective color override: %j',
    (selectiveColor) => {
      expect(
        mergeRenderParams(parseRenderParams({}), {
          selective_color: selectiveColor,
        }).selective_color,
      ).toBeNull()
    },
  )

  it('validates override bands and axes before merging', () => {
    const base = parseRenderParams({ selective_color: { red: { hue: 10 } } })
    const unknownBand = { red: { hue: 0 }, pink: {} }
    const unknownAxis = { red: { hue: 0, tone: 1 } }
    expect(() =>
      mergeRenderParams(base, { selective_color: unknownBand }),
    ).toThrow()
    expect(() =>
      mergeRenderParams(base, { selective_color: unknownAxis }),
    ).toThrow()
    expect(() =>
      mergeRenderParams(base, { selective_color: { red: { hue: 101 } } }),
    ).toThrow()
  })

  it('keeps LUT overrides as whole reference replacements', () => {
    const base = parseRenderParams({
      lut: { path: 'base.cube', contract: { role: 'display-look' } },
      selective_color: { blue: { saturation: -20 } },
    })
    expect(
      mergeRenderParams(base, {
        lut: { path: 'replacement.cube' },
        selective_color: { red: { hue: 10 } },
      }).lut,
    ).toEqual({ path: 'replacement.cube' })
    expect(mergeRenderParams(base, { lut: undefined }).lut).toEqual(base.lut)
    expect(mergeRenderParams(base, { lut: null }).lut).toBeNull()
  })
})
