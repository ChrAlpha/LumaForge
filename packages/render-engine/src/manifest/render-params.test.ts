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

import {
  canonicalizeJson,
  sealRenderManifest,
  verifyManifestSha256,
} from './canonicalize'
import { colorGraphIdentity } from './color-graph-descriptor'
import { createRenderManifest } from './create-render-manifest'
import type { RenderManifest, RenderParams } from './render-manifest'
import type { ManifestRenderParamsInput } from './render-params'
import {
  invertManifestRenderParams,
  projectManifestRenderParams,
  readVerifiedManifestRenderParams,
} from './render-params'

// Reviewed literal canonical JSON. The browser export writer freezes the same
// bytes for the same inputs; the CLI writer differs only by recording an
// explicit all-neutral selective color record.
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
  it('reads absent sections as neutral user color', () => {
    const intent = invertManifestRenderParams({ exposure_ev: 0 })
    expect(intent).toEqual({
      userColor: NEUTRAL_USER_COLOR_INTENT,
      intensity: null,
      rawRenderExposure: null,
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

  it('keeps a recorded EV whose source is missing', () => {
    expect(
      invertManifestRenderParams({
        exposure_ev: 0,
        raw_render_exposure_ev: 0.2,
      }).rawRenderExposure,
    ).toEqual({ ev: 0.2, source: null })
  })

  it('fills a partial recorded selective color with neutral bands', () => {
    const intent = invertManifestRenderParams({
      exposure_ev: 0,
      selective_color: { aqua: { hue: 0, saturation: 15, lightness: 0 } },
    })
    expect(intent.userColor.selectiveColor).toEqual({
      ...explicitNeutralSelectiveColor,
      aqua: { hue: 0, saturation: 15, lightness: 0 },
    })
  })

  it('reads an explicit all-neutral record as neutral user color', () => {
    const intent = invertManifestRenderParams({
      exposure_ev: 0,
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
      const restoredLook = { ...look, intensity: restored.intensity! }
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
      intensity: restored.intensity!,
      rawRenderExposure: {
        ev: restored.rawRenderExposure!.ev,
        source: restored.rawRenderExposure!.source!,
      },
      geometry: restored.geometry ?? undefined,
    })
    expect(canonicalizeJson(reprojected)).toBe(canonicalizeJson(written))
  })
})

describe('readVerifiedManifestRenderParams', () => {
  const resolved = resolveExportColorGraph({
    styleKind: 'none',
    intensity: 1,
    builtinPreset: null,
    lut: null,
    rawRenderExposure: { ev: 0, multiplier: 1, source: 'identity' },
  })
  if (!resolved.supported) throw new Error(resolved.message)
  const graph = resolved

  function manifestWith(renderParams: RenderParams): RenderManifest {
    return createRenderManifest({
      kind: 'export',
      source_raw: {
        sha256: 'a'.repeat(64),
        byte_size: 10,
        filename: 'x.dng',
        decoded_dimensions: { width: 4, height: 2 },
      },
      lut: null,
      graph,
      render_params: renderParams,
      policy: { kind: 'export-full', row_slice: 512, concurrency: 1 },
      environment: {
        render_engine: '0.1.0',
        luma_color_runtime: '0.2.0',
        luma_raw_runtime: '0.1.1',
        luma_jpeg_runtime: '0.1.1',
        native_artifacts: { build_id: 'test', variant: 'desktop' },
      },
      output: {
        width: 4,
        height: 2,
        quality: 92,
        filename: 'final.jpg',
        sha256: 'b'.repeat(64),
      },
      parent_manifest_sha256: null,
      produced_at: '2026-09-05T00:00:00.000Z',
    })
  }

  // An older writer recorded explicit-neutral HSL as eight neutral bands.
  const legacyRenderParams: RenderParams = {
    ...project(),
    selective_color: explicitNeutralSelectiveColor,
  }

  it('verifies an old manifest in the form it was written before converting it', () => {
    const legacy = reread(
      manifestWith(legacyRenderParams) as unknown as RenderParams,
    ) as unknown as RenderManifest
    const result = readVerifiedManifestRenderParams(legacy)
    expect(result).toEqual({
      ok: true,
      intent: {
        userColor: NEUTRAL_USER_COLOR_INTENT,
        intensity: 1,
        rawRenderExposure: identityExposure,
        geometry: null,
      },
    })
    // The schema and the calibration slot stay as written.
    expect(legacy.manifest_version).toBe(1)
    expect(legacy.calibration).toBeNull()
    expect(legacy.render_params.selective_color).toEqual(
      explicitNeutralSelectiveColor,
    )

    // Converting first would break the signature the old writer sealed.
    const converted = {
      ...legacy,
      render_params: projectManifestRenderParams({
        userColor: result.ok ? result.intent.userColor : {},
        intensity: 1,
        rawRenderExposure: identityExposure,
      }),
    }
    expect(canonicalizeJson(converted.render_params)).toBe(NEUTRAL_GOLDEN)
    expect(verifyManifestSha256(converted)).toBe(false)
  })

  it('refuses a manifest whose signature does not match', () => {
    const tampered = {
      ...manifestWith(project()),
      render_params: { ...project(), exposure_ev: 1 },
    }
    expect(readVerifiedManifestRenderParams(tampered)).toEqual({
      ok: false,
      reason: 'manifest-sha256-mismatch',
    })
    expect(readVerifiedManifestRenderParams(null)).toEqual({
      ok: false,
      reason: 'manifest-sha256-mismatch',
    })
  })

  it('refuses a signed manifest that records no render params', () => {
    const { render_params: _omitted, ...rest } = manifestWith(project())
    const sealed = sealRenderManifest(
      rest as unknown as Omit<RenderManifest, 'manifest_sha256'>,
    )
    expect(verifyManifestSha256(sealed)).toBe(true)
    expect(readVerifiedManifestRenderParams(sealed)).toEqual({
      ok: false,
      reason: 'render-params-missing',
    })
  })
})
