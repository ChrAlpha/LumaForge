// @vitest-environment node
import { generateIdentityLUT, toLUTData } from '@lumaforge/luma-color-runtime'
import {
  canonicalizeJson,
  invertManifestRenderParams,
  projectManifestRenderParams,
} from '@lumaforge/render-engine'
import { describe, expect, it } from 'vitest'

import type { RenderParams } from '../schemas/params'
import { parseRenderParams } from '../schemas/params'
import {
  buildColorGraph,
  COLOR_GRAPH_DESCRIPTOR_VERSION,
  describeColorGraph,
  fingerprintColorGraph,
  manifestToRenderParams,
  requireSupportedGraph,
  resolveExposure,
  toManifestRenderParams,
  toSelectiveColorBands,
} from './color-graph'

const frame = { data: new Uint16Array(4 * 3).fill(30000), width: 2, height: 2 }

describe('resolveExposure', () => {
  it('prefers the DNG baseline in auto mode', () => {
    expect(
      resolveExposure(parseRenderParams({}), {
        baselineExposure: -0.25,
        frame,
      }),
    ).toMatchObject({ ev: -0.25, source: 'dng-baseline' })
  })
  it('falls back to image statistics, then identity', () => {
    expect(
      resolveExposure(parseRenderParams({}), {
        baselineExposure: undefined,
        frame,
      }).source,
    ).toBe('image-statistics')
    expect(
      resolveExposure(parseRenderParams({}), {
        baselineExposure: undefined,
        frame: null,
      }).source,
    ).toBe('identity')
  })
  it('honours an explicit EV', () => {
    expect(
      resolveExposure(parseRenderParams({ raw_render_exposure: 0.5 }), {
        baselineExposure: -1,
        frame,
      }),
    ).toEqual({ ev: 0.5, multiplier: Math.pow(2, 0.5), source: 'user' })
  })
})

describe('buildColorGraph + describeColorGraph', () => {
  const exposure = { ev: 0, multiplier: 1, source: 'identity' as const }

  it('produces a supported graph without a LUT and a stable fingerprint', () => {
    const a = requireSupportedGraph(
      buildColorGraph(parseRenderParams({ contrast: 10 }), null, exposure),
    )
    const b = requireSupportedGraph(
      buildColorGraph(parseRenderParams({ contrast: 10 }), null, exposure),
    )
    const c = requireSupportedGraph(
      buildColorGraph(parseRenderParams({ contrast: 11 }), null, exposure),
    )
    expect(a.steps.map((s) => s.kind)).toContain('user-contrast')
    expect(fingerprintColorGraph(describeColorGraph(a))).toBe(
      fingerprintColorGraph(describeColorGraph(b)),
    )
    expect(fingerprintColorGraph(describeColorGraph(a))).not.toBe(
      fingerprintColorGraph(describeColorGraph(c)),
    )
  })

  it('replaces LUT tables with a hash and converts typed arrays', () => {
    const lut = toLUTData(generateIdentityLUT(17))
    const graph = requireSupportedGraph(
      buildColorGraph(parseRenderParams({}), lut, exposure),
    )
    const descriptor = describeColorGraph(graph)
    expect(descriptor.descriptor_version).toBe(COLOR_GRAPH_DESCRIPTOR_VERSION)
    const lutStep = descriptor.steps.find(
      (s) => (s as { kind: string }).kind === 'lut3d',
    ) as Record<string, unknown>
    expect(lutStep.data).toBeUndefined()
    expect(lutStep.data_sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(lutStep.data_length).toBe(17 * 17 * 17 * 3)
    const matrixStep = descriptor.steps.find(
      (s) => (s as { kind: string }).kind === 'gamut-to-lut-input',
    ) as Record<string, unknown>
    expect(Array.isArray(matrixStep.matrix)).toBe(true)
    expect(JSON.parse(JSON.stringify(descriptor))).toEqual(descriptor)
  })

  it('maps params onto manifest render_params', () => {
    const params = parseRenderParams({
      exposure_ev: 1,
      contrast: 5,
      temperature: 10,
      tint: -2,
      saturation: 3,
      vibrance: 4,
      intensity: 0.5,
    })
    expect(
      toManifestRenderParams(params, {
        ev: -0.2,
        multiplier: 0.87,
        source: 'dng-baseline',
      }),
    ).toEqual({
      exposure_ev: 1,
      tone_curve: {
        contrast: 5,
        highlights: 0,
        shadows: 0,
        whites: 0,
        blacks: 0,
      },
      color_balance: { temperature: 10, tint: -2 },
      saturation: { saturation: 3, vibrance: 4 },
      intensity: 0.5,
      raw_render_exposure_ev: -0.2,
      raw_render_exposure_source: 'dng-baseline',
    })
  })
})

describe('toManifestRenderParams canonical bytes', () => {
  // Reviewed literal canonical JSON. The browser export writer keeps its own
  // goldens for the same inputs; the two must only differ where noted below.
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
  const EXPLICIT_NEUTRAL_HSL_GOLDEN =
    '{"color_balance":{"temperature":0,"tint":0},"exposure_ev":0,' +
    '"intensity":1,"raw_render_exposure_ev":0,' +
    '"raw_render_exposure_source":"identity",' +
    '"saturation":{"saturation":0,"vibrance":0},' +
    '"selective_color":{' +
    '"aqua":{"hue":0,"lightness":0,"saturation":0},' +
    '"blue":{"hue":0,"lightness":0,"saturation":0},' +
    '"green":{"hue":0,"lightness":0,"saturation":0},' +
    '"magenta":{"hue":0,"lightness":0,"saturation":0},' +
    '"orange":{"hue":0,"lightness":0,"saturation":0},' +
    '"purple":{"hue":0,"lightness":0,"saturation":0},' +
    '"red":{"hue":0,"lightness":0,"saturation":0},' +
    '"yellow":{"hue":0,"lightness":0,"saturation":0}},' +
    '"tone_curve":{"blacks":0,"contrast":0,"highlights":0,"shadows":0,"whites":0}}'

  const dngExposure = {
    ev: -0.25,
    multiplier: Math.pow(2, -0.25),
    source: 'dng-baseline' as const,
  }
  const identityExposure = { ev: 0, multiplier: 1, source: 'identity' as const }
  const neutralBand = { hue: 0, saturation: 0, lightness: 0 }

  it('freezes non-neutral scalars', () => {
    const renderParams = toManifestRenderParams(
      parseRenderParams({
        exposure_ev: 0.5,
        contrast: 12,
        highlights: -20,
        shadows: 15,
        whites: -8,
        blacks: 6,
        temperature: 10,
        tint: -4,
        saturation: 7,
        vibrance: 18,
        intensity: 0.75,
      }),
      dngExposure,
    )

    expect(canonicalizeJson(renderParams)).toBe(NON_NEUTRAL_SCALARS_GOLDEN)
  })

  it('freezes shifted selective color as all eight bands', () => {
    const renderParams = toManifestRenderParams(
      parseRenderParams({
        selective_color: {
          red: { hue: 10 },
          blue: { saturation: -30, lightness: 5 },
        },
      }),
      identityExposure,
    )

    expect(canonicalizeJson(renderParams)).toBe(SHIFTED_HSL_GOLDEN)
  })

  it('freezes absent selective color as an omitted key', () => {
    const renderParams = toManifestRenderParams(
      parseRenderParams({}),
      identityExposure,
    )

    expect(canonicalizeJson(renderParams)).toBe(NEUTRAL_GOLDEN)
  })

  it('records an explicit all-neutral selective color record', () => {
    // The browser export writer omits this record, so the two manifests hash
    // differently today.
    const renderParams = toManifestRenderParams(
      parseRenderParams({
        selective_color: {
          red: neutralBand,
          orange: neutralBand,
          yellow: neutralBand,
          green: neutralBand,
          aqua: neutralBand,
          blue: neutralBand,
          purple: neutralBand,
          magenta: neutralBand,
        },
      }),
      identityExposure,
    )

    expect(canonicalizeJson(renderParams)).toBe(EXPLICIT_NEUTRAL_HSL_GOLDEN)
    expect(canonicalizeJson(renderParams)).not.toBe(NEUTRAL_GOLDEN)
  })
})

describe('selective color', () => {
  const exposure = {
    ev: -0.25,
    multiplier: Math.pow(2, -0.25),
    source: 'dng-baseline' as const,
  }
  const neutralBand = { hue: 0, saturation: 0, lightness: 0 }

  it('fills missing bands with neutral shifts', () => {
    expect(toSelectiveColorBands(null)).toBeUndefined()
    const bands = toSelectiveColorBands({
      red: { hue: 10 },
      blue: { lightness: -5 },
    })!
    expect(Object.keys(bands)).toEqual([
      'red',
      'orange',
      'yellow',
      'green',
      'aqua',
      'blue',
      'purple',
      'magenta',
    ])
    expect(bands.red).toEqual({ hue: 10, saturation: 0, lightness: 0 })
    expect(bands.blue).toEqual({ hue: 0, saturation: 0, lightness: -5 })
    expect(bands.green).toEqual(neutralBand)
  })

  it('reaches the color graph and changes the fingerprint', () => {
    const neutral = requireSupportedGraph(
      buildColorGraph(parseRenderParams({}), null, exposure),
    )
    const shifted = requireSupportedGraph(
      buildColorGraph(
        parseRenderParams({ selective_color: { red: { hue: 20 } } }),
        null,
        exposure,
      ),
    )
    const step = shifted.steps.find(
      (s) => s.kind === 'user-selective-color',
    ) as {
      bands: Record<string, { hue: number }>
    }
    expect(step.bands.red.hue).toBe(20)
    expect(fingerprintColorGraph(describeColorGraph(shifted))).not.toBe(
      fingerprintColorGraph(describeColorGraph(neutral)),
    )
  })

  it('round-trips params through the manifest shape', () => {
    const params = parseRenderParams({
      exposure_ev: 0.5,
      contrast: 12,
      temperature: -8,
      saturation: 3,
      intensity: 0.7,
      selective_color: { aqua: { saturation: 15 } },
    })
    const manifestParams = toManifestRenderParams(params, exposure)
    expect(manifestParams.selective_color?.aqua).toEqual({
      hue: 0,
      saturation: 15,
      lightness: 0,
    })
    const restored = manifestToRenderParams(manifestParams)
    expect(restored).toEqual({
      ...params,
      raw_render_exposure: -0.25,
      selective_color: {
        red: neutralBand,
        orange: neutralBand,
        yellow: neutralBand,
        green: neutralBand,
        aqua: { hue: 0, saturation: 15, lightness: 0 },
        blue: neutralBand,
        purple: neutralBand,
        magenta: neutralBand,
      },
    })
    const fingerprintOf = (p: typeof params) =>
      fingerprintColorGraph(
        describeColorGraph(
          requireSupportedGraph(buildColorGraph(p, null, exposure)),
        ),
      )
    expect(fingerprintOf(restored)).toBe(fingerprintOf(params))
    expect(
      manifestToRenderParams(
        toManifestRenderParams(parseRenderParams({}), exposure),
      ).selective_color,
    ).toBeNull()
  })
})

describe('shared manifest projection', () => {
  const exposure = {
    ev: -0.25,
    multiplier: Math.pow(2, -0.25),
    source: 'dng-baseline' as const,
  }
  const neutralBand = { hue: 0, saturation: 0, lightness: 0 }

  function shared(params: RenderParams) {
    return projectManifestRenderParams({
      userColor: {
        userExposureEv: params.exposure_ev,
        userContrast: params.contrast,
        userHighlights: params.highlights,
        userShadows: params.shadows,
        userWhites: params.whites,
        userBlacks: params.blacks,
        userTemperature: params.temperature,
        userTint: params.tint,
        userSaturation: params.saturation,
        userVibrance: params.vibrance,
        selectiveColor: params.selective_color,
      },
      intensity: params.intensity,
      rawRenderExposure: exposure,
    })
  }

  it('writes the CLI bytes for absent, partial and non-neutral input', () => {
    for (const input of [
      {},
      { contrast: 12, temperature: -8, intensity: 0.37 },
      { selective_color: { red: { hue: 10 }, blue: { lightness: 5 } } },
    ]) {
      const params = parseRenderParams(input)
      expect(canonicalizeJson(shared(params))).toBe(
        canonicalizeJson(toManifestRenderParams(params, exposure)),
      )
    }
  })

  it('omits the explicit all-neutral record the CLI writer still records', () => {
    const params = parseRenderParams({
      selective_color: { red: neutralBand, aqua: { hue: 0 } },
    })
    expect(
      toManifestRenderParams(params, exposure).selective_color,
    ).toBeDefined()
    expect(shared(params).selective_color).toBeUndefined()
  })

  it('reads CLI-written params back to the same color graph', () => {
    const params = parseRenderParams({
      exposure_ev: 0.5,
      contrast: 12,
      saturation: 3,
      intensity: 0.7,
      selective_color: { aqua: { saturation: 15 } },
    })
    const written = toManifestRenderParams(params, exposure)
    const intent = invertManifestRenderParams(written)
    expect(intent.intensity).toBe(0.7)
    expect(intent.rawRenderExposure).toEqual({
      ev: -0.25,
      source: 'dng-baseline',
    })
    const viaShared = parseRenderParams({
      exposure_ev: intent.userColor.userExposureEv,
      contrast: intent.userColor.userContrast,
      highlights: intent.userColor.userHighlights,
      shadows: intent.userColor.userShadows,
      whites: intent.userColor.userWhites,
      blacks: intent.userColor.userBlacks,
      temperature: intent.userColor.userTemperature,
      tint: intent.userColor.userTint,
      saturation: intent.userColor.userSaturation,
      vibrance: intent.userColor.userVibrance,
      intensity: intent.intensity ?? 1,
      raw_render_exposure: intent.rawRenderExposure?.ev ?? 'auto',
      selective_color: intent.userColor.selectiveColor,
    })
    const fingerprintOf = (p: RenderParams) =>
      fingerprintColorGraph(
        describeColorGraph(
          requireSupportedGraph(buildColorGraph(p, null, exposure)),
        ),
      )
    expect(fingerprintOf(viaShared)).toBe(
      fingerprintOf(manifestToRenderParams(written)),
    )
    expect(fingerprintOf(viaShared)).toBe(fingerprintOf(params))
  })
})
