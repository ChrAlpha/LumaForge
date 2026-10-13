import { describe, expect, it } from 'vitest'

import type { ExportColorGraphInput, ExportColorGraphStep } from './color-graph'
import { resolveExportColorGraph } from './color-graph'
import { generateIdentityLUT, toLUTData } from './cube-parser'
import type { LUTColorProfile } from './registry'
import { getLUTColorProfile } from './registry'
import type { HSLBandId, HSLBandShift } from './selective-color'
import {
  CHROMA_CLAMP_HIGH,
  CHROMA_CLAMP_LOW,
  HSL_BAND_IDS,
  LUT_CONSTANTS_VERSION,
  LUT_SIZE,
  NEUTRAL_SELECTIVE_COLOR,
  resolveSelectiveColorParams,
} from './selective-color'
import type { LUTContractResolution, LUTData } from './types'
import type { ColorGraphIntent } from './user-color-intent'
import {
  BUILTIN_STYLE_PRESETS,
  NEUTRAL_USER_COLOR_INTENT,
  normalizeColorGraphIntent,
} from './user-color-intent'

/** The complete intent of an untouched photo with no look. */
const NO_LOOK: ColorGraphIntent = {
  styleKind: 'none',
  builtinPreset: null,
  intensity: 0.7,
  ...NEUTRAL_USER_COLOR_INTENT,
}

/** Graph input from the complete no-look intent and the given changes. */
function graphInput(
  overrides: Partial<ExportColorGraphInput> = {},
): ExportColorGraphInput {
  return { ...NO_LOOK, lut: null, ...overrides }
}

function registryProfile(id: string): LUTColorProfile {
  const profile = getLUTColorProfile(id)
  if (!profile) throw new Error(`Missing registry profile ${id}`)
  return profile
}

/** A 2-point identity LUT whose contract is `profileResolution`. */
function lutWith(profileResolution: LUTContractResolution): LUTData {
  return { ...toLUTData(generateIdentityLUT(2)), profileResolution }
}

function confirmed(profile: LUTColorProfile): LUTContractResolution {
  return { kind: 'confirmed', confidence: 'user', profile }
}

function hslBands(
  overrides: Partial<Record<HSLBandId, HSLBandShift>> = {},
): Record<HSLBandId, HSLBandShift> {
  return Object.fromEntries(
    HSL_BAND_IDS.map((id) => [
      id,
      overrides[id] ?? { hue: 0, saturation: 0, lightness: 0 },
    ]),
  ) as Record<HSLBandId, HSLBandShift>
}

describe('resolveExportColorGraph with a complete intent', () => {
  const edited: ColorGraphIntent = {
    styleKind: 'custom',
    builtinPreset: null,
    intensity: 0.37,
    userExposureEv: 1,
    userContrast: 50,
    userHighlights: -40,
    userShadows: 35,
    userWhites: -25,
    userBlacks: 20,
    userTemperature: 40,
    userTint: -25,
    userSaturation: 42,
    userVibrance: -17,
    selectiveColor: hslBands({
      red: { hue: 50, saturation: -20, lightness: 10 },
      aqua: { hue: -30, saturation: 15, lightness: -5 },
    }),
  }
  const sceneLook = lutWith(
    confirmed({
      ...registryProfile('sony-sgamut3cine-slog3'),
      outputGamut: 's-gamut3-cine',
      outputTransfer: 's-log3',
      outputRange: 'full',
    }),
  )

  it('carries every user field and the look strength into its step as given', () => {
    const graph = resolveExportColorGraph({ ...edited, lut: sceneLook })

    expect(graph).toMatchObject({
      supported: true,
      outputGamut: 'srgb-rec709',
      outputTransfer: 'srgb',
      steps: [
        { kind: 'input-linear-prophoto' },
        { kind: 'raw-render-exposure', ev: 0, multiplier: 1 },
        { kind: 'user-color-balance', temperature: 40, tint: -25 },
        { kind: 'user-exposure', ev: 1, multiplier: 2 },
        { kind: 'user-contrast', amount: 50, factor: 2 ** 0.25, pivot: 0.18 },
        {
          kind: 'user-regional-tone',
          highlights: -40,
          shadows: 35,
          whites: -25,
          blacks: 20,
        },
        { kind: 'user-saturation', saturation: 42, vibrance: -17 },
        {
          kind: 'user-selective-color',
          bands: hslBands({
            red: { hue: 50, saturation: -20, lightness: 10 },
            aqua: { hue: -30, saturation: 15, lightness: -5 },
          }),
        },
        { kind: 'gamut-to-lut-input', gamut: 's-gamut3-cine' },
        { kind: 'encode-lut-transfer', transfer: 's-log3', range: 'full' },
        { kind: 'lut3d', size: 2 },
        {
          kind: 'lut-output-to-srgb',
          transfer: 's-log3',
          range: 'full',
          role: 'scene-creative',
          intensity: 0.37,
        },
        { kind: 'output-srgb' },
      ],
    })
  })

  it('reads neutral HSL as all-zero bands, however it is spelled', () => {
    const graphs = [
      resolveExportColorGraph(graphInput()),
      resolveExportColorGraph(
        graphInput({ selectiveColor: NEUTRAL_SELECTIVE_COLOR }),
      ),
      resolveExportColorGraph(graphInput({ selectiveColor: hslBands() })),
    ]

    for (const graph of graphs) {
      expect(graph).toEqual(graphs[0])
      expect(graph.steps).toContainEqual(
        expect.objectContaining({
          kind: 'user-selective-color',
          bands: hslBands(),
        }),
      )
    }
  })

  it('takes HSL only as complete bands, normalized before it arrives', () => {
    const { selectiveColor: _omitted, ...withoutHsl } = NO_LOOK
    // @ts-expect-error the graph input requires selectiveColor
    const partial: ExportColorGraphInput = { ...withoutHsl, lut: null }
    const normalized = normalizeColorGraphIntent(withoutHsl, {
      defaultIntensity: 0.7,
    })

    expect(partial).not.toHaveProperty('selectiveColor')
    expect(resolveExportColorGraph({ ...normalized, lut: null })).toEqual(
      resolveExportColorGraph(graphInput()),
    )
  })

  it('routes the same LUT bytes by their contract resolution', () => {
    const vlogLook = confirmed({
      ...registryProfile('panasonic-vgamut-vlog'),
      role: 'combined-look-output',
      outputGamut: 'srgb-rec709',
      outputTransfer: 'bt709',
      outputRange: 'full',
    })
    expect(
      resolveExportColorGraph({ ...edited, lut: lutWith(vlogLook) }),
    ).toMatchObject({
      supported: true,
      steps: expect.arrayContaining([
        expect.objectContaining({
          kind: 'gamut-to-lut-input',
          gamut: 'v-gamut',
        }),
        expect.objectContaining({
          kind: 'encode-lut-transfer',
          transfer: 'v-log',
          range: 'full',
        }),
        expect.objectContaining({
          kind: 'lut-output-to-srgb',
          transfer: 'bt709',
          role: 'combined-look-output',
          intensity: 0.37,
        }),
      ]),
    })
    for (const unresolved of [
      { kind: 'unknown' },
      {
        kind: 'recommended',
        recommendations: [registryProfile('panasonic-vgamut-vlog')],
      },
      {
        kind: 'unsupported-output',
        recommendations: [registryProfile('sony-sgamut3cine-slog3')],
      },
    ] satisfies LUTContractResolution[]) {
      expect(
        resolveExportColorGraph({ ...edited, lut: lutWith(unresolved) }),
      ).toEqual({
        supported: false,
        reason: 'unsupported-pipeline',
        message: 'Choose a LUT input profile before full-resolution export.',
        steps: [],
      })
    }
  })

  it('keeps every retained built-in preset a refused export look', () => {
    for (const builtinPreset of BUILTIN_STYLE_PRESETS) {
      for (const lut of [null, sceneLook]) {
        expect(
          resolveExportColorGraph({
            ...edited,
            styleKind: 'builtin',
            builtinPreset,
            lut,
          }),
        ).toEqual({
          supported: false,
          reason: 'unsupported-pipeline',
          message:
            'Built-in styles are not supported by full-resolution JPEG export.',
          steps: [],
        })
      }
    }
  })
})

describe('resolveExportColorGraph', () => {
  it('resolves no-lut export to linear ProPhoto then sRGB output', () => {
    const graph = resolveExportColorGraph(graphInput())

    expect(graph.supported).toBe(true)
    if (!graph.supported) {
      throw new Error('Expected supported graph')
    }
    expect(graph.outputGamut).toBe('srgb-rec709')
    expect(graph.outputTransfer).toBe('srgb')
    expect(graph.steps.map((step) => step.kind)).toEqual([
      'input-linear-prophoto',
      'raw-render-exposure',
      'user-color-balance',
      'user-exposure',
      'user-contrast',
      'user-regional-tone',
      'user-saturation',
      'user-selective-color',
      'output-srgb',
    ])
    expect(graph.steps[1]).toMatchObject({
      kind: 'raw-render-exposure',
      ev: 0,
      multiplier: 1,
    })
  })

  it('reads partial input once normalization has completed it', () => {
    const noLook = normalizeColorGraphIntent(
      { styleKind: 'none' },
      { defaultIntensity: 0.7 },
    )
    const warmRed = normalizeColorGraphIntent(
      {
        styleKind: 'none',
        userTemperature: 40,
        selectiveColor: { red: { hue: 50 } },
      },
      { defaultIntensity: 0.7 },
    )

    expect({ ...noLook, lut: null }).toEqual(graphInput())
    expect({ ...warmRed, lut: null }).toEqual(
      graphInput({
        userTemperature: 40,
        selectiveColor: hslBands({
          red: { hue: 50, saturation: 0, lightness: 0 },
        }),
      }),
    )
    expect(resolveExportColorGraph({ ...warmRed, lut: null })).toMatchObject({
      supported: true,
      steps: [
        { kind: 'input-linear-prophoto' },
        { kind: 'raw-render-exposure', ev: 0, multiplier: 1 },
        { kind: 'user-color-balance', temperature: 40, tint: 0 },
        { kind: 'user-exposure', ev: 0, multiplier: 1 },
        { kind: 'user-contrast', amount: 0, factor: 1 },
        {
          kind: 'user-regional-tone',
          highlights: 0,
          shadows: 0,
          whites: 0,
          blacks: 0,
        },
        { kind: 'user-saturation', saturation: 0, vibrance: 0 },
        {
          kind: 'user-selective-color',
          bands: hslBands({ red: { hue: 50, saturation: 0, lightness: 0 } }),
        },
        { kind: 'output-srgb' },
      ],
    })
  })

  it('carries the RAW render exposure into its step', () => {
    const graph = resolveExportColorGraph(
      graphInput({
        rawRenderExposure: { ev: 1, multiplier: 2, source: 'image-statistics' },
      }),
    )

    expect(graph.steps[1]).toEqual({
      kind: 'raw-render-exposure',
      ev: 1,
      multiplier: 2,
    })
  })

  it('names the operator of each neutral scene step', () => {
    const graph = resolveExportColorGraph(graphInput())

    expect(graph.supported).toBe(true)
    if (!graph.supported) throw new Error('Expected supported graph')
    expect(graph.steps[2]).toMatchObject({
      kind: 'user-color-balance',
      temperature: 0,
      tint: 0,
      gain: [1, 1, 1],
      operator: 'linear-prophoto-relative-rgb-gain',
      luminanceCoefficients: [0.2880402, 0.7118741, 0.0000857],
    })
    expect(graph.steps[3]).toMatchObject({
      kind: 'user-exposure',
      ev: 0,
      multiplier: 1,
    })
    expect(graph.steps[4]).toMatchObject({
      kind: 'user-contrast',
      amount: 0,
      factor: 1,
      pivot: 0.18,
      operator: 'linear-prophoto-luminance-scale',
      luminanceCoefficients: [0.2880402, 0.7118741, 0.0000857],
      zeroLuminanceMode: 'return-black',
    })
    expect(graph.steps[5]).toMatchObject({
      kind: 'user-regional-tone',
      highlights: 0,
      shadows: 0,
      whites: 0,
      blacks: 0,
      operator: 'linear-prophoto-log-luminance-regions',
      luminanceCoefficients: [0.2880402, 0.7118741, 0.0000857],
      zeroLuminanceMode: 'return-black',
    })
    expect(graph.steps[6]).toMatchObject({
      kind: 'user-saturation',
      saturation: 0,
      vibrance: 0,
      operator: 'oklab-chroma-with-skin-protection',
    })
  })

  it('resolves scene creative LUTs with explicit input and output contracts', () => {
    const graph = resolveExportColorGraph(
      graphInput({
        styleKind: 'custom',
        lut: lutWith(
          confirmed({
            ...registryProfile('sony-sgamut3cine-slog3'),
            outputGamut: 's-gamut3-cine',
            outputTransfer: 's-log3',
            outputRange: 'full',
          }),
        ),
      }),
    )

    expect(graph.supported).toBe(true)
    if (!graph.supported) {
      throw new Error('Expected supported graph')
    }
    expect(graph.outputGamut).toBe('srgb-rec709')
    expect(graph.outputTransfer).toBe('srgb')
    expect(graph.steps.map((step) => step.kind)).toEqual([
      'input-linear-prophoto',
      'raw-render-exposure',
      'user-color-balance',
      'user-exposure',
      'user-contrast',
      'user-regional-tone',
      'user-saturation',
      'user-selective-color',
      'gamut-to-lut-input',
      'encode-lut-transfer',
      'lut3d',
      'lut-output-to-srgb',
      'output-srgb',
    ])
    expect(graph.steps[10]).toMatchObject({
      kind: 'lut3d',
      domainMin: [0, 0, 0],
      domainMax: [1, 1, 1],
    })
    expect(graph.steps[11]).toMatchObject({
      kind: 'lut-output-to-srgb',
      transfer: 's-log3',
      range: 'full',
      role: 'scene-creative',
      intensity: 0.7,
    })
  })

  it('routes V-Log input and BT.709 Rec.709 output as a combined output LUT', () => {
    const graph = resolveExportColorGraph(
      graphInput({
        styleKind: 'custom',
        intensity: 1,
        lut: lutWith({
          kind: 'confirmed',
          confidence: 'metadata',
          profile: {
            ...registryProfile('panasonic-vgamut-vlog'),
            role: 'combined-look-output',
            outputGamut: 'srgb-rec709',
            outputTransfer: 'bt709',
            outputRange: 'full',
          },
        }),
      }),
    )

    expect(graph.supported).toBe(true)
    if (!graph.supported) throw new Error('Expected supported graph')
    expect(graph.steps).toContainEqual(
      expect.objectContaining({
        kind: 'lut-output-to-srgb',
        transfer: 'bt709',
        range: 'full',
        role: 'combined-look-output',
      }),
    )
  })

  it('resolves omitted display-look output transfer from the LUT input transfer', () => {
    const profile = registryProfile('rec709-gamma24')
    expect(profile.role).toBe('display-look')
    expect(profile.inputTransfer).toBe('gamma24')
    expect(profile.outputTransfer).toBeUndefined()

    const graph = resolveExportColorGraph(
      graphInput({
        styleKind: 'custom',
        intensity: 1,
        lut: lutWith(confirmed(profile)),
      }),
    )

    expect(graph.supported).toBe(true)
    if (!graph.supported) {
      throw new Error('Expected supported graph')
    }
    expect(graph.steps[11]).toMatchObject({
      kind: 'lut-output-to-srgb',
      transfer: 'gamma24',
      range: 'full',
      role: 'display-look',
      intensity: 1,
    })
  })

  it('fails closed for unresolved LUT profiles', () => {
    const graph = resolveExportColorGraph(
      graphInput({ styleKind: 'custom', lut: lutWith({ kind: 'unknown' }) }),
    )

    expect(graph.supported).toBe(false)
    if (graph.supported) {
      throw new Error('Expected unsupported graph')
    }
    expect(graph.reason).toBe('unsupported-pipeline')
    expect(graph.message).toBe(
      'Choose a LUT input profile before full-resolution export.',
    )
    expect(graph.steps).toEqual([])
  })

  it('fails closed when a non-display LUT has no declared output contract', () => {
    const graph = resolveExportColorGraph(
      graphInput({
        styleKind: 'custom',
        intensity: 1,
        lut: lutWith(confirmed(registryProfile('panasonic-vgamut-vlog'))),
      }),
    )

    expect(graph).toMatchObject({
      supported: false,
      reason: 'unsupported-pipeline',
      message: 'Choose a LUT output profile before full-resolution export.',
    })
  })

  it('fails closed for resolved technical output LUTs with explicit linear output transfer', () => {
    const graph = resolveExportColorGraph(
      graphInput({
        styleKind: 'custom',
        lut: lutWith({
          kind: 'confirmed',
          confidence: 'metadata',
          profile: {
            ...registryProfile('panasonic-vgamut-vlog'),
            role: 'technical-output',
            outputGamut: 'v-gamut',
            outputTransfer: 'linear',
            outputRange: 'full',
          },
        }),
      }),
    )

    expect(graph.supported).toBe(false)
    if (graph.supported) {
      throw new Error('Expected unsupported graph')
    }
    expect(graph.reason).toBe('unsupported-pipeline')
    expect(graph.message).toBe(
      'This LUT output transfer is not supported by full-resolution JPEG export.',
    )
  })

  it('fails closed for resolved technical output LUTs with unknown output range', () => {
    const graph = resolveExportColorGraph(
      graphInput({
        styleKind: 'custom',
        lut: lutWith({
          kind: 'confirmed',
          confidence: 'metadata',
          profile: {
            ...registryProfile('panasonic-vgamut-vlog'),
            role: 'technical-output',
            outputGamut: 'v-gamut',
            outputTransfer: 'v-log',
            outputRange: 'unknown',
          },
        }),
      }),
    )

    expect(graph.supported).toBe(false)
    if (graph.supported) {
      throw new Error('Expected unsupported graph')
    }
    expect(graph.reason).toBe('unsupported-pipeline')
    expect(graph.message).toBe(
      'This LUT output range must be explicit before full-resolution JPEG export.',
    )
  })

  it('fails closed for combined output LUTs with incomplete output contracts', () => {
    const graph = resolveExportColorGraph(
      graphInput({
        styleKind: 'custom',
        lut: lutWith({
          kind: 'confirmed',
          confidence: 'metadata',
          profile: {
            ...registryProfile('sony-sgamut3cine-slog3'),
            role: 'combined-look-output',
            outputGamut: undefined,
            outputTransfer: undefined,
          },
        }),
      }),
    )

    expect(graph.supported).toBe(false)
    if (graph.supported) {
      throw new Error('Expected unsupported graph')
    }
    expect(graph.reason).toBe('unsupported-pipeline')
    expect(graph.message).toBe(
      'Choose a LUT output profile before full-resolution export.',
    )
  })

  describe('user-selective-color graph step', () => {
    it('graph_step_no_buffer: graph step carries durable params only, never a Float32Array', () => {
      const graph = resolveExportColorGraph(
        graphInput({
          selectiveColor: hslBands({
            red: { hue: 50, saturation: 0, lightness: 0 },
          }),
        }),
      )

      expect(graph.supported).toBe(true)
      if (!graph.supported) throw new Error('Expected supported graph')
      const step = graph.steps.find((s) => s.kind === 'user-selective-color')
      expect(step).toBeDefined()
      if (!step) throw new Error('Expected selective-color step')

      // Walk every property; no value may be a Float32Array (or any TypedArray
      // smelling like a LUT buffer). The step is durable params + constants.
      for (const value of Object.values(step)) {
        expect(value instanceof Float32Array).toBe(false)
        expect(value instanceof Uint8Array).toBe(false)
        if (
          value !== null &&
          typeof value === 'object' &&
          'length' in (value as object)
        ) {
          expect((value as ArrayLike<unknown>).length).not.toBe(1024)
        }
      }

      // TypeScript-level regression catch: the step type must not declare a
      // Float32Array `buffer` property. The @ts-expect-error fails to compile
      // if a future change adds one.
      type StepKind = Extract<
        ExportColorGraphStep,
        { kind: 'user-selective-color' }
      >
      const _typeCheck = (s: StepKind): unknown =>
        // @ts-expect-error: step must not carry a Float32Array buffer
        s.buffer satisfies Float32Array
      void _typeCheck
    })

    it('lut_ownership: graph step is decoupled from any baked LUT buffer', () => {
      const input = graphInput({
        selectiveColor: hslBands({
          red: { hue: 50, saturation: 0, lightness: 0 },
        }),
      })

      const graph = resolveExportColorGraph(input)
      expect(graph.supported).toBe(true)
      if (!graph.supported) throw new Error('Expected supported graph')
      const graphStep = graph.steps.find(
        (s) => s.kind === 'user-selective-color',
      )
      expect(graphStep).toBeDefined()
      if (!graphStep) throw new Error('Expected selective-color step')

      // Pool buffer simulates caller-owned T4 ownership model.
      const poolBuffer = new Float32Array(4 * LUT_SIZE)
      const { step: bakeStep, prepared } = resolveSelectiveColorParams(
        { selectiveColor: input.selectiveColor },
        poolBuffer,
      )
      expect(prepared.buffer).toBe(poolBuffer)

      // Snapshot before mutation.
      const before = JSON.stringify(graphStep)
      // Mutate the caller-owned pool buffer in place.
      poolBuffer.fill(999)
      // Captured graph step is untouched (no buffer reference).
      const after = JSON.stringify(graphStep)
      expect(after).toBe(before)

      // Structural equality of bands between graph step and bake step.
      expect(graphStep).toMatchObject({
        kind: 'user-selective-color',
        chromaClampLow: CHROMA_CLAMP_LOW,
        chromaClampHigh: CHROMA_CLAMP_HIGH,
        workingSpace: 'oklab-via-prophoto-d65',
        operator: 'oklch-per-band-shift',
        constantsVersion: LUT_CONSTANTS_VERSION,
      })
      if (graphStep.kind !== 'user-selective-color') {
        throw new Error('Type narrow guard')
      }
      expect(graphStep.bands).toEqual(bakeStep.bands)
    })
  })
})
