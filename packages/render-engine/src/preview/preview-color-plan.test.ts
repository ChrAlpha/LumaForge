import type {
  ColorGraphIntent,
  ExportColorGraphInput,
  LUTColorProfile,
  LUTContractResolution,
  LUTData,
  RawRenderExposure,
  SupportedExportColorGraphDescriptor,
} from '@lumaforge/luma-color-runtime'
import {
  generateIdentityLUT,
  NEUTRAL_USER_COLOR_INTENT,
  pickLookSelection,
  resolveExportColorGraph,
  toLUTData,
} from '@lumaforge/luma-color-runtime'
import { describe, expect, it } from 'vitest'

import type {
  PreviewColorExecutor,
  PreviewColorPlan,
  PreviewColorPlanReason,
} from './preview-color-plan'
import {
  PREVIEW_COLOR_PLAN_REASONS,
  resolvePreviewColorPlan,
} from './preview-color-plan'

const EXECUTORS: readonly PreviewColorExecutor[] = ['webgpu', 'cpu']
const INTENSITIES = [0, 0.37, 1] as const

const RAW_RENDER_EXPOSURE: RawRenderExposure = {
  ev: 0.6,
  multiplier: 2 ** 0.6,
  source: 'image-statistics',
}

/** Non-neutral user color, so a stripped graph that drops it shows. */
const ADJUSTED: ColorGraphIntent = {
  styleKind: 'custom',
  builtinPreset: null,
  intensity: 0.7,
  ...NEUTRAL_USER_COLOR_INTENT,
  userExposureEv: 0.8,
  userContrast: 25,
  userHighlights: -30,
  userShadows: 20,
  userTemperature: 15,
  userTint: -10,
  userSaturation: 12,
  userVibrance: 18,
  selectiveColor: {
    ...NEUTRAL_USER_COLOR_INTENT.selectiveColor,
    orange: { hue: 10, saturation: -20, lightness: 5 },
  },
}

const NO_LOOK = { styleKind: 'none', builtinPreset: null, intensity: 0 }

function profile(overrides: Partial<LUTColorProfile> = {}): LUTColorProfile {
  return {
    id: 'test-profile',
    label: 'Test profile',
    role: 'scene-creative',
    inputGamut: 'v-gamut',
    inputTransfer: 'v-log',
    inputRange: 'full',
    outputGamut: 'srgb-rec709',
    outputTransfer: 'srgb',
    outputRange: 'full',
    aliases: [],
    ...overrides,
  }
}

function confirmed(p: LUTColorProfile): LUTContractResolution {
  return { kind: 'confirmed', profile: p, confidence: 'user' }
}

/** A 2-point identity LUT whose contract is `profileResolution`. */
function lut(profileResolution: LUTContractResolution): LUTData {
  return { ...toLUTData(generateIdentityLUT(2)), profileResolution }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !ArrayBuffer.isView(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

function supported(
  input: ExportColorGraphInput,
): SupportedExportColorGraphDescriptor {
  const graph = resolveExportColorGraph(input)
  if (!graph.supported) throw new Error(`expected supported: ${graph.message}`)
  return graph
}

/** The graph export would run with the look removed and user color kept. */
function strippedGraph(intent: ColorGraphIntent = ADJUSTED) {
  return supported({
    ...intent,
    ...NO_LOOK,
    lut: null,
    rawRenderExposure: RAW_RENDER_EXPOSURE,
  } as ExportColorGraphInput)
}

function stepKinds(graph: SupportedExportColorGraphDescriptor | null) {
  return graph?.steps.map((step) => step.kind) ?? null
}

function plan(
  intent: ColorGraphIntent,
  lutData: LUTData | null,
  executor: PreviewColorExecutor,
  variant?: 'processed' | 'neutral',
): PreviewColorPlan {
  return resolvePreviewColorPlan({
    intent,
    lut: lutData,
    rawRenderExposure: RAW_RENDER_EXPOSURE,
    executor,
    ...(variant ? { variant } : {}),
  })
}

function expectStripped(
  result: PreviewColorPlan,
  reason: PreviewColorPlanReason,
  intent: ColorGraphIntent = ADJUSTED,
) {
  expect(result.reason).toBe(reason)
  expect(result.effective).toEqual(NO_LOOK)
  expect(result.lut).toBeNull()
  // The look goes; user adjustments and the RAW render exposure stay.
  expect(result.graph).toEqual(strippedGraph(intent))
  expect(stepKinds(result.graph)).not.toContain('lut3d')
  const rawStep = result.graph?.steps.find(
    (step) => step.kind === 'raw-render-exposure',
  )
  expect(rawStep).toMatchObject({ ev: RAW_RENDER_EXPOSURE.ev })
  const userExposure = result.graph?.steps.find(
    (step) => step.kind === 'user-exposure',
  )
  expect(userExposure).toMatchObject({ ev: intent.userExposureEv })
  expect(result.histogram).toEqual({ kind: 'graph', graph: result.graph })
}

describe('resolvePreviewColorPlan: custom LUT contracts', () => {
  const LEGAL_LUTS: Array<[string, LUTData]> = [
    ['scene-creative with an sRGB output', lut(confirmed(profile()))],
    [
      'display look',
      lut(
        confirmed(
          profile({
            role: 'display-look',
            inputGamut: 'srgb-rec709',
            inputTransfer: 'srgb',
            outputGamut: undefined,
            outputTransfer: undefined,
            outputRange: undefined,
          }),
        ),
      ),
    ],
  ]

  for (const [label, legal] of LEGAL_LUTS) {
    for (const executor of EXECUTORS) {
      for (const intensity of INTENSITIES) {
        it(`draws a legal ${label} at strength ${intensity} on ${executor}`, () => {
          const intent = { ...ADJUSTED, intensity }
          const result = plan(intent, legal, executor)

          expect(result.reason).toBeNull()
          expect(result.selected).toEqual(pickLookSelection(intent))
          expect(result.effective).toEqual({
            styleKind: 'custom',
            builtinPreset: null,
            intensity,
          })
          expect(result.lut).toBe(legal)
          expect(result.graph).toEqual(
            supported({
              ...intent,
              lut: legal,
              rawRenderExposure: RAW_RENDER_EXPOSURE,
            }),
          )
          // The strength stays continuous all the way into the graph.
          expect(
            result.graph?.steps.find(
              (step) => step.kind === 'lut-output-to-srgb',
            ),
          ).toMatchObject({ intensity })
          expect(result.histogram).toEqual({
            kind: 'graph',
            graph: result.graph,
          })
        })
      }
    }
  }

  const REFUSED_LUTS: Array<[string, LUTData, PreviewColorPlanReason]> = [
    [
      'a recommended (unconfirmed) contract',
      lut({ kind: 'recommended', recommendations: [profile()] }),
      'lut-input-unconfirmed',
    ],
    ['an unknown contract', lut({ kind: 'unknown' }), 'lut-input-unconfirmed'],
    [
      'an unsupported output contract',
      lut({ kind: 'unsupported-output', recommendations: [] }),
      'lut-output-unsupported',
    ],
    [
      'an unknown output range',
      lut(confirmed(profile({ outputRange: 'unknown' }))),
      'lut-output-range-unknown',
    ],
    [
      'an unknown output range on a display look',
      lut(
        confirmed(
          profile({
            role: 'display-look',
            inputGamut: 'srgb-rec709',
            inputTransfer: 'srgb',
            outputRange: 'unknown',
          }),
        ),
      ),
      'lut-output-range-unknown',
    ],
    [
      'a missing output profile',
      lut(confirmed(profile({ outputTransfer: undefined }))),
      'lut-output-profile-missing',
    ],
    [
      'a linear output',
      lut(confirmed(profile({ outputTransfer: 'linear' }))),
      'lut-output-transfer-linear',
    ],
    [
      'a display look with a linear output',
      lut(
        confirmed(
          profile({
            role: 'display-look',
            inputGamut: 'srgb-rec709',
            inputTransfer: 'srgb',
            outputTransfer: 'linear',
          }),
        ),
      ),
      'lut-output-transfer-linear',
    ],
  ]

  for (const [label, refused, reason] of REFUSED_LUTS) {
    for (const executor of EXECUTORS) {
      for (const intensity of INTENSITIES) {
        it(`strips the look only for ${label} at strength ${intensity} on ${executor}`, () => {
          const intent = deepFreeze({ ...ADJUSTED, intensity })
          const result = plan(intent, refused, executor)

          expectStripped(result, reason)
          // The selection is reported as chosen, never rewritten.
          expect(result.selected).toEqual(pickLookSelection(intent))
          expect(intent.styleKind).toBe('custom')
          expect(intent.intensity).toBe(intensity)
          // Export still refuses the selection the preview stripped.
          expect(
            resolveExportColorGraph({
              ...intent,
              lut: refused,
              rawRenderExposure: RAW_RENDER_EXPOSURE,
            }).supported,
          ).toBe(false)
        })
      }
    }
  }

  it('draws no look while the selected custom LUT has not loaded', () => {
    for (const executor of EXECUTORS) {
      expectStripped(plan(ADJUSTED, null, executor), 'lut-not-loaded')
    }
  })

  it('ignores a loaded LUT when no look is selected', () => {
    const intent = { ...ADJUSTED, styleKind: 'none' as const }
    for (const executor of EXECUTORS) {
      const result = plan(intent, lut({ kind: 'unknown' }), executor)
      expect(result.reason).toBeNull()
      expect(result.effective).toEqual(NO_LOOK)
      expect(result.lut).toBeNull()
      expect(result.graph).toEqual(strippedGraph(intent))
    }
  })
})

describe('resolvePreviewColorPlan: reasons follow the export authority', () => {
  const ROLES = [
    'display-look',
    'scene-creative',
    'technical-output',
    'combined-look-output',
  ] as const
  const OUTPUT_TRANSFERS = [undefined, 'srgb', 'linear', 'gamma24'] as const
  const OUTPUT_RANGES = [undefined, 'full', 'legal', 'unknown'] as const
  const OUTPUT_GAMUTS = [undefined, 'srgb-rec709', 'rec2020'] as const

  it('reports a typed reason exactly when export refuses the contract', () => {
    let refusals = 0
    for (const role of ROLES) {
      for (const outputTransfer of OUTPUT_TRANSFERS) {
        for (const outputRange of OUTPUT_RANGES) {
          for (const outputGamut of OUTPUT_GAMUTS) {
            const candidate = lut(
              confirmed(
                profile({
                  role,
                  inputGamut:
                    role === 'display-look' ? 'srgb-rec709' : 'v-gamut',
                  inputTransfer: role === 'display-look' ? 'srgb' : 'v-log',
                  outputTransfer,
                  outputRange,
                  outputGamut,
                }),
              ),
            )
            const exported = resolveExportColorGraph({
              ...ADJUSTED,
              lut: candidate,
              rawRenderExposure: RAW_RENDER_EXPOSURE,
            })
            const result = plan(ADJUSTED, candidate, 'cpu')
            if (exported.supported) {
              expect(result.reason).toBeNull()
              expect(result.graph).toEqual(exported)
            } else {
              refusals += 1
              expect(result.reason).not.toBeNull()
              expect(result.reason).not.toBe('lut-contract-refused')
              expect(result.graph).toEqual(strippedGraph())
            }
          }
        }
      }
    }
    expect(refusals).toBeGreaterThan(0)
  })

  it('returns reason codes from a closed list and no export message', () => {
    const results = [
      plan(ADJUSTED, lut({ kind: 'unknown' }), 'cpu'),
      plan(ADJUSTED, null, 'webgpu'),
      plan(
        { ...ADJUSTED, styleKind: 'builtin', builtinPreset: 'warm' },
        null,
        'cpu',
      ),
      plan(ADJUSTED, lut(confirmed(profile())), 'cpu', 'neutral'),
    ]
    for (const result of results) {
      expect(PREVIEW_COLOR_PLAN_REASONS).toContain(result.reason)
      expect(result).not.toHaveProperty('message')
    }
  })
})

describe('resolvePreviewColorPlan: neutral variant', () => {
  const SELECTIONS: Array<[string, ColorGraphIntent, LUTData | null]> = [
    ['a legal custom LUT', ADJUSTED, lut(confirmed(profile()))],
    ['a refused custom LUT', ADJUSTED, lut({ kind: 'unknown' })],
    [
      'a builtin preset',
      { ...ADJUSTED, styleKind: 'builtin', builtinPreset: 'film-contrast' },
      null,
    ],
  ]

  for (const [label, intent, lutData] of SELECTIONS) {
    for (const executor of EXECUTORS) {
      it(`draws no look and neutral user color over ${label} on ${executor}`, () => {
        const result = plan(intent, lutData, executor, 'neutral')

        expect(result.variant).toBe('neutral')
        expect(result.reason).toBe('neutral-variant')
        expect(result.selected).toEqual(pickLookSelection(intent))
        expect(result.effective).toEqual(NO_LOOK)
        expect(result.effectiveIntent).toEqual({
          ...NO_LOOK,
          ...NEUTRAL_USER_COLOR_INTENT,
        })
        expect(result.lut).toBeNull()
        // The intrinsic RAW render exposure stays on the original.
        expect(result.graph).toEqual(
          supported({
            ...NO_LOOK,
            ...NEUTRAL_USER_COLOR_INTENT,
            lut: null,
            rawRenderExposure: RAW_RENDER_EXPOSURE,
          } as ExportColorGraphInput),
        )
        expect(result.histogram).toEqual({
          kind: 'graph',
          graph: result.graph,
        })
      })
    }
  }

  it('defaults to the processed variant', () => {
    expect(plan(ADJUSTED, null, 'cpu').variant).toBe('processed')
  })
})

describe('resolvePreviewColorPlan: builtin presets', () => {
  for (const intensity of INTENSITIES) {
    const intent = deepFreeze({
      ...ADJUSTED,
      styleKind: 'builtin' as const,
      builtinPreset: 'cinematic' as const,
      intensity,
    })

    it(`keeps the preset on WebGPU at strength ${intensity}`, () => {
      const result = plan(intent, null, 'webgpu')

      expect(result.reason).toBeNull()
      expect(result.effective).toEqual({
        styleKind: 'builtin',
        builtinPreset: 'cinematic',
        intensity,
      })
      expect(result.effectiveIntent).toEqual(intent)
      expect(result.lut).toBeNull()
      // No TS executor draws a preset, so there is no graph to stand in
      // for it, and the histogram does not measure the stripped graph.
      expect(result.graph).toBeNull()
      expect(result.histogram).toEqual({
        kind: 'unrepresented',
        reason: 'builtin-no-ts-executor',
      })
    })

    it(`draws the adjusted stripped graph on the CPU at strength ${intensity}`, () => {
      const result = plan(intent, null, 'cpu')

      expectStripped(result, 'builtin-no-ts-executor', intent)
      expect(result.selected).toEqual({
        styleKind: 'builtin',
        builtinPreset: 'cinematic',
        intensity,
      })
    })
  }

  it('keeps export failing closed on a builtin preset', () => {
    const intent = {
      ...ADJUSTED,
      styleKind: 'builtin' as const,
      builtinPreset: 'mono' as const,
    }
    plan(intent, null, 'webgpu')
    plan(intent, null, 'cpu')
    expect(
      resolveExportColorGraph({
        ...intent,
        lut: null,
        rawRenderExposure: RAW_RENDER_EXPOSURE,
      }).supported,
    ).toBe(false)
  })

  it('reads a builtin selection without a preset as no look, as export does', () => {
    const intent = {
      ...ADJUSTED,
      styleKind: 'builtin' as const,
      builtinPreset: null,
    }
    for (const executor of EXECUTORS) {
      expectStripped(
        plan(intent, null, executor),
        'builtin-preset-missing',
        intent,
      )
    }
  })
})

describe('resolvePreviewColorPlan: selections and reasons per executor', () => {
  const LEGAL = lut(confirmed(profile()))
  const CINEMATIC: ColorGraphIntent = {
    ...ADJUSTED,
    styleKind: 'builtin',
    builtinPreset: 'cinematic',
  }
  const CASES: Array<{
    label: string
    intent: ColorGraphIntent
    lut: LUTData | null
    variant?: 'neutral'
    expected: Record<
      PreviewColorExecutor,
      {
        effective: PreviewColorPlan['effective']['styleKind']
        reason: PreviewColorPlanReason | null
        drawsLut: boolean
        histogram: PreviewColorPlan['histogram']['kind']
      }
    >
  }> = [
    {
      label: 'a legal custom LUT',
      intent: ADJUSTED,
      lut: LEGAL,
      expected: {
        webgpu: {
          effective: 'custom',
          reason: null,
          drawsLut: true,
          histogram: 'graph',
        },
        cpu: {
          effective: 'custom',
          reason: null,
          drawsLut: true,
          histogram: 'graph',
        },
      },
    },
    {
      label: 'an unsupported LUT output',
      intent: ADJUSTED,
      lut: lut({ kind: 'unsupported-output', recommendations: [] }),
      expected: {
        webgpu: {
          effective: 'none',
          reason: 'lut-output-unsupported',
          drawsLut: false,
          histogram: 'graph',
        },
        cpu: {
          effective: 'none',
          reason: 'lut-output-unsupported',
          drawsLut: false,
          histogram: 'graph',
        },
      },
    },
    {
      label: 'an unloaded custom LUT',
      intent: ADJUSTED,
      lut: null,
      expected: {
        webgpu: {
          effective: 'none',
          reason: 'lut-not-loaded',
          drawsLut: false,
          histogram: 'graph',
        },
        cpu: {
          effective: 'none',
          reason: 'lut-not-loaded',
          drawsLut: false,
          histogram: 'graph',
        },
      },
    },
    {
      label: 'a builtin preset',
      intent: CINEMATIC,
      lut: null,
      expected: {
        webgpu: {
          effective: 'builtin',
          reason: null,
          drawsLut: false,
          histogram: 'unrepresented',
        },
        cpu: {
          effective: 'none',
          reason: 'builtin-no-ts-executor',
          drawsLut: false,
          histogram: 'graph',
        },
      },
    },
    {
      label: 'a builtin style without a preset',
      intent: { ...CINEMATIC, builtinPreset: null },
      lut: null,
      expected: {
        webgpu: {
          effective: 'none',
          reason: 'builtin-preset-missing',
          drawsLut: false,
          histogram: 'graph',
        },
        cpu: {
          effective: 'none',
          reason: 'builtin-preset-missing',
          drawsLut: false,
          histogram: 'graph',
        },
      },
    },
    {
      label: 'no look',
      intent: { ...ADJUSTED, styleKind: 'none' },
      lut: LEGAL,
      expected: {
        webgpu: {
          effective: 'none',
          reason: null,
          drawsLut: false,
          histogram: 'graph',
        },
        cpu: {
          effective: 'none',
          reason: null,
          drawsLut: false,
          histogram: 'graph',
        },
      },
    },
    {
      label: 'the neutral variant over a builtin preset',
      intent: CINEMATIC,
      lut: null,
      variant: 'neutral',
      expected: {
        webgpu: {
          effective: 'none',
          reason: 'neutral-variant',
          drawsLut: false,
          histogram: 'graph',
        },
        cpu: {
          effective: 'none',
          reason: 'neutral-variant',
          drawsLut: false,
          histogram: 'graph',
        },
      },
    },
  ]

  for (const { label, intent, lut: lutData, variant, expected } of CASES) {
    for (const executor of EXECUTORS) {
      it(`plans ${label} on ${executor}`, () => {
        const result = plan(intent, lutData, executor, variant)

        expect(result.selected).toEqual(pickLookSelection(intent))
        expect({
          effective: result.effective.styleKind,
          reason: result.reason,
          drawsLut: result.lut !== null,
          histogram: result.histogram.kind,
        }).toEqual(expected[executor])
      })
    }
  }
})
