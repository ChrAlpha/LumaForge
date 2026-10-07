import type {
  ColorGraphIntentSource,
  LUTColorProfile,
  LUTData,
  RawRenderExposure,
} from '@lumaforge/luma-color-runtime'
import { NEUTRAL_USER_COLOR_INTENT } from '@lumaforge/luma-color-runtime'
import type { ExportGeometry } from '@lumaforge/render-engine/export'
import { describe, expect, it } from 'vitest'

import type { ExportResultIdentity } from '../../model/export-result'
import type { ExportResultIdentityInput } from './export-result-identity'
import {
  captureExportResultIdentity,
  isSameExportResult,
  isSameExportResultInput,
} from './export-result-identity'

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

const sourceFile = new File(['raw'], 'frame.dng', { lastModified: 1_000 })

const displayLook: LUTColorProfile = {
  id: 'display-srgb',
  label: 'Display sRGB',
  role: 'display-look',
  inputGamut: 'srgb-rec709',
  inputTransfer: 'srgb',
  inputRange: 'full',
  aliases: [],
}

const lutTable = new Float32Array(2 * 2 * 2 * 3).fill(0.5)

function makeLut(overrides: Partial<LUTData> = {}): LUTData {
  return {
    size: 2,
    data: lutTable,
    domainMin: [0, 0, 0],
    domainMax: [1, 1, 1],
    title: 'Film',
    inputProfile: 'display-srgb',
    profileResolution: {
      kind: 'confirmed',
      profile: displayLook,
      confidence: 'user',
    },
    ...overrides,
  }
}

function makeIntent(
  overrides: Partial<ColorGraphIntentSource> = {},
): ColorGraphIntentSource {
  return {
    styleKind: 'custom',
    builtinPreset: null,
    intensity: 0.37,
    ...NEUTRAL_USER_COLOR_INTENT,
    ...overrides,
  }
}

const exposure: RawRenderExposure = {
  ev: 0.5,
  multiplier: 2 ** 0.5,
  source: 'image-statistics',
}

const geometry: ExportGeometry = {
  matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  constrainCrop: true,
}

function makeInput(
  overrides: Partial<ExportResultIdentityInput> = {},
): ExportResultIdentityInput {
  return {
    resultKind: 'full-resolution',
    attemptId: 'attempt-1',
    sessionId: 'session-1',
    sourceFile,
    intent: makeIntent(),
    lut: makeLut(),
    rawRenderExposure: exposure,
    geometry,
    ...overrides,
  }
}

const baseline = captureExportResultIdentity(makeInput())

describe('captureExportResultIdentity', () => {
  it.each<[string, Partial<ExportResultIdentityInput>]>([
    ['session', { sessionId: 'session-2' }],
    [
      'source file name',
      {
        sourceFile: new File(['raw'], 'other.dng', { lastModified: 1_000 }),
      },
    ],
    [
      'source file size',
      {
        sourceFile: new File(['raw-longer'], 'frame.dng', {
          lastModified: 1_000,
        }),
      },
    ],
    [
      'source file modification time',
      {
        sourceFile: new File(['raw'], 'frame.dng', { lastModified: 2_000 }),
      },
    ],
    ['user tone', { intent: makeIntent({ userExposureEv: 0.3 }) }],
    ['color balance', { intent: makeIntent({ userTemperature: 12 }) }],
    ['saturation', { intent: makeIntent({ userVibrance: -8 }) }],
    [
      'HSL',
      {
        intent: makeIntent({
          selectiveColor: {
            ...NEUTRAL_USER_COLOR_INTENT.selectiveColor,
            red: { hue: 5, saturation: 0, lightness: 0 },
          },
        }),
      },
    ],
    ['look strength', { intent: makeIntent({ intensity: 0.38 }) }],
    ['look kind', { intent: makeIntent({ styleKind: 'none' }) }],
    [
      'built-in preset',
      {
        intent: makeIntent({ styleKind: 'builtin', builtinPreset: 'warm' }),
      },
    ],
    ['LUT table bytes', { lut: makeLut({ data: new Float32Array(lutTable) }) }],
    ['LUT table domain', { lut: makeLut({ domainMax: [2, 2, 2] }) }],
    ['missing LUT', { lut: null }],
    [
      'pinned exposure',
      { rawRenderExposure: { ...exposure, ev: 0.75, multiplier: 2 ** 0.75 } },
    ],
    ['missing pinned exposure', { rawRenderExposure: null }],
    [
      'geometry matrix',
      { geometry: { ...geometry, matrix: [1, 0, 0.1, 0, 1, 0, 0, 0, 1] } },
    ],
    ['geometry crop', { geometry: { ...geometry, constrainCrop: false } }],
    ['no geometry', { geometry: null }],
  ])('tells requests apart by %s', (_axis, overrides) => {
    const changed = captureExportResultIdentity(makeInput(overrides))

    expect(isSameExportResultInput(changed, baseline)).toBe(false)
    expect(isSameExportResult(changed, baseline)).toBe(false)
  })

  it.each<[string, Partial<ExportResultIdentityInput>]>([
    ['result kind', { resultKind: 'hq-preview' }],
    ['attempt', { attemptId: 'attempt-2' }],
  ])(
    'keeps the input but not the result when only the %s differs',
    (_axis, overrides) => {
      const changed = captureExportResultIdentity(makeInput(overrides))

      expect(isSameExportResultInput(changed, baseline)).toBe(true)
      expect(isSameExportResult(changed, baseline)).toBe(false)
    },
  )

  it('tells contracts apart over unchanged LUT bytes', () => {
    const recontracted = captureExportResultIdentity(
      makeInput({
        lut: makeLut({
          profileResolution: {
            kind: 'confirmed',
            profile: { ...displayLook, inputRange: 'legal' },
            confidence: 'user',
          },
        }),
      }),
    )
    const unconfirmed = captureExportResultIdentity(
      makeInput({ lut: makeLut({ profileResolution: { kind: 'unknown' } }) }),
    )

    expect(recontracted.lut?.inMemoryGeneration).toBe(
      baseline.lut?.inMemoryGeneration,
    )
    expect(unconfirmed.lut?.inMemoryGeneration).toBe(
      baseline.lut?.inMemoryGeneration,
    )
    expect(isSameExportResultInput(recontracted, baseline)).toBe(false)
    expect(isSameExportResultInput(unconfirmed, baseline)).toBe(false)
    expect(unconfirmed.lut?.contract).toEqual({
      status: 'unconfirmed',
      resolution: 'unknown',
    })
  })

  it('keeps only the contract, not how it was confirmed or labelled', () => {
    const relabelled = captureExportResultIdentity(
      makeInput({
        lut: makeLut({
          title: 'Renamed',
          profileResolution: {
            kind: 'confirmed',
            profile: { ...displayLook, label: 'Other label', aliases: ['x'] },
            confidence: 'metadata',
          },
        }),
      }),
    )

    expect(isSameExportResultInput(relabelled, baseline)).toBe(true)
    expect(baseline.lut?.contract).toEqual({
      status: 'confirmed',
      role: 'display-look',
      inputGamut: 'srgb-rec709',
      inputTransfer: 'srgb',
      inputRange: 'full',
    })
  })

  it('names the same LUT table by one in-memory generation', () => {
    const again = captureExportResultIdentity(makeInput({ lut: makeLut() }))
    const reparsed = captureExportResultIdentity(
      makeInput({ lut: makeLut({ data: new Float32Array(lutTable) }) }),
    )

    expect(again.lut?.inMemoryGeneration).toBe(baseline.lut?.inMemoryGeneration)
    expect(reparsed.lut?.inMemoryGeneration).not.toBe(
      baseline.lut?.inMemoryGeneration,
    )
  })

  it('records no LUT when the look draws none', () => {
    const noLook = captureExportResultIdentity(
      makeInput({ intent: makeIntent({ styleKind: 'none' }) }),
    )
    const noLookOtherLut = captureExportResultIdentity(
      makeInput({
        intent: makeIntent({ styleKind: 'none' }),
        lut: makeLut({ data: new Float32Array(lutTable) }),
      }),
    )

    expect(noLook.lut).toBeNull()
    expect(isSameExportResultInput(noLook, noLookOtherLut)).toBe(true)
  })

  it.each([
    [0, 0.0001],
    [0, 1],
    [0.37, 0.370001],
    [1, 0.999],
  ])(
    'keeps strength %s continuous, apart from %s, with its LUT',
    (left, right) => {
      const a = captureExportResultIdentity(
        makeInput({ intent: makeIntent({ intensity: left }) }),
      )
      const b = captureExportResultIdentity(
        makeInput({ intent: makeIntent({ intensity: right }) }),
      )

      expect(a.colorIntent.intensity).toBe(left)
      expect(a.lut).not.toBeNull()
      expect(isSameExportResultInput(a, b)).toBe(false)
    },
  )

  it('keeps a zero strength LUT apart from no look at all', () => {
    const zero = captureExportResultIdentity(
      makeInput({ intent: makeIntent({ intensity: 0 }) }),
    )
    const none = captureExportResultIdentity(
      makeInput({ intent: makeIntent({ intensity: 0, styleKind: 'none' }) }),
    )

    expect(isSameExportResultInput(zero, none)).toBe(false)
  })

  it('reads user color the way the color graph does', () => {
    const outOfBounds = captureExportResultIdentity(
      makeInput({ intent: makeIntent({ userContrast: 10_000 }) }),
    )
    const clamped = captureExportResultIdentity(
      makeInput({ intent: makeIntent({ userContrast: 100 }) }),
    )
    const withoutHsl = captureExportResultIdentity(
      makeInput({
        intent: { ...makeIntent(), selectiveColor: undefined },
      }),
    )

    expect(isSameExportResultInput(outOfBounds, clamped)).toBe(true)
    expect(isSameExportResultInput(withoutHsl, baseline)).toBe(true)
  })

  it('ignores view mode, split, zoom and pan', () => {
    const viewOnly = {
      ...makeIntent(),
      viewMode: 'original',
      compareSplit: 0.2,
      zoom: 4,
      panX: 120,
      panY: -40,
    } as ColorGraphIntentSource
    const changed = captureExportResultIdentity(makeInput({ intent: viewOnly }))

    expect(isSameExportResult(changed, baseline)).toBe(true)
    expect(changed.colorIntent).not.toHaveProperty('viewMode')
    expect(changed.colorIntent).not.toHaveProperty('compareSplit')
    expect(changed.colorIntent).not.toHaveProperty('zoom')
  })

  it('is deeply frozen and detached from the inputs it was captured from', () => {
    const intent: Mutable<ColorGraphIntentSource> = makeIntent({
      selectiveColor: {
        ...NEUTRAL_USER_COLOR_INTENT.selectiveColor,
        red: { hue: 5, saturation: 0, lightness: 0 },
      },
    })
    const matrix = [...geometry.matrix]
    const pinned = { ...exposure }
    const profile = { ...displayLook }
    const lut = makeLut({
      profileResolution: { kind: 'confirmed', profile, confidence: 'user' },
    })
    const identity = captureExportResultIdentity(
      makeInput({
        intent,
        lut,
        rawRenderExposure: pinned,
        geometry: { matrix, constrainCrop: true },
      }),
    )
    const signature = identity.inputSignature

    // Completion-time state moves on; the captured identity does not.
    intent.userExposureEv = 2
    ;(intent.selectiveColor!.red as { hue: number }).hue = 40
    matrix[2] = 0.5
    pinned.ev = 3
    profile.inputTransfer = 'v-log'
    lut.domainMax[0] = 4

    expect(identity.colorIntent.userExposureEv).toBe(0)
    expect(identity.colorIntent.selectiveColor.red.hue).toBe(5)
    expect(identity.geometry?.matrix[2]).toBe(0)
    expect(identity.rawRenderExposure?.ev).toBe(0.5)
    expect(identity.lut?.contract).toMatchObject({ inputTransfer: 'srgb' })
    expect(identity.lut?.domainMax[0]).toBe(1)
    expect(identity.inputSignature).toBe(signature)

    for (const value of [
      identity,
      identity.source,
      identity.colorIntent,
      identity.colorIntent.selectiveColor,
      identity.colorIntent.selectiveColor.red,
      identity.lut,
      identity.lut?.contract,
      identity.lut?.domainMin,
      identity.lut?.domainMax,
      identity.rawRenderExposure,
      identity.geometry,
      identity.geometry?.matrix,
    ]) {
      expect(Object.isFrozen(value)).toBe(true)
    }
  })

  it('refuses an attempt without an id', () => {
    expect(() =>
      captureExportResultIdentity(makeInput({ attemptId: '' })),
    ).toThrow('EXPORT_RESULT_IDENTITY_INVALID')
  })
})

describe('isSameExportResult', () => {
  it('needs the same kind and attempt as well as the same input', () => {
    const other: ExportResultIdentity = { ...baseline }

    expect(isSameExportResult(other, baseline)).toBe(true)
    expect(
      isSameExportResult({ ...baseline, attemptId: 'attempt-9' }, baseline),
    ).toBe(false)
    expect(
      isSameExportResult({ ...baseline, resultKind: 'hq-preview' }, baseline),
    ).toBe(false)
  })
})
