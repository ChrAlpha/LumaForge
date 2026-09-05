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
})
