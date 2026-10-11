// @vitest-environment node
import type {
  ExportColorGraphInput,
  LUTColorProfile,
} from '@lumaforge/luma-color-runtime'
import {
  generateIdentityLUT,
  NEUTRAL_USER_COLOR_INTENT,
  resolveExportColorGraph,
  TIER1_LUT_COLOR_PROFILES,
  toLUTData,
} from '@lumaforge/luma-color-runtime'
import { describe, expect, it } from 'vitest'

import {
  colorGraphIdentity,
  fingerprintColorGraph,
} from './color-graph-descriptor'
import { checkColorGraphIdentity } from './color-graph-validation'

type Json = Record<string, any>

const exposure = {
  ev: 0.4,
  multiplier: 2 ** 0.4,
  source: 'dng-baseline' as const,
}

function identityFor(input: Partial<ExportColorGraphInput> = {}): Json {
  const graph = resolveExportColorGraph({
    styleKind: input.lut ? 'custom' : 'none',
    intensity: 0.6,
    builtinPreset: null,
    lut: null,
    rawRenderExposure: exposure,
    ...input,
  })
  if (!graph.supported) throw new Error(graph.message)
  return JSON.parse(JSON.stringify(colorGraphIdentity(graph))) as Json
}

function lutWith(profile: LUTColorProfile) {
  return {
    ...toLUTData(generateIdentityLUT(17)),
    profileResolution: {
      kind: 'confirmed' as const,
      profile,
      confidence: 'user' as const,
    },
  }
}

function issuesOf(graph: unknown): string[] {
  const issues: string[] = []
  checkColorGraphIdentity(graph, 'color_graph', (path, message) =>
    issues.push(`${path}: ${message}`),
  )
  return issues
}

function pathsOf(graph: unknown): string[] {
  return issuesOf(graph).map((issue) => issue.slice(0, issue.indexOf(':')))
}

/** A plain identity whose descriptor is edited and fingerprinted again. */
function refingerprinted(
  edit: (descriptor: Json) => void,
  base = identityFor(),
) {
  edit(base.descriptor)
  base.fingerprint = fingerprintColorGraph(base.descriptor as never)
  return base
}

const logProfile: LUTColorProfile = {
  ...TIER1_LUT_COLOR_PROFILES[0]!,
  role: 'technical-output',
  inputRange: 'legal',
  outputGamut: 'srgb-rec709',
  outputTransfer: 'srgb',
  outputRange: 'legal',
}

describe('checkColorGraphIdentity on what the current writers record', () => {
  const written: [string, () => Json][] = [
    ['a neutral graph', () => identityFor()],
    [
      'an edited graph with every user step shifted',
      () =>
        identityFor({
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
          selectiveColor: {
            ...NEUTRAL_USER_COLOR_INTENT.selectiveColor,
            blue: { hue: 0, saturation: -30, lightness: 5 },
          },
        }),
    ],
    [
      'a display-look LUT',
      () => identityFor({ lut: toLUTData(generateIdentityLUT(17)) }),
    ],
    [
      'a legal-range technical LUT with an explicit output',
      () => identityFor({ lut: lutWith(logProfile) }),
    ],
  ]

  it.each(written)('accepts %s', (_label, build) => {
    expect(issuesOf(build())).toEqual([])
  })

  it('accepts every built-in LUT input profile as a display look', () => {
    for (const profile of TIER1_LUT_COLOR_PROFILES) {
      const graph = identityFor({
        lut: lutWith({ ...profile, role: 'display-look' }),
      })
      expect(issuesOf(graph), profile.id).toEqual([])
    }
  })
})

describe('checkColorGraphIdentity refusals', () => {
  it.each([
    ['a missing version', undefined],
    ['an older version', 1],
    ['a later version', 3],
    ['a string version', '2'],
  ])('refuses a descriptor with %s', (_label, version) => {
    const graph = refingerprinted((descriptor) => {
      if (version === undefined) delete descriptor.descriptor_version
      else descriptor.descriptor_version = version
    })
    expect(issuesOf(graph)).toEqual([
      expect.stringMatching(
        /^color_graph\.descriptor\.descriptor_version: must be 2, /,
      ),
    ])
  })

  const malformed: [string, (descriptor: Json) => void, string[]][] = [
    [
      'a step missing a field',
      (d) => delete d.steps[2].gain,
      ['color_graph.descriptor.steps.2.gain'],
    ],
    [
      'a step with a field its writer never records',
      (d) => (d.steps[1].source = 'dng-baseline'),
      ['color_graph.descriptor.steps.1.source'],
    ],
    [
      'a string step value',
      (d) => (d.steps[3].ev = '0'),
      ['color_graph.descriptor.steps.3.ev'],
    ],
    [
      'a short luminance vector',
      (d) => (d.steps[4].luminanceCoefficients = [0.3, 0.6]),
      ['color_graph.descriptor.steps.4.luminanceCoefficients'],
    ],
    [
      'an unknown operator',
      (d) => (d.steps[6].operator = 'hsv-scale'),
      ['color_graph.descriptor.steps.6.operator'],
    ],
    [
      'an incomplete HSL step',
      (d) => delete d.steps[7].bands.aqua,
      ['color_graph.descriptor.steps.7.bands.aqua'],
    ],
    [
      'a dropped step',
      (d) => d.steps.splice(5, 1),
      ['color_graph.descriptor.steps'],
    ],
    [
      'reordered steps',
      (d) => d.steps.reverse(),
      ['color_graph.descriptor.steps'],
    ],
    [
      'a built-in style step',
      (d) =>
        d.steps.splice(8, 0, {
          kind: 'builtin-style',
          preset: 'film-soft',
          intensity: 1,
        }),
      ['color_graph.descriptor.steps'],
    ],
    [
      'a LUT profile without LUT steps',
      (d) =>
        (d.lut_profile = {
          role: 'display-look',
          input: { gamut: 'srgb-rec709', transfer: 'srgb', range: 'full' },
          output: { gamut: 'srgb-rec709', transfer: 'srgb', range: 'full' },
        }),
      ['color_graph.descriptor.steps'],
    ],
    [
      'a missing LUT profile',
      (d) => delete d.lut_profile,
      ['color_graph.descriptor.lut_profile'],
    ],
    [
      'a non-sRGB output',
      (d) => (d.output_gamut = 'display-p3'),
      ['color_graph.descriptor.output_gamut'],
    ],
    [
      'a descriptor field its writer never records',
      (d) => (d.x_note = 'kept'),
      ['color_graph.descriptor.x_note'],
    ],
    [
      'steps that are not an array',
      (d) => (d.steps = {}),
      ['color_graph.descriptor.steps'],
    ],
  ]

  it.each(malformed)(
    'refuses a fingerprinted descriptor with %s',
    (_label, edit, paths) => {
      expect(pathsOf(refingerprinted(edit))).toEqual(paths)
    },
  )

  it('refuses malformed LUT steps and profile', () => {
    const graph = refingerprinted(
      (d) => {
        d.lut_profile.output.range = 'unknown'
        d.steps[10].data_sha256 = 'not-a-hash'
        d.steps[10].data_encoding = 'float16-le'
        d.steps[8].matrix = [1, 0, 0]
      },
      identityFor({ lut: toLUTData(generateIdentityLUT(17)) }),
    )
    expect(pathsOf(graph)).toEqual([
      'color_graph.descriptor.lut_profile.output.range',
      'color_graph.descriptor.steps.8.matrix',
      'color_graph.descriptor.steps.10.data_sha256',
      'color_graph.descriptor.steps.10.data_encoding',
    ])
  })

  it('refuses a descriptor its fingerprint does not cover', () => {
    const graph = identityFor()
    graph.descriptor.steps[1].ev = 4
    expect(issuesOf(graph)).toEqual([
      'color_graph.fingerprint: does not match the recorded descriptor.',
    ])
  })

  it('compares no fingerprint until the structure holds', () => {
    const graph = identityFor()
    delete graph.descriptor.steps[1].multiplier
    expect(pathsOf(graph)).toEqual([
      'color_graph.descriptor.steps.1.multiplier',
    ])
  })

  it.each([
    ['a non-object identity', 'v2', ['color_graph']],
    [
      'a string descriptor',
      { fingerprint: 'f'.repeat(64), descriptor: 'v2' },
      ['color_graph.descriptor'],
    ],
    [
      'a malformed fingerprint',
      { ...identityFor(), fingerprint: 'F'.repeat(64) },
      ['color_graph.fingerprint'],
    ],
  ])('refuses %s', (_label, graph, paths) => {
    expect(pathsOf(graph)).toEqual(paths)
  })
})
