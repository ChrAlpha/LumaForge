// @vitest-environment node
import type {
  LookSelection,
  ProcessingParams,
  UserColorIntent,
} from '@lumaforge/luma-color-runtime'
import {
  colorGraphIntentSignature,
  NEUTRAL_USER_COLOR_INTENT,
  resolveExportColorGraph,
} from '@lumaforge/luma-color-runtime'
import { describe, expect, it } from 'vitest'

import { canonicalizeJson } from './canonicalize'
import { colorGraphIdentity } from './color-graph-descriptor'
import type { RenderParams } from './render-manifest'
import type { ManifestRenderParamsInput } from './render-params'
import {
  invertManifestRenderParams,
  projectManifestRenderParams,
} from './render-params'

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

/** Parse the canonical bytes back, as a reader of a written manifest would. */
function reread(params: RenderParams): RenderParams {
  return JSON.parse(canonicalizeJson(params)) as RenderParams
}

function graphFingerprint(
  look: LookSelection,
  userColor: Partial<UserColorIntent>,
  exposure: { ev: number; source: 'dng-baseline' | 'identity' | 'user' },
): string {
  const graph = resolveExportColorGraph({
    ...look,
    ...userColor,
    lut: null,
    rawRenderExposure: { ...exposure, multiplier: 2 ** exposure.ev },
  })
  if (!graph.supported) throw new Error(graph.message)
  return colorGraphIdentity(graph).fingerprint
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
    const processing: ProcessingParams = {
      intensity: 0.7,
      viewMode: 'processed',
      compareSplit: 0.5,
      styleKind: 'builtin',
      builtinPreset: 'warm',
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

describe('invertManifestRenderParams', () => {
  it('reads omitted neutral HSL in a current record as neutral user color', () => {
    const written = reread(project())
    expect('selective_color' in written).toBe(false)
    expect(invertManifestRenderParams(written)).toEqual({
      userColor: NEUTRAL_USER_COLOR_INTENT,
      intensity: 1,
      rawRenderExposure: { ev: 0, source: 'identity' },
      geometry: null,
    })
  })

  it('keeps the recorded exposure, geometry and strength', () => {
    const intent = invertManifestRenderParams(
      reread(
        project({
          intensity: 0.37,
          rawRenderExposure: { ev: 0.4125, source: 'image-statistics' },
          geometry,
        }),
      ),
    )
    expect(intent.intensity).toBe(0.37)
    expect(intent.rawRenderExposure).toEqual({
      ev: 0.4125,
      source: 'image-statistics',
    })
    expect(intent.geometry).toEqual(geometry)
  })

  it('reads a recorded selective color band for band', () => {
    const recorded = {
      ...explicitNeutralSelectiveColor,
      aqua: { hue: 0, saturation: 15, lightness: 0 },
    }
    const intent = invertManifestRenderParams({
      ...reread(project()),
      selective_color: recorded,
    })
    expect(intent.userColor.selectiveColor).toEqual(recorded)
  })

  it('reads an explicit all-neutral record as neutral user color', () => {
    const intent = invertManifestRenderParams({
      ...reread(project()),
      selective_color: explicitNeutralSelectiveColor,
    })
    expect(intent.userColor).toEqual(NEUTRAL_USER_COLOR_INTENT)
  })

  it('never invents a LUT identity or a look selection', () => {
    const intent = invertManifestRenderParams(
      reread(project({ userColor: nonNeutralUserColor, intensity: 0.75 })),
    )
    expect(Object.keys(intent).sort()).toEqual([
      'geometry',
      'intensity',
      'rawRenderExposure',
      'userColor',
    ])
    expect(intent.userColor).not.toHaveProperty('styleKind')
    expect(intent.userColor).not.toHaveProperty('builtinPreset')
    expect(intent.userColor).not.toHaveProperty('lut')
  })
})

describe('invertManifestRenderParams reads what is recorded', () => {
  it('reads the strength and the exposure with its provenance as written', () => {
    const written = reread(
      project({
        intensity: 0,
        rawRenderExposure: { ev: 0, source: 'user' },
      }),
    )
    expect(invertManifestRenderParams(written)).toMatchObject({
      intensity: 0,
      rawRenderExposure: { ev: 0, source: 'user' },
    })
  })
})

describe('projection round trip', () => {
  const nonNeutral = {
    ...nonNeutralUserColor,
    selectiveColor: {
      ...explicitNeutralSelectiveColor,
      red: { hue: 10, saturation: 0, lightness: 0 },
      blue: { hue: 0, saturation: -30, lightness: 5 },
    },
  }
  const looks: readonly LookSelection[] = [
    { styleKind: 'none', builtinPreset: null, intensity: 0.37 },
    { styleKind: 'builtin', builtinPreset: 'film-soft', intensity: 0.7 },
  ]

  for (const look of looks) {
    it(`keeps the graph identity for a ${look.styleKind} look`, () => {
      const written = reread(
        project({
          userColor: nonNeutral,
          intensity: look.intensity,
          rawRenderExposure: dngExposure,
        }),
      )
      const restored = invertManifestRenderParams(written)
      expect(restored.intensity).toBe(look.intensity)
      expect(restored.rawRenderExposure).toEqual(dngExposure)

      // The caller supplies the look; render_params never records it.
      const restoredLook = { ...look, intensity: restored.intensity }
      expect(
        colorGraphIntentSignature({ ...restoredLook, ...restored.userColor }),
      ).toBe(colorGraphIntentSignature({ ...look, ...nonNeutral }))
      // Full-resolution export resolves no graph for built-in looks.
      if (look.styleKind === 'none') {
        expect(
          graphFingerprint(restoredLook, restored.userColor, dngExposure),
        ).toBe(graphFingerprint(look, nonNeutral, dngExposure))
      }
    })
  }

  it('projects its own inverse to the same bytes', () => {
    const written = reread(
      project({
        userColor: nonNeutral,
        intensity: 0.37,
        rawRenderExposure: dngExposure,
        geometry,
      }),
    )
    const restored = invertManifestRenderParams(written)
    const reprojected = projectManifestRenderParams({
      userColor: restored.userColor,
      intensity: restored.intensity,
      rawRenderExposure: restored.rawRenderExposure,
      geometry: restored.geometry ?? undefined,
    })
    expect(canonicalizeJson(reprojected)).toBe(canonicalizeJson(written))
  })
})
