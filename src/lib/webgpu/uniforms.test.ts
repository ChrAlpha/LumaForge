import type {
  ColorGraphIntent,
  LUTColorProfile,
  LUTContractResolution,
  LUTData,
} from '@lumaforge/luma-color-runtime'
import {
  NEUTRAL_SELECTIVE_COLOR,
  NEUTRAL_USER_COLOR_INTENT,
  parseCubeLUT,
  pickColorGraphIntent,
  resolveExportColorGraph,
  toLUTData,
} from '@lumaforge/luma-color-runtime'
import { describe, expect, expectTypeOf, it } from 'vitest'

import type { WebGPUImages } from './images'
import { resolveGpuPreviewLook } from './lut-profile'
import { getShaderSpecialization } from './specialization'
import {
  UNIFORM_BUFFER_SIZE,
  UNIFORM_FIELDS,
  writeUniformMat3x3f,
} from './uniform-layout'
import type { GpuPreviewParams } from './uniforms'
import { DEFAULT_PARAMS, packUniforms } from './uniforms'

function packedBytes(pack: (view: DataView) => void): number[] {
  const data = new ArrayBuffer(UNIFORM_BUFFER_SIZE)
  pack(new DataView(data))
  return [...new Uint8Array(data)]
}

const LOOK: ColorGraphIntent = {
  ...pickColorGraphIntent(DEFAULT_PARAMS),
  styleKind: 'builtin',
  builtinPreset: 'film-soft',
  intensity: 0.37,
  userContrast: 12,
  userSaturation: -8,
}

describe('webGPU uniform ABI', () => {
  it('stores matrix columns at sixteen-byte strides without corrupting padding', () => {
    const data = new ArrayBuffer(UNIFORM_BUFFER_SIZE)
    const view = new DataView(data)
    writeUniformMat3x3f(
      view,
      'inputToLutGamut',
      new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9]),
    )
    expect([...new Float32Array(data, 0, 12)]).toEqual([
      1, 2, 3, 0, 4, 5, 6, 0, 7, 8, 9, 0,
    ])
    expect(UNIFORM_BUFFER_SIZE % 16).toBe(0)
  })
  it('packs integer control fields, exposure and neutral adjustments with independent offsets', () => {
    const view = new DataView(new ArrayBuffer(UNIFORM_BUFFER_SIZE))
    packUniforms(
      view,
      {
        ...DEFAULT_PARAMS,
        styleKind: 'builtin',
        builtinPreset: 'mono',
        userExposureEv: 2,
      },
      null,
      4,
      true,
    )
    const f = (name: string) =>
      view.getFloat32(UNIFORM_FIELDS[name].offset, true)
    const i = (name: string) => view.getInt32(UNIFORM_FIELDS[name].offset, true)
    expect(f('rawRenderExposureMultiplier')).toBe(4)
    expect(f('userExposureMultiplier')).toBe(4)
    expect([
      i('viewMode'),
      i('styleKind'),
      i('builtinPreset'),
      i('useLut'),
      i('selectiveColorActive'),
    ]).toEqual([0, 1, 7, 0, 1])
    expect(f('userColorBalanceGain')).toBe(1)
    expect(f('userSaturation')).toBe(0)
  })

  it('lays every host field out at the offset the WGSL struct declares', () => {
    expect(UNIFORM_FIELDS).toEqual({
      inputToLutGamut: { offset: 0, type: 'mat3x3f' },
      lutOutputToDisplayGamut: { offset: 48, type: 'mat3x3f' },
      lutDomainMin: { offset: 96, type: 'vec3f' },
      intensity: { offset: 108, type: 'f32' },
      lutDomainMax: { offset: 112, type: 'vec3f' },
      rawRenderExposureMultiplier: { offset: 124, type: 'f32' },
      userColorBalanceGain: { offset: 128, type: 'vec3f' },
      userExposureMultiplier: { offset: 140, type: 'f32' },
      userContrastAmount: { offset: 144, type: 'f32' },
      userContrastFactor: { offset: 148, type: 'f32' },
      userHighlights: { offset: 152, type: 'f32' },
      userShadows: { offset: 156, type: 'f32' },
      userWhites: { offset: 160, type: 'f32' },
      userBlacks: { offset: 164, type: 'f32' },
      userSaturation: { offset: 168, type: 'f32' },
      userVibrance: { offset: 172, type: 'f32' },
      selectiveColorChromaClamp: { offset: 176, type: 'vec2f' },
      lutSize: { offset: 184, type: 'f32' },
      viewMode: { offset: 188, type: 'i32' },
      styleKind: { offset: 192, type: 'i32' },
      builtinPreset: { offset: 196, type: 'i32' },
      useLut: { offset: 200, type: 'i32' },
      lutInputTransfer: { offset: 204, type: 'i32' },
      lutOutputTransfer: { offset: 208, type: 'i32' },
      lutRole: { offset: 212, type: 'i32' },
      lutInputRange: { offset: 216, type: 'i32' },
      lutOutputRange: { offset: 220, type: 'i32' },
      selectiveColorActive: { offset: 224, type: 'i32' },
    })
    expect(UNIFORM_BUFFER_SIZE).toBe(240)
  })
})

describe('webGPU output selector', () => {
  const packedOutput = (output: GpuPreviewParams['output']) =>
    packedBytes((view) =>
      packUniforms(
        view,
        { ...DEFAULT_PARAMS, ...LOOK, output },
        null,
        2,
        false,
      ),
    )

  it('selects the technical original without rewriting the color intent', () => {
    const offset = UNIFORM_FIELDS.viewMode.offset
    const selector = (bytes: number[]) =>
      new DataView(new Uint8Array(bytes).buffer).getInt32(offset, true)
    const withoutSelector = (bytes: number[]) => [
      ...bytes.slice(0, offset),
      ...bytes.slice(offset + 4),
    ]
    const processed = packedOutput('processed')
    const original = packedOutput('technical-original')
    expect([selector(processed), selector(original)]).toEqual([0, 1])
    expect(withoutSelector(original)).toEqual(withoutSelector(processed))
  })

  it('carries no compare split to the GPU', () => {
    expect(UNIFORM_FIELDS).not.toHaveProperty('compareSplit')
    expectTypeOf<GpuPreviewParams>().not.toHaveProperty('compareSplit')
  })
})

describe('webGPU color intent', () => {
  it('requires the complete color intent at every executor boundary', () => {
    expectTypeOf<GpuPreviewParams>().toMatchTypeOf<ColorGraphIntent>()
    expectTypeOf<GpuPreviewParams['selectiveColor']>().toEqualTypeOf<
      ColorGraphIntent['selectiveColor']
    >()
    expectTypeOf(getShaderSpecialization)
      .parameter(0)
      .toEqualTypeOf<ColorGraphIntent>()
    expectTypeOf(resolveGpuPreviewLook)
      .parameter(0)
      .toEqualTypeOf<ColorGraphIntent>()
    expectTypeOf<WebGPUImages['updateSelectiveColor']>()
      .parameter(0)
      .toEqualTypeOf<ColorGraphIntent['selectiveColor']>()
  })

  it('starts the pipeline on the processed output and neutral HSL bands', () => {
    expect(DEFAULT_PARAMS.output).toBe('processed')
    expect(DEFAULT_PARAMS.selectiveColor).toBe(NEUTRAL_SELECTIVE_COLOR)
  })
})

const ADJUSTED: GpuPreviewParams = {
  ...DEFAULT_PARAMS,
  ...NEUTRAL_USER_COLOR_INTENT,
  styleKind: 'custom',
  userExposureEv: 0.6,
  userContrast: 22,
  userHighlights: -30,
  userShadows: 18,
  userTemperature: 14,
  userTint: -9,
  userSaturation: 12,
  userVibrance: 17,
  selectiveColor: {
    ...NEUTRAL_SELECTIVE_COLOR,
    orange: { hue: 10, saturation: -20, lightness: 5 },
  },
}

function profile(overrides: Partial<LUTColorProfile> = {}): LUTColorProfile {
  return {
    id: 'test-display-look',
    label: 'Test display look',
    role: 'display-look',
    inputGamut: 'srgb-rec709',
    inputTransfer: 'srgb',
    inputRange: 'full',
    outputGamut: 'srgb-rec709',
    outputTransfer: 'srgb',
    outputRange: 'full',
    aliases: [],
    ...overrides,
  }
}

function lutData(profileResolution: LUTContractResolution): LUTData {
  const cube = `LUT_3D_SIZE 2\n${'0.5 0.5 0.5\n'.repeat(8)}`
  return { ...toLUTData(parseCubeLUT(cube)), profileResolution }
}

const confirmed = (overrides: Partial<LUTColorProfile> = {}) =>
  lutData({
    kind: 'confirmed',
    confidence: 'user',
    profile: profile(overrides),
  })

const REFUSED_LUTS: Array<[string, LUTData]> = [
  [
    'a display look with a linear output',
    confirmed({ outputTransfer: 'linear' }),
  ],
  [
    'a technical output with a linear output',
    confirmed({
      role: 'technical-output',
      inputGamut: 'rec2020',
      inputTransfer: 'acescct',
      outputGamut: 'rec2020',
      outputTransfer: 'linear',
    }),
  ],
  [
    'a display look with an unknown output range',
    confirmed({ outputRange: 'unknown' }),
  ],
  [
    'a combined output without an output transfer',
    confirmed({
      role: 'combined-look-output',
      inputGamut: 'rec2020',
      inputTransfer: 's-log3',
      outputTransfer: undefined,
    }),
  ],
  [
    'an unconfirmed contract',
    lutData({ kind: 'recommended', recommendations: [profile()] }),
  ],
  ['an unknown contract', lutData({ kind: 'unknown' })],
  [
    'an unsupported output',
    lutData({ kind: 'unsupported-output', recommendations: [] }),
  ],
]

/** The selection with the look removed: what the preview draws for it. */
function stripped(params: GpuPreviewParams): GpuPreviewParams {
  return { ...params, styleKind: 'none', builtinPreset: null, intensity: 0 }
}

function packed(params: GpuPreviewParams, lut: LUTData | null) {
  return packedBytes((view) => packUniforms(view, params, lut, 1.7, true))
}

describe('webGPU preview of a look export refuses', () => {
  for (const [label, lut] of REFUSED_LUTS) {
    for (const intensity of [0, 0.37, 1]) {
      it(`drops ${label} at strength ${intensity} and keeps the user color`, () => {
        const params = Object.freeze({ ...ADJUSTED, intensity })
        // Export keeps refusing the selection the preview leaves out.
        expect(resolveExportColorGraph({ ...params, lut }).supported).toBe(
          false,
        )
        expect(packed(params, lut)).toEqual(packed(stripped(params), null))
        expect(getShaderSpecialization(params, lut)).toEqual(
          getShaderSpecialization(stripped(params), null),
        )
      })
    }
  }

  it('draws a contract export accepts at a continuous strength', () => {
    const lut = confirmed()
    const params = { ...ADJUSTED, intensity: 0.37 }
    expect(resolveExportColorGraph({ ...params, lut }).supported).toBe(true)
    const view = new DataView(new Uint8Array(packed(params, lut)).buffer)
    const i = (name: string) => view.getInt32(UNIFORM_FIELDS[name].offset, true)
    expect([i('styleKind'), i('useLut')]).toEqual([2, 1])
    expect(view.getFloat32(UNIFORM_FIELDS.intensity.offset, true)).toBe(
      Math.fround(0.37),
    )
    expect(getShaderSpecialization(params, lut)).toMatchObject({
      styleKind: 2,
      useLut: true,
    })
  })

  it('draws the selected built-in preset, which only WebGPU implements', () => {
    const params = { ...LOOK, output: 'processed' } as const
    const view = new DataView(new Uint8Array(packed(params, null)).buffer)
    const i = (name: string) => view.getInt32(UNIFORM_FIELDS[name].offset, true)
    expect([i('styleKind'), i('builtinPreset')]).toEqual([1, 3])
    expect(view.getFloat32(UNIFORM_FIELDS.intensity.offset, true)).toBe(
      Math.fround(0.37),
    )
  })

  it('draws no style for a built-in selection without a preset, as export does', () => {
    const params = {
      ...ADJUSTED,
      styleKind: 'builtin',
      intensity: 0.6,
    } as const
    expect(resolveExportColorGraph({ ...params, lut: null }).supported).toBe(
      true,
    )
    expect(packed(params, null)).toEqual(packed(stripped(params), null))
  })

  it('degrades to the adjusted image without a look after a LUT upload failure', () => {
    // A failed upload leaves the pipeline with no LUT for the custom selection.
    const params = { ...ADJUSTED, intensity: 0.8 }
    expect(packed(params, null)).toEqual(packed(stripped(params), null))
    expect(getShaderSpecialization(params, null)).toEqual(
      getShaderSpecialization(stripped(params), null),
    )
  })
})
