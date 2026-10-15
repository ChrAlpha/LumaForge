// @vitest-environment node
import type { ColorGraphIntent } from '@lumaforge/luma-color-runtime'
import { NEUTRAL_USER_COLOR_INTENT } from '@lumaforge/luma-color-runtime'
import { describe, expect, it } from 'vitest'

import { canonicalizeJson } from './canonicalize'
import type { RenderParams } from './render-manifest'
import type { ManifestRenderParamsInput } from './render-params'
import { projectManifestRenderParams } from './render-params'

// Reviewed literal canonical JSON. The browser export writer and the CLI
// writer both record render params through this projection, so they write
// these bytes for the same inputs.
const NON_NEUTRAL_SCALARS_GOLDEN =
  '{"color_balance":{"temperature":10,"tint":-4},"exposure_ev":0.5,' +
  '"intensity":0.75,"raw_render_exposure_ev":-0.25,' +
  '"raw_render_exposure_source":"dng-baseline",' +
  '"saturation":{"saturation":7,"vibrance":18},' +
  '"tone_curve":{"blacks":6,"contrast":12,"highlights":-20,"shadows":15,"whites":-8}}'
const NEUTRAL_GOLDEN =
  '{"color_balance":{"temperature":0,"tint":0},"exposure_ev":0,' +
  '"intensity":1,"raw_render_exposure_ev":0,' +
  '"raw_render_exposure_source":"identity",' +
  '"saturation":{"saturation":0,"vibrance":0},' +
  '"tone_curve":{"blacks":0,"contrast":0,"highlights":0,"shadows":0,"whites":0}}'
const SHIFTED_HSL_GOLDEN =
  '{"color_balance":{"temperature":0,"tint":0},"exposure_ev":0,' +
  '"intensity":1,"raw_render_exposure_ev":0,' +
  '"raw_render_exposure_source":"identity",' +
  '"saturation":{"saturation":0,"vibrance":0},' +
  '"selective_color":{' +
  '"aqua":{"hue":0,"lightness":0,"saturation":0},' +
  '"blue":{"hue":0,"lightness":5,"saturation":-30},' +
  '"green":{"hue":0,"lightness":0,"saturation":0},' +
  '"magenta":{"hue":0,"lightness":0,"saturation":0},' +
  '"orange":{"hue":0,"lightness":0,"saturation":0},' +
  '"purple":{"hue":0,"lightness":0,"saturation":0},' +
  '"red":{"hue":10,"lightness":0,"saturation":0},' +
  '"yellow":{"hue":0,"lightness":0,"saturation":0}},' +
  '"tone_curve":{"blacks":0,"contrast":0,"highlights":0,"shadows":0,"whites":0}}'
const GEOMETRY_CONTINUOUS_GOLDEN =
  '{"color_balance":{"temperature":0,"tint":0},"exposure_ev":0,' +
  '"geometry":{"constrain_crop":true,' +
  '"matrix":[0.98,0.02,0,-0.02,0.98,0.01,0,0,1],' +
  '"output":{"height":2000,"width":3000}},' +
  '"intensity":0.37,"raw_render_exposure_ev":0.4125,' +
  '"raw_render_exposure_source":"image-statistics",' +
  '"saturation":{"saturation":0,"vibrance":0},' +
  '"tone_curve":{"blacks":0,"contrast":0,"highlights":0,"shadows":0,"whites":0}}'

const dngExposure = { ev: -0.25, source: 'dng-baseline' as const }
const identityExposure = { ev: 0, source: 'identity' as const }
const neutralBand = { hue: 0, saturation: 0, lightness: 0 }
const explicitNeutralSelectiveColor = {
  red: neutralBand,
  orange: neutralBand,
  yellow: neutralBand,
  green: neutralBand,
  aqua: neutralBand,
  blue: neutralBand,
  purple: neutralBand,
  magenta: neutralBand,
}
const geometry = {
  matrix: [0.98, 0.02, 0, -0.02, 0.98, 0.01, 0, 0, 1],
  constrain_crop: true,
  output: { width: 3000, height: 2000 },
}

const nonNeutralUserColor = {
  userExposureEv: 0.5,
  userContrast: 12,
  userHighlights: -20,
  userShadows: 15,
  userWhites: -8,
  userBlacks: 6,
  userTemperature: 10,
  userTint: -4,
  userSaturation: 7,
  userVibrance: 18,
}

function project(
  overrides: Partial<ManifestRenderParamsInput> = {},
): RenderParams {
  return projectManifestRenderParams({
    userColor: {},
    intensity: 1,
    rawRenderExposure: identityExposure,
    ...overrides,
  })
}

describe('projectManifestRenderParams canonical bytes', () => {
  it('freezes non-neutral scalars and a non-zero recorded exposure', () => {
    const params = project({
      userColor: nonNeutralUserColor,
      intensity: 0.75,
      rawRenderExposure: dngExposure,
    })
    expect(canonicalizeJson(params)).toBe(NON_NEUTRAL_SCALARS_GOLDEN)
  })

  it('freezes absent selective color as an omitted key at zero exposure', () => {
    expect(canonicalizeJson(project())).toBe(NEUTRAL_GOLDEN)
    expect(
      canonicalizeJson(project({ userColor: { selectiveColor: null } })),
    ).toBe(NEUTRAL_GOLDEN)
  })

  it('omits an explicit all-neutral selective color record', () => {
    expect(
      canonicalizeJson(
        project({
          userColor: { selectiveColor: explicitNeutralSelectiveColor },
        }),
      ),
    ).toBe(NEUTRAL_GOLDEN)
  })

  it('records partial selective color as all eight bands', () => {
    const params = project({
      userColor: {
        selectiveColor: {
          red: { hue: 10 },
          blue: { saturation: -30, lightness: 5 },
        },
      },
    })
    expect(canonicalizeJson(params)).toBe(SHIFTED_HSL_GOLDEN)
  })

  it('records non-neutral selective color given in full', () => {
    const params = project({
      userColor: {
        selectiveColor: {
          ...explicitNeutralSelectiveColor,
          red: { hue: 10, saturation: 0, lightness: 0 },
          blue: { hue: 0, saturation: -30, lightness: 5 },
        },
      },
    })
    expect(canonicalizeJson(params)).toBe(SHIFTED_HSL_GOLDEN)
  })

  it('records geometry, the recorded exposure and a continuous strength exactly', () => {
    const params = project({
      intensity: 0.37,
      rawRenderExposure: { ev: 0.4125, source: 'image-statistics' },
      geometry,
    })
    expect(canonicalizeJson(params)).toBe(GEOMETRY_CONTINUOUS_GOLDEN)
    expect(project({ intensity: 0.62 }).intensity).toBe(0.62)
    expect(project({ intensity: 0 }).intensity).toBe(0)
  })

  it('omits geometry when none was applied', () => {
    expect('geometry' in project()).toBe(false)
  })

  it('records user fields the way the color graph reads them', () => {
    const params = project({
      userColor: {
        userContrast: Number.NaN,
        userSaturation: 250,
        selectiveColor: { red: { hue: 400 } },
      },
    })
    expect(params.tone_curve?.contrast).toBe(0)
    expect(params.saturation?.saturation).toBe(100)
    expect(params.selective_color?.red).toEqual({
      hue: 100,
      saturation: 0,
      lightness: 0,
    })
  })

  it('accepts the app processing params as user color', () => {
    const processing: ColorGraphIntent = {
      intensity: 0.7,
      styleKind: 'builtin',
      builtinPreset: 'warm',
      ...NEUTRAL_USER_COLOR_INTENT,
      ...nonNeutralUserColor,
    }
    const params = project({
      userColor: processing,
      intensity: processing.intensity,
      rawRenderExposure: dngExposure,
    })
    expect(params.tone_curve?.contrast).toBe(12)
    expect(params.intensity).toBe(0.7)
    // The look selection never enters render_params.
    expect(canonicalizeJson(params)).not.toContain('builtin')
    expect(canonicalizeJson(params)).not.toContain('warm')
  })
})
