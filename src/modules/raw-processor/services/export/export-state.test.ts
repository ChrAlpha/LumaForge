import type { ColorGraphIntent } from '@lumaforge/luma-color-runtime'
import {
  COLOR_GRAPH_INTENT_KEYS,
  NEUTRAL_SELECTIVE_COLOR,
  NEUTRAL_USER_COLOR_INTENT,
} from '@lumaforge/luma-color-runtime'
import type { LumaRawExportCapability } from '@lumaforge/luma-raw-runtime'
import { createBlobOutputResult } from '@lumaforge/render-engine/export'
import { describe, expect, expectTypeOf, it } from 'vitest'

import { createExportResult } from '../../model/export-result'
import type { ImageSession } from '../../model/session'
import { createTransformState } from '../../model/session-factory'
import { captureExportResultIdentity } from './export-result-identity'
import {
  changesRenderGraphParams,
  clearExportResultForActiveExport,
  clearExportResultState,
  hasSameRawRenderExposure,
  toFullResCapabilityState,
} from './export-state'

function createSession(
  exportState: Partial<ImageSession['exportState']> = {},
): ImageSession {
  return {
    id: 'session-export-state',
    createdAt: 1,
    sourceFile: {
      name: 'frame.ARW',
      extension: 'arw',
      sizeBytes: 12,
      supportLevel: 'experimental',
    },
    previewBundle: {
      embeddedPreview: { status: 'idle' },
      quickDecodePreview: { status: 'ready', width: 800, height: 600 },
      boundedHqPreview: { status: 'ready', width: 800, height: 600 },
      displaySource: 'bounded-hq',
    },
    activeStyle: null,
    viewState: {
      mode: 'compare',
      compareSplit: 0.5,
      zoom: 1,
      panX: 0,
      panY: 0,
      fitMode: 'screen',
    },
    exportState: {
      status: 'idle',
      fullResCapability: { status: 'supported', width: 4000, height: 3000 },
      ...exportState,
    },
    exportGeometry: null,
    transform: createTransformState('session-export-state'),
  }
}

function createReadyExportResult() {
  return createExportResult({
    kind: 'full-resolution',
    output: createBlobOutputResult({
      filename: 'frame-neutral.jpg',
      blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
    }),
    width: 4000,
    height: 3000,
    now: () => 123,
    copyCapability: {
      mode: 'full-resolution',
    },
    identity: captureExportResultIdentity({
      resultKind: 'full-resolution',
      attemptId: 'attempt-export-state',
      sessionId: 'session-export-state',
      sourceFile: new File(['raw'], 'frame.ARW'),
      intent: {
        styleKind: 'none',
        builtinPreset: null,
        intensity: 0,
        ...NEUTRAL_USER_COLOR_INTENT,
      },
      lut: null,
      rawRenderExposure: { ev: 0, multiplier: 1, source: 'identity' },
      geometry: null,
    }),
  })
}

function createCapability(
  overrides: Partial<LumaRawExportCapability> = {},
): LumaRawExportCapability {
  return {
    supported: true,
    strategy: 'libraw-processed-window',
    width: 4000,
    height: 3000,
    rawWidth: 6048,
    rawHeight: 4024,
    blackLevel: 512,
    whiteLevel: 16383,
    color: {
      workingSpace: 'linear-prophoto-rgb',
      librawOutputColor: 'prophoto',
      gamma: 'linear',
      cameraWhiteBalanceAppliedByRuntime: true,
      cameraMatrixAppliedByRuntime: true,
    },
    sensor: {
      layout: 'bayer',
    },
    windows: {
      librawProcessed: true,
    },
    reasons: [],
    ...overrides,
  }
}

type ProcessingParamClass = 'render' | 'look'

// Every ColorGraphIntent key must be classified; a new field fails the
// typecheck until it is placed here. 'render' (user tone/color intent) and
// 'look' (style, preset, intensity) keys reach the export color graph, so
// changing them must invalidate a ready export.
const PROCESSING_PARAM_CLASSES = {
  styleKind: 'look',
  builtinPreset: 'look',
  intensity: 'look',
  userExposureEv: 'render',
  userContrast: 'render',
  userHighlights: 'render',
  userShadows: 'render',
  userWhites: 'render',
  userBlacks: 'render',
  userTemperature: 'render',
  userTint: 'render',
  userSaturation: 'render',
  userVibrance: 'render',
  selectiveColor: 'render',
} satisfies Record<keyof ColorGraphIntent, ProcessingParamClass>

type ProcessingParamKey = keyof typeof PROCESSING_PARAM_CLASSES

const NEUTRAL_HSL_BAND = { hue: 0, saturation: 0, lightness: 0 } as const

// Matches the app's default color intent: no look, neutral user intent and
// neutral HSL bands.
const DEFAULT_PARAMS: ColorGraphIntent = {
  intensity: 0.7,
  styleKind: 'none',
  builtinPreset: null,
  userExposureEv: 0,
  userContrast: 0,
  userHighlights: 0,
  userShadows: 0,
  userWhites: 0,
  userBlacks: 0,
  userTemperature: 0,
  userTint: 0,
  userSaturation: 0,
  userVibrance: 0,
  selectiveColor: NEUTRAL_SELECTIVE_COLOR,
}

// A meaningful value for every key that differs from DEFAULT_PARAMS.
const NON_DEFAULT_VALUES: {
  [K in ProcessingParamKey]-?: NonNullable<ColorGraphIntent[K]>
} = {
  styleKind: 'custom',
  builtinPreset: 'film-contrast',
  intensity: 0.35,
  userExposureEv: 0.5,
  userContrast: 20,
  userHighlights: -30,
  userShadows: 25,
  userWhites: -15,
  userBlacks: 10,
  userTemperature: 12,
  userTint: -8,
  userSaturation: 15,
  userVibrance: 30,
  selectiveColor: {
    red: { hue: 25, saturation: 0, lightness: 0 },
    orange: NEUTRAL_HSL_BAND,
    yellow: NEUTRAL_HSL_BAND,
    green: NEUTRAL_HSL_BAND,
    aqua: { hue: 0, saturation: -20, lightness: 10 },
    blue: NEUTRAL_HSL_BAND,
    purple: NEUTRAL_HSL_BAND,
    magenta: NEUTRAL_HSL_BAND,
  },
}

const PROCESSING_PARAM_KEYS = Object.keys(
  PROCESSING_PARAM_CLASSES,
) as ProcessingParamKey[]

function keysOfClass(...classes: ProcessingParamClass[]) {
  return PROCESSING_PARAM_KEYS.filter((key) =>
    classes.includes(PROCESSING_PARAM_CLASSES[key]),
  )
}

function patchOf<K extends ProcessingParamKey>(
  key: K,
  value: ColorGraphIntent[K],
): Partial<ColorGraphIntent> {
  return { [key]: value } as Partial<ColorGraphIntent>
}

describe('render graph param classification', () => {
  it('compares a patch against the complete color intent', () => {
    expectTypeOf(changesRenderGraphParams)
      .parameter(0)
      .toEqualTypeOf<ColorGraphIntent>()
  })

  it('has a non-default value for every classified key', () => {
    expect(Object.keys(NON_DEFAULT_VALUES).sort()).toEqual(
      [...PROCESSING_PARAM_KEYS].sort(),
    )
    for (const key of PROCESSING_PARAM_KEYS) {
      expect(NON_DEFAULT_VALUES[key]).not.toEqual(DEFAULT_PARAMS[key])
    }
  })

  it.each(keysOfClass('render', 'look'))(
    'invalidates the render graph when %s changes',
    (key) => {
      const changed: ColorGraphIntent = {
        ...DEFAULT_PARAMS,
        ...patchOf(key, NON_DEFAULT_VALUES[key]),
      }

      expect(
        changesRenderGraphParams(
          DEFAULT_PARAMS,
          patchOf(key, NON_DEFAULT_VALUES[key]),
        ),
      ).toBe(true)
      expect(
        changesRenderGraphParams(changed, patchOf(key, DEFAULT_PARAMS[key])),
      ).toBe(true)
      expect(
        changesRenderGraphParams(
          DEFAULT_PARAMS,
          patchOf(key, DEFAULT_PARAMS[key]),
        ),
      ).toBe(false)
    },
  )

  it('names every render and look key in the canonical color graph intent', () => {
    expect([...COLOR_GRAPH_INTENT_KEYS].sort()).toEqual(
      keysOfClass('render', 'look').sort(),
    )
  })

  it.each(
    keysOfClass('render', 'look').filter((key) => key !== 'selectiveColor'),
  )('counts %s carried as undefined as a change', (key) => {
    // A carried key is compared even when its value is undefined; only
    // keys the patch does not own are skipped.
    expect(
      changesRenderGraphParams(
        DEFAULT_PARAMS,
        patchOf(key, undefined as never),
      ),
    ).toBe(true)
  })

  it('compares selective color carried as undefined by its normalized bands', () => {
    const shifted = {
      ...DEFAULT_PARAMS,
      selectiveColor: NON_DEFAULT_VALUES.selectiveColor,
    }

    expect(
      changesRenderGraphParams(DEFAULT_PARAMS, { selectiveColor: undefined }),
    ).toBe(false)
    expect(
      changesRenderGraphParams(shifted, { selectiveColor: undefined }),
    ).toBe(true)
  })

  it('compares only the keys a patch carries', () => {
    const allNonDefault = { ...DEFAULT_PARAMS, ...NON_DEFAULT_VALUES }

    expect(changesRenderGraphParams(allNonDefault, {})).toBe(false)
    expect(changesRenderGraphParams(allNonDefault, { intensity: 0.62 })).toBe(
      true,
    )
  })
})

describe('continuous look strength', () => {
  // Light 0.4, Standard 0.7 and Strong 1 are only detents on the Strength
  // row; any amount in between is a distinct render graph input.
  function withIntensity(intensity: number): ColorGraphIntent {
    return { ...DEFAULT_PARAMS, styleKind: 'custom', intensity }
  }

  it.each([
    [0.37, 0.62],
    [0.62, 0.7],
    [0.62, 0.63],
    [0.37, 0],
  ])('invalidates the render graph from %s to %s', (from, to) => {
    expect(
      changesRenderGraphParams(withIntensity(from), { intensity: to }),
    ).toBe(true)
  })

  it.each([0, 0.37, 0.62, 1])(
    'keeps the render graph when %s repeats',
    (intensity) => {
      expect(
        changesRenderGraphParams(withIntensity(intensity), { intensity }),
      ).toBe(false)
    },
  )
})

describe('export state helpers', () => {
  it('leaves an idle session without a ready result unchanged by reference', () => {
    const session = createSession()

    expect(clearExportResultState(session)).toBe(session)
  })

  it('clears ready export results while returning the session to idle', () => {
    const result = createReadyExportResult()
    const session = createSession({
      status: 'ready',
      result,
      lastProgress: { completedStrips: 3, totalStrips: 3 },
    })

    const next = clearExportResultState(session)

    expect(next).not.toBe(session)
    expect(next.exportState.status).toBe('idle')
    expect(next.exportState.result).toBeUndefined()
    expect(next.exportState.lastProgress).toEqual({
      completedStrips: 3,
      totalStrips: 3,
    })
  })

  it('clears exporting export results and progress while returning the session to idle', () => {
    const result = createReadyExportResult()
    const session = createSession({
      status: 'exporting',
      result,
      lastProgress: { completedStrips: 1, totalStrips: 4 },
    })

    const next = clearExportResultState(session)

    expect(next).not.toBe(session)
    expect(next.exportState.status).toBe('idle')
    expect(next.exportState.result).toBeUndefined()
    expect(next.exportState.lastProgress).toBeUndefined()
  })

  it('clears active exporting state progress and result without changing status', () => {
    const result = createReadyExportResult()
    const session = createSession({
      status: 'exporting',
      result,
      lastProgress: { completedStrips: 1, totalStrips: 4 },
    })

    const next = clearExportResultForActiveExport(session)

    expect(next.exportState.status).toBe('exporting')
    expect(next.exportState.result).toBeUndefined()
    expect(next.exportState.lastProgress).toBeUndefined()
  })

  it('compares selective color by value: an equal copy keeps, any band scalar changes', () => {
    expect(
      changesRenderGraphParams(DEFAULT_PARAMS, {
        selectiveColor: structuredClone(NEUTRAL_SELECTIVE_COLOR),
      }),
    ).toBe(false)
    for (const [band, shift] of [
      ['red', { hue: 50, saturation: 0, lightness: 0 }],
      ['blue', { hue: 0, saturation: 30, lightness: 0 }],
      ['magenta', { hue: 0, saturation: 0, lightness: -10 }],
    ] as const) {
      expect(
        changesRenderGraphParams(DEFAULT_PARAMS, {
          selectiveColor: { ...NEUTRAL_SELECTIVE_COLOR, [band]: shift },
        }),
      ).toBe(true)
    }
  })

  it('compares selective color by its normalized bands, not its record shape', () => {
    const neutralBand = { hue: 0, saturation: 0, lightness: 0 } as const
    const fullShifted = {
      red: { hue: 25, saturation: 0, lightness: 0 },
      orange: neutralBand,
      yellow: neutralBand,
      green: neutralBand,
      aqua: neutralBand,
      blue: neutralBand,
      purple: neutralBand,
      magenta: neutralBand,
    }
    const partialShifted = {
      red: { hue: 25, saturation: 0, lightness: 0 },
    } as ColorGraphIntent['selectiveColor']
    const partialNeutral = {
      blue: neutralBand,
    } as ColorGraphIntent['selectiveColor']

    expect(
      changesRenderGraphParams(
        { ...DEFAULT_PARAMS, selectiveColor: fullShifted },
        { selectiveColor: partialShifted },
      ),
    ).toBe(false)
    expect(
      changesRenderGraphParams(DEFAULT_PARAMS, {
        selectiveColor: partialNeutral,
      }),
    ).toBe(false)
    expect(
      changesRenderGraphParams(
        { ...DEFAULT_PARAMS, selectiveColor: partialShifted },
        { selectiveColor: partialNeutral },
      ),
    ).toBe(true)
  })

  it('compares raw render exposure by value while preserving null semantics', () => {
    expect(hasSameRawRenderExposure(null, null)).toBe(true)
    expect(hasSameRawRenderExposure(undefined, null)).toBe(false)
    expect(
      hasSameRawRenderExposure(
        { ev: 0, multiplier: 1, source: 'identity' },
        { ev: 0, multiplier: 1, source: 'identity' },
      ),
    ).toBe(true)
    expect(
      hasSameRawRenderExposure(
        { ev: 0, multiplier: 1, source: 'identity' },
        { ev: 1, multiplier: 2, source: 'user' },
      ),
    ).toBe(false)
  })

  it('maps runtime export capability facts to app session capability state', () => {
    expect(toFullResCapabilityState(createCapability())).toEqual({
      status: 'supported',
      width: 4000,
      height: 3000,
    })

    expect(
      toFullResCapabilityState(
        createCapability({
          supported: true,
          windows: { librawProcessed: false },
        }),
      ),
    ).toEqual({
      status: 'unsupported',
      reason: 'processed-window-unavailable',
    })

    // The runtime's own reasons stay as it reported them.
    expect(
      toFullResCapabilityState(
        createCapability({
          supported: false,
          reasons: ['missing-export-facts', 'processed-window-unavailable'],
        }),
      ),
    ).toEqual({
      status: 'unsupported',
      reason: 'missing-export-facts, processed-window-unavailable',
    })

    expect(
      toFullResCapabilityState(createCapability({ supported: false })),
    ).toEqual({
      status: 'unsupported',
      reason:
        'This RAW source does not support full-resolution export in the current browser build.',
    })
  })

  /**
   * Capabilities the runtime calls supported that the export's own
   * assessment refuses, one per reason the app names. Written as literals,
   * the way a malformed worker answer would arrive, so no type narrows them
   * first.
   */
  const MALFORMED_CAPABILITIES: ReadonlyArray<
    readonly [label: string, capability: unknown, reason: string]
  > = [
    [
      'no color facts',
      { ...createCapability(), color: undefined },
      'missing-color-transform',
    ],
    ['a zero width', { ...createCapability(), width: 0 }, 'missing-dimensions'],
    [
      'a missing strategy',
      { ...createCapability(), strategy: undefined },
      'processed-window-unavailable',
    ],
  ]

  it.each(MALFORMED_CAPABILITIES)(
    'never projects a supported capability with %s',
    (_label, capability, reason) => {
      expect(
        toFullResCapabilityState(capability as LumaRawExportCapability),
      ).toEqual({ status: 'unsupported', reason })
    },
  )

  it('lists the runtime reasons, then the reason of every other refusal once', () => {
    expect(
      toFullResCapabilityState({
        ...createCapability(),
        supported: false,
        reasons: ['libraw-unpack-failed'],
        width: 0,
        color: undefined,
        windows: { librawProcessed: false },
      } as unknown as LumaRawExportCapability),
    ).toEqual({
      status: 'unsupported',
      reason:
        'libraw-unpack-failed, missing-dimensions, processed-window-unavailable, missing-color-transform',
    })
    // The adapter already reports a refused capability under these reasons;
    // the assessment finding the same facts again repeats none of them.
    expect(
      toFullResCapabilityState({
        ...createCapability(),
        supported: false,
        reasons: ['processed-window-unavailable'],
        strategy: undefined,
        windows: { librawProcessed: false },
      }),
    ).toEqual({
      status: 'unsupported',
      reason: 'processed-window-unavailable',
    })
    // A runtime answer with no reasons list still reports what the
    // assessment found.
    expect(
      toFullResCapabilityState({
        ...createCapability(),
        reasons: undefined,
        color: undefined,
      } as unknown as LumaRawExportCapability),
    ).toEqual({ status: 'unsupported', reason: 'missing-color-transform' })
  })
})
