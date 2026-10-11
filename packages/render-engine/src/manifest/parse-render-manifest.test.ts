// @vitest-environment node
import {
  generateIdentityLUT,
  HSL_BAND_IDS,
  NEUTRAL_USER_COLOR_INTENT,
  resolveExportColorGraph,
  toLUTData,
} from '@lumaforge/luma-color-runtime'
import { describe, expect, it } from 'vitest'

import { computeManifestSha256 } from './canonicalize'
import { fingerprintColorGraph } from './color-graph-descriptor'
import { createRenderManifest } from './create-render-manifest'
import { parseRenderManifest } from './parse-render-manifest'
import type { RenderManifest } from './render-manifest'
import type { ManifestRenderParamsIntent } from './render-params'
import {
  invertManifestRenderParams,
  projectManifestRenderParams,
} from './render-params'

const userColor = { userExposureEv: 0.5, userContrast: 10 }
const rawRenderExposure = { ev: 0.2, source: 'dng-baseline' as const }

const resolved = resolveExportColorGraph({
  styleKind: 'none',
  intensity: 1,
  builtinPreset: null,
  lut: null,
  ...userColor,
  selectiveColor: NEUTRAL_USER_COLOR_INTENT.selectiveColor,
  rawRenderExposure: {
    ...rawRenderExposure,
    multiplier: 2 ** rawRenderExposure.ev,
  },
})
if (!resolved.supported) throw new Error(resolved.message)
const graph = resolved

const lutContract = {
  gamut: 'srgb-rec709',
  transfer: 'srgb',
  range: 'full' as const,
}

/** An export as the current writers seal it: Transform applied, HSL neutral. */
function sealed(): RenderManifest {
  return createRenderManifest({
    kind: 'export',
    source_raw: {
      sha256: 'a'.repeat(64),
      byte_size: 10,
      filename: 'x.dng',
      decoded_dimensions: { width: 4032, height: 3024 },
    },
    lut: null,
    graph,
    render_params: projectManifestRenderParams({
      userColor,
      intensity: 1,
      rawRenderExposure,
      geometry: {
        matrix: [0.99, -0.04, 0.02, 0.04, 0.99, -0.01, 0, 0, 1],
        constrain_crop: true,
        output: { width: 3900, height: 2900 },
      },
    }),
    policy: { kind: 'export-full', row_slice: 512, concurrency: 1 },
    environment: {
      render_engine: '0.1.0',
      luma_color_runtime: '0.1.1',
      luma_raw_runtime: '0.1.1',
      luma_jpeg_runtime: '0.1.1',
      native_artifacts: { build_id: 'unknown', variant: 'desktop' },
    },
    output: {
      width: 3900,
      height: 2900,
      quality: 92,
      filename: 'final.jpg',
      sha256: 'b'.repeat(64),
    },
    parent_manifest_sha256: null,
    produced_at: '2026-09-05T00:00:00.000Z',
  })
}

type Json = Record<string, any>

/** A JSON copy of a sealed manifest, edited and sealed again. */
function resealed(edit: (manifest: Json) => void): Json {
  const copy = JSON.parse(JSON.stringify(sealed())) as Json
  edit(copy)
  copy.manifest_sha256 = computeManifestSha256(copy)
  return copy
}

/** Like `resealed`, with the color graph fingerprint recomputed first. */
function regraphed(edit: (descriptor: Json) => void): Json {
  return resealed((manifest) => {
    edit(manifest.color_graph.descriptor)
    manifest.color_graph.fingerprint = fingerprintColorGraph(
      manifest.color_graph.descriptor,
    )
  })
}

const neutralBand = { hue: 0, saturation: 0, lightness: 0 }

/** Selective color recorded as all eight bands, `shifts` applied. */
function allBands(shifts: Json = {}): Json {
  return Object.fromEntries(
    HSL_BAND_IDS.map((band) => [band, shifts[band] ?? neutralBand]),
  )
}

function issuePaths(value: unknown): string[] {
  const result = parseRenderManifest(value)
  return result.ok ? [] : result.issues.map((issue) => issue.path)
}

describe('parseRenderManifest', () => {
  it('accepts a sealed manifest and returns the object it was given', () => {
    const manifest = JSON.parse(JSON.stringify(sealed())) as unknown
    const result = parseRenderManifest(manifest)
    expect(result).toEqual({ ok: true, manifest })
    expect(result.ok && result.manifest).toBe(manifest)
  })

  it('accepts a current export without the fields its writer omits', () => {
    // No geometry applied and neutral HSL: both are omitted, and an export
    // records no decode budget.
    const plain = resealed((manifest) => {
      delete manifest.render_params.geometry
      manifest.output.dimensions = { width: 4032, height: 3024 }
    })
    expect(Object.keys(plain.render_params).sort()).toEqual([
      'color_balance',
      'exposure_ev',
      'intensity',
      'raw_render_exposure_ev',
      'raw_render_exposure_source',
      'saturation',
      'tone_curve',
    ])
    expect('max_pixels' in plain.policy).toBe(false)
    expect(parseRenderManifest(plain)).toEqual({ ok: true, manifest: plain })
  })

  it('accepts selective color recorded as all eight bands', () => {
    for (const bands of [
      allBands(),
      allBands({ blue: { hue: 0, saturation: -30, lightness: 5 } }),
    ]) {
      const record = resealed((manifest) => {
        manifest.render_params.selective_color = bands
      })
      expect(parseRenderManifest(record)).toEqual({
        ok: true,
        manifest: record,
      })
    }
  })

  it('accepts an export that applies a LUT', () => {
    const lutGraph = resolveExportColorGraph({
      styleKind: 'custom',
      intensity: 0.37,
      builtinPreset: null,
      lut: toLUTData(generateIdentityLUT(17)),
      ...userColor,
      selectiveColor: NEUTRAL_USER_COLOR_INTENT.selectiveColor,
      rawRenderExposure: {
        ...rawRenderExposure,
        multiplier: 2 ** rawRenderExposure.ev,
      },
    })
    if (!lutGraph.supported) throw new Error(lutGraph.message)
    const written = createRenderManifest({
      ...sealed(),
      lut: {
        kind: 'local-file',
        filename: 'look.cube',
        sha256: 'd'.repeat(64),
        input_contract: lutContract,
        output_contract: lutContract,
      },
      graph: lutGraph,
      render_params: projectManifestRenderParams({
        userColor,
        intensity: 0.37,
        rawRenderExposure,
      }),
      output: {
        width: 4032,
        height: 3024,
        quality: 92,
        filename: 'final.jpg',
        sha256: 'b'.repeat(64),
      },
    })
    const record = JSON.parse(JSON.stringify(written)) as unknown
    expect(parseRenderManifest(record)).toEqual({ ok: true, manifest: record })
  })

  it('accepts calibration and both LUT identity kinds', () => {
    expect(
      parseRenderManifest(
        resealed((manifest) => {
          manifest.calibration = {
            kind: 'catalog',
            catalog_id: 'cat',
            profile_id: 'cam',
            schema_version: '1',
            dcp_params_sha256: 'c'.repeat(64),
            white_neutral: [0.5, 1, 0.7],
            alpha: 0.25,
            converged: true,
          }
          manifest.lut = {
            kind: 'catalog',
            catalog_id: 'cat',
            entry: 'look',
            version: '1',
            sha256: 'd'.repeat(64),
            input_contract: lutContract,
            output_contract: {
              ...lutContract,
              range: 'unknown',
              role: 'display-look',
            },
          }
        }),
      ).ok,
    ).toBe(true)
    expect(
      parseRenderManifest(
        resealed((manifest) => {
          manifest.lut = {
            kind: 'local-file',
            filename: 'look.cube',
            sha256: 'd'.repeat(64),
            input_contract: lutContract,
            output_contract: lutContract,
          }
        }),
      ).ok,
    ).toBe(true)
  })

  it('keeps opaque extension fields that the hash covers', () => {
    const extended = resealed((manifest) => {
      manifest.x_writer = { name: 'future', build: 3 }
      manifest.render_params.x_note = 'kept'
      manifest.environment.native_artifacts.x_target = 'wasm64'
    })
    const result = parseRenderManifest(extended)
    expect(result.ok).toBe(true)
    expect(result.ok && (result.manifest as unknown as Json).x_writer).toEqual({
      name: 'future',
      build: 3,
    })
  })

  it('checks the hash over the whole object, extension fields included', () => {
    const manifest = JSON.parse(JSON.stringify(sealed())) as Json
    manifest.x_writer = 'added after sealing'
    expect(issuePaths(manifest)).toEqual(['manifest_sha256'])
    const nested = JSON.parse(JSON.stringify(sealed())) as Json
    nested.render_params.x_note = 'added after sealing'
    expect(issuePaths(nested)).toEqual(['manifest_sha256'])
  })

  it('refuses a top-level __proto__ field added after sealing', () => {
    const text = JSON.stringify(sealed()).replace(
      /^\{/,
      '{"__proto__":{"render_params":{"exposure_ev":"x"},"x_writer":1},',
    )
    const manifest = JSON.parse(text) as Json
    expect(Object.hasOwn(manifest, '__proto__')).toBe(true)
    expect(issuePaths(manifest)).toEqual(['manifest_sha256'])
  })

  it('keeps a top-level __proto__ field the hash covers', () => {
    const text = JSON.stringify(sealed()).replace(
      /^\{/,
      '{"__proto__":{"x_writer":1},',
    )
    const manifest = JSON.parse(text) as Json
    manifest.manifest_sha256 = computeManifestSha256(manifest)
    const result = parseRenderManifest(JSON.parse(JSON.stringify(manifest)))
    expect(result.ok).toBe(true)
    expect(
      result.ok &&
        Object.getOwnPropertyDescriptor(result.manifest, '__proto__'),
    ).toMatchObject({ value: { x_writer: 1 } })
  })

  it('keeps the hash of an ordinary sealed manifest', () => {
    expect(sealed().manifest_sha256).toBe(
      '10f2a0d4423be4b2699368618c6f3a78e9da5d15be459d206d0432bbebb487dd',
    )
  })

  it('reports a hash mismatch before any structural issue', () => {
    const manifest = JSON.parse(JSON.stringify(sealed())) as Json
    manifest.render_params.exposure_ev = '2'
    expect(issuePaths(manifest)).toEqual([
      'manifest_sha256',
      'render_params.exposure_ev',
    ])
  })

  it('refuses values that cannot be hashed instead of throwing', () => {
    const manifest = JSON.parse(JSON.stringify(sealed())) as Json
    manifest.render_params.exposure_ev = Number.NaN
    expect(issuePaths(manifest)).toEqual([
      'manifest_sha256',
      'render_params.exposure_ev',
    ])
  })

  it.each([
    ['a non-object', 'manifest'],
    ['an array', []],
    ['null', null],
  ])('refuses %s', (_label, value) => {
    expect(issuePaths(value)).toEqual(['manifest'])
  })

  const malformed: [string, (manifest: Json) => void, string[]][] = [
    [
      'a missing top-level section',
      (m) => delete m.environment,
      ['environment'],
    ],
    [
      'an unsupported version',
      (m) => (m.manifest_version = 2),
      ['manifest_version'],
    ],
    [
      'a string version',
      (m) => (m.manifest_version = '1'),
      ['manifest_version'],
    ],
    ['an unknown kind', (m) => (m.kind = 'draft'), ['kind']],
    [
      'an unparseable timestamp',
      (m) => (m.produced_at = 'soon'),
      ['produced_at'],
    ],
    [
      'a malformed parent hash',
      (m) => (m.parent_manifest_sha256 = 'abc'),
      ['parent_manifest_sha256'],
    ],
    [
      'a string source byte size',
      (m) => (m.source_raw.byte_size = '10'),
      ['source_raw.byte_size'],
    ],
    [
      'a non-hex source hash',
      (m) => (m.source_raw.sha256 = 'z'.repeat(64)),
      ['source_raw.sha256'],
    ],
    [
      'a zero decoded width',
      (m) => (m.source_raw.decoded_dimensions.width = 0),
      ['source_raw.decoded_dimensions.width'],
    ],
    [
      'a fractional decoded height',
      (m) => (m.source_raw.decoded_dimensions.height = 3024.5),
      ['source_raw.decoded_dimensions.height'],
    ],
    [
      'a string decoded width',
      (m) => (m.source_raw.decoded_dimensions.width = '4032'),
      ['source_raw.decoded_dimensions.width'],
    ],
    [
      'a calibration without a white neutral',
      (m) =>
        (m.calibration = {
          kind: 'catalog',
          catalog_id: 'cat',
          profile_id: 'cam',
          schema_version: '1',
          dcp_params_sha256: 'c'.repeat(64),
          white_neutral: [1, 1],
          alpha: 0,
          converged: 'yes',
        }),
      ['calibration.white_neutral', 'calibration.converged'],
    ],
    [
      'an unknown LUT kind',
      (m) => (m.lut = { kind: 'remote', sha256: 'd'.repeat(64) }),
      ['lut.kind'],
    ],
    [
      'a LUT without contracts',
      (m) =>
        (m.lut = {
          kind: 'local-file',
          filename: 'look.cube',
          sha256: 'd'.repeat(64),
          input_contract: { ...lutContract, range: 'video' },
        }),
      ['lut.input_contract.range', 'lut.output_contract'],
    ],
    [
      'a string color graph descriptor',
      (m) => (m.color_graph.descriptor = 'v2'),
      ['color_graph.descriptor'],
    ],
    [
      'a string descriptor version',
      (m) => (m.color_graph.descriptor.descriptor_version = '2'),
      ['color_graph.descriptor.descriptor_version'],
    ],
    [
      'a descriptor its fingerprint does not cover',
      (m) => (m.color_graph.descriptor.steps[1].ev = 4),
      ['color_graph.fingerprint'],
    ],
    [
      'a missing exposure',
      (m) => delete m.render_params.exposure_ev,
      ['render_params.exposure_ev'],
    ],
    [
      'a string exposure',
      (m) => (m.render_params.exposure_ev = '0.5'),
      ['render_params.exposure_ev'],
    ],
    [
      'a malformed tone section',
      (m) => (m.render_params.tone_curve = 'flat'),
      ['render_params.tone_curve'],
    ],
    [
      'a string tone field',
      (m) => (m.render_params.tone_curve.contrast = '10'),
      ['render_params.tone_curve.contrast'],
    ],
    [
      'a null color balance field',
      (m) => (m.render_params.color_balance.temperature = null),
      ['render_params.color_balance.temperature'],
    ],
    [
      'a string saturation field',
      (m) => (m.render_params.saturation.vibrance = '5'),
      ['render_params.saturation.vibrance'],
    ],
    [
      'an incomplete HSL band',
      (m) => (m.render_params.selective_color = allBands({ red: { hue: 10 } })),
      [
        'render_params.selective_color.red.saturation',
        'render_params.selective_color.red.lightness',
      ],
    ],
    [
      'a string intensity',
      (m) => (m.render_params.intensity = '0.37'),
      ['render_params.intensity'],
    ],
    [
      'a string raw-render exposure',
      (m) => (m.render_params.raw_render_exposure_ev = '0.2'),
      ['render_params.raw_render_exposure_ev'],
    ],
    [
      'an unknown raw-render exposure source',
      (m) => (m.render_params.raw_render_exposure_source = 'guess'),
      ['render_params.raw_render_exposure_source'],
    ],
    [
      'a short geometry matrix',
      (m) => (m.render_params.geometry.matrix = [1, 0, 0, 0, 1, 0, 0, 0]),
      ['render_params.geometry.matrix'],
    ],
    [
      'a string geometry matrix entry',
      (m) => (m.render_params.geometry.matrix[0] = '0.99'),
      ['render_params.geometry.matrix'],
    ],
    [
      'a singular geometry matrix',
      (m) => (m.render_params.geometry.matrix = [1, 2, 0, 2, 4, 0, 0, 0, 1]),
      ['render_params.geometry.matrix'],
    ],
    [
      'a string crop flag',
      (m) => (m.render_params.geometry.constrain_crop = 'true'),
      ['render_params.geometry.constrain_crop'],
    ],
    [
      'a zero geometry output',
      (m) => (m.render_params.geometry.output = { width: 0, height: 2900 }),
      ['render_params.geometry.output.width'],
    ],
    [
      'an unknown policy kind',
      (m) => (m.policy.kind = 'fast'),
      ['policy.kind'],
    ],
    [
      'a string row slice',
      (m) => (m.policy.row_slice = '512'),
      ['policy.row_slice'],
    ],
    [
      'a zero concurrency',
      (m) => (m.policy.concurrency = 0),
      ['policy.concurrency'],
    ],
    [
      'a fractional decode budget',
      (m) => (m.policy.max_pixels = 1.5),
      ['policy.max_pixels'],
    ],
    [
      'a missing runtime version',
      (m) => delete m.environment.luma_raw_runtime,
      ['environment.luma_raw_runtime'],
    ],
    [
      'missing native artifacts',
      (m) => delete m.environment.native_artifacts,
      ['environment.native_artifacts'],
    ],
    [
      'an unknown native variant',
      (m) => (m.environment.native_artifacts.variant = 'tiny'),
      ['environment.native_artifacts.variant'],
    ],
    ['a PNG output', (m) => (m.output.format = 'png'), ['output.format']],
    [
      'a non-sRGB output',
      (m) => (m.output.color_space = 'display-p3'),
      ['output.color_space'],
    ],
    [
      'a negative output height',
      (m) => (m.output.dimensions.height = -1),
      ['output.dimensions.height'],
    ],
    [
      'a unit-scale output quality',
      (m) => (m.output.quality = 0.92),
      ['output.quality'],
    ],
    ['a missing output hash', (m) => delete m.output.sha256, ['output.sha256']],
  ]

  it.each(malformed)(
    'refuses a resealed manifest with %s',
    (_label, edit, paths) => {
      expect(issuePaths(resealed(edit))).toEqual(paths)
    },
  )
})

// Shapes the current writers never seal: they always record a current
// descriptor, every color section in full, selective color as all eight bands
// or not at all, the look strength and the RAW exposure with its source. A
// record an earlier writer sealed in one of these shapes keeps a valid seal,
// so the reader refuses it for its structure, never completing or
// normalizing it.
describe('sealed records of retired shapes', () => {
  const executable = [
    'render_params.tone_curve',
    'render_params.color_balance',
    'render_params.saturation',
    'render_params.intensity',
    'render_params.raw_render_exposure_ev',
    'render_params.raw_render_exposure_source',
  ]
  const retired: [string, (manifest: Json) => void, string[]][] = [
    [
      'a descriptor without a version',
      (m) => delete m.color_graph.descriptor.descriptor_version,
      ['color_graph.descriptor.descriptor_version'],
    ],
    [
      'an older descriptor version',
      (m) => {
        m.color_graph.descriptor = { descriptor_version: 1 }
        m.color_graph.fingerprint = 'f'.repeat(64)
      },
      ['color_graph.descriptor.descriptor_version'],
    ],
    [
      'no look strength',
      (m) => delete m.render_params.intensity,
      ['render_params.intensity'],
    ],
    [
      'no RAW exposure',
      (m) => {
        delete m.render_params.raw_render_exposure_ev
        delete m.render_params.raw_render_exposure_source
      },
      [
        'render_params.raw_render_exposure_ev',
        'render_params.raw_render_exposure_source',
      ],
    ],
    [
      'a RAW exposure without its source',
      (m) => delete m.render_params.raw_render_exposure_source,
      ['render_params.raw_render_exposure_source'],
    ],
    [
      'no tone section',
      (m) => delete m.render_params.tone_curve,
      ['render_params.tone_curve'],
    ],
    [
      'no color balance section',
      (m) => delete m.render_params.color_balance,
      ['render_params.color_balance'],
    ],
    [
      'no saturation section',
      (m) => delete m.render_params.saturation,
      ['render_params.saturation'],
    ],
    [
      'a partial tone section',
      (m) => (m.render_params.tone_curve = { contrast: 10 }),
      [
        'render_params.tone_curve.highlights',
        'render_params.tone_curve.shadows',
        'render_params.tone_curve.whites',
        'render_params.tone_curve.blacks',
      ],
    ],
    [
      'a Kelvin color balance',
      (m) => (m.render_params.color_balance = { temp_k: 5600, tint: -2 }),
      [
        'render_params.color_balance.temperature',
        'render_params.color_balance.temp_k',
      ],
    ],
    [
      'a Kelvin temperature next to the slider',
      (m) => (m.render_params.color_balance.temp_k = 5600),
      ['render_params.color_balance.temp_k'],
    ],
    [
      'only an exposure',
      (m) => (m.render_params = { exposure_ev: 0 }),
      executable,
    ],
    [
      'two explicit neutral HSL bands',
      (m) =>
        (m.render_params.selective_color = {
          red: neutralBand,
          magenta: neutralBand,
        }),
      HSL_BAND_IDS.filter((band) => band !== 'red' && band !== 'magenta').map(
        (band) => `render_params.selective_color.${band}`,
      ),
    ],
    [
      'one shifted HSL band',
      (m) =>
        (m.render_params.selective_color = {
          aqua: { hue: 0, saturation: 15, lightness: 0 },
        }),
      HSL_BAND_IDS.filter((band) => band !== 'aqua').map(
        (band) => `render_params.selective_color.${band}`,
      ),
    ],
  ]

  it.each(retired)('refuses a sealed record with %s', (_label, edit, paths) => {
    const record = resealed(edit)
    expect(issuePaths(record)).toEqual(paths)
  })

  it('refuses a record completed after its original seal for its hash first', () => {
    const record = resealed((m) => delete m.render_params.intensity)
    record.render_params.intensity = 1
    expect(issuePaths(record)).toEqual(['manifest_sha256'])
  })
})

describe('sealed records of the current version with a malformed graph', () => {
  const malformed: [string, (descriptor: Json) => void, string[]][] = [
    [
      'a later descriptor version',
      (d) => (d.descriptor_version = 3),
      ['color_graph.descriptor.descriptor_version'],
    ],
    [
      'a step missing a field',
      (d) => delete d.steps[1].multiplier,
      ['color_graph.descriptor.steps.1.multiplier'],
    ],
    [
      'a dropped step',
      (d) => d.steps.splice(7, 1),
      ['color_graph.descriptor.steps'],
    ],
    [
      'an extra descriptor field',
      (d) => (d.x_note = 'kept'),
      ['color_graph.descriptor.x_note'],
    ],
  ]

  it.each(malformed)(
    'refuses a record whose fingerprint covers %s',
    (_label, edit, paths) => {
      expect(issuePaths(regraphed(edit))).toEqual(paths)
    },
  )
})

describe('reading render params from an untrusted manifest', () => {
  type Read =
    | { ok: true; intent: ManifestRenderParamsIntent }
    | { ok: false; paths: string[] }

  // The only route from untrusted JSON to replayable params: the whole
  // manifest passes the canonical parser before its params are inverted.
  function readParams(value: unknown): Read {
    const parsed = parseRenderManifest(value)
    return parsed.ok
      ? {
          ok: true,
          intent: invertManifestRenderParams(parsed.manifest.render_params),
        }
      : { ok: false, paths: parsed.issues.map((issue) => issue.path) }
  }

  it('reads the params of a valid current manifest', () => {
    const read = readParams(JSON.parse(JSON.stringify(sealed())))
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.intent.userColor.userExposureEv).toBe(0.5)
    expect(read.intent.userColor.userContrast).toBe(10)
    expect(read.intent.intensity).toBe(1)
    expect(read.intent.rawRenderExposure).toEqual({
      ev: 0.2,
      source: 'dng-baseline',
    })
    expect(read.intent.geometry).toEqual(sealed().render_params.geometry)
  })

  it('reads omitted HSL and an explicit all-neutral record alike', () => {
    const current = JSON.parse(JSON.stringify(sealed())) as Json
    const explicit = resealed((manifest) => {
      manifest.render_params.selective_color = allBands()
    })
    const hash = explicit.manifest_sha256
    const read = readParams(current)
    expect('selective_color' in current.render_params).toBe(false)
    expect(read.ok && read.intent.userColor.selectiveColor).toEqual(
      NEUTRAL_USER_COLOR_INTENT.selectiveColor,
    )
    expect(readParams(explicit)).toEqual(read)
    expect(explicit.manifest_sha256).toBe(hash)
  })

  it('refuses sealed malformed params', () => {
    expect(
      readParams(
        resealed((manifest) => {
          manifest.render_params.exposure_ev = 'x'
          manifest.render_params.selective_color = allBands({
            red: { hue: 10 },
          })
        }),
      ),
    ).toEqual({
      ok: false,
      paths: [
        'render_params.exposure_ev',
        'render_params.selective_color.red.saturation',
        'render_params.selective_color.red.lightness',
      ],
    })
  })

  it('refuses well-formed params in a sealed manifest with a malformed section', () => {
    expect(
      readParams(
        resealed((manifest) => {
          manifest.policy.row_slice = '512'
          manifest.output.quality = 0.92
        }),
      ),
    ).toEqual({ ok: false, paths: ['policy.row_slice', 'output.quality'] })
  })

  it('refuses params edited after sealing', () => {
    const manifest = JSON.parse(JSON.stringify(sealed())) as Json
    manifest.render_params.exposure_ev = 1
    expect(readParams(manifest)).toEqual({
      ok: false,
      paths: ['manifest_sha256'],
    })
    expect(readParams(null)).toEqual({ ok: false, paths: ['manifest'] })
  })
})
