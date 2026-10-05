import { resolveColorBalanceParams } from './color-balance'
import type { SupportedExportColorGraphDescriptor } from './color-graph'
import type { Mat3 } from './matrix'
import { mat3Identity } from './matrix'
import type { LUTColorProfile } from './registry'
import { createRowBandProcessor } from './row-band-processor'
import {
  SKIN_HUE_CENTER_DEG,
  SKIN_HUE_SIGMA_DEG,
  SKIN_PROTECT_STRENGTH,
  USER_SATURATION_MAX_FACTOR,
  USER_VIBRANCE_MAX_FACTOR,
  VIBRANCE_CHROMA_REF,
} from './saturation'
import {
  CHROMA_CLAMP_HIGH,
  CHROMA_CLAMP_LOW,
  LUT_CONSTANTS_VERSION,
  makeNeutralBand,
} from './selective-color'

const BOUNDARY_PROFILE: LUTColorProfile = {
  id: 'test-linear-boundary-probe',
  label: 'Test Linear Boundary Probe',
  role: 'scene-creative',
  inputGamut: 'prophoto-rgb',
  inputTransfer: 'linear',
  inputRange: 'full',
  outputGamut: 'srgb-rec709',
  outputTransfer: 'linear',
  outputRange: 'full',
  aliases: [],
}

const neutralColorBalance = resolveColorBalanceParams()

function neutralToneSteps(): SupportedExportColorGraphDescriptor['steps'] {
  return [
    {
      kind: 'user-color-balance',
      temperature: neutralColorBalance.userTemperature,
      tint: neutralColorBalance.userTint,
      gain: neutralColorBalance.gain,
      operator: neutralColorBalance.operator,
      luminanceCoefficients: neutralColorBalance.luminanceCoefficients,
    },
    { kind: 'user-exposure', ev: 0, multiplier: 1 },
    {
      kind: 'user-contrast',
      amount: 0,
      factor: 1,
      pivot: 0.18,
      operator: 'linear-prophoto-luminance-scale',
      luminanceCoefficients: [0.2880402, 0.7118741, 0.0000857],
      zeroLuminanceMode: 'return-black',
    },
    {
      kind: 'user-regional-tone',
      highlights: 0,
      shadows: 0,
      whites: 0,
      blacks: 0,
      operator: 'linear-prophoto-log-luminance-regions',
      pivot: 0.18,
      luminanceCoefficients: [0.2880402, 0.7118741, 0.0000857],
      zeroLuminanceMode: 'return-black',
    },
    {
      kind: 'user-saturation',
      operator: 'oklab-chroma-with-skin-protection',
      saturation: 0,
      vibrance: 0,
      satMaxFactor: USER_SATURATION_MAX_FACTOR,
      vibMaxFactor: USER_VIBRANCE_MAX_FACTOR,
      chromaRef: VIBRANCE_CHROMA_REF,
      skinHueCenterDeg: SKIN_HUE_CENTER_DEG,
      skinHueSigmaDeg: SKIN_HUE_SIGMA_DEG,
      skinProtectStrength: SKIN_PROTECT_STRENGTH,
    },
    {
      kind: 'user-selective-color',
      bands: {
        red: makeNeutralBand(),
        orange: makeNeutralBand(),
        yellow: makeNeutralBand(),
        green: makeNeutralBand(),
        aqua: makeNeutralBand(),
        blue: makeNeutralBand(),
        purple: makeNeutralBand(),
        magenta: makeNeutralBand(),
      },
      chromaClampLow: CHROMA_CLAMP_LOW,
      chromaClampHigh: CHROMA_CLAMP_HIGH,
      workingSpace: 'oklab-via-prophoto-d65',
      operator: 'oklch-per-band-shift',
      constantsVersion: LUT_CONSTANTS_VERSION,
    },
  ]
}

function makeRedRampLut() {
  const lut = new Float32Array(2 * 2 * 2 * 3)

  for (let blue = 0; blue < 2; blue += 1) {
    for (let green = 0; green < 2; green += 1) {
      for (let red = 0; red < 2; red += 1) {
        const index = ((blue * 2 + green) * 2 + red) * 3
        lut[index] = red
        lut[index + 1] = red
        lut[index + 2] = red
      }
    }
  }

  return lut
}

function makeConstantLut(color: readonly [number, number, number]) {
  const lut = new Float32Array(2 * 2 * 2 * 3)

  for (let index = 0; index < lut.length; index += 3) {
    lut[index] = color[0]
    lut[index + 1] = color[1]
    lut[index + 2] = color[2]
  }

  return lut
}

function makeBoundaryGraph({
  data,
  domainMin = [0, 0, 0],
  domainMax = [1, 1, 1],
  inputMatrix = mat3Identity(),
  outputMatrix = mat3Identity(),
}: {
  data: Float32Array
  domainMin?: [number, number, number]
  domainMax?: [number, number, number]
  inputMatrix?: Mat3
  outputMatrix?: Mat3
}): SupportedExportColorGraphDescriptor {
  return {
    supported: true,
    outputGamut: 'srgb-rec709',
    outputTransfer: 'srgb',
    lutProfile: BOUNDARY_PROFILE,
    steps: [
      { kind: 'input-linear-prophoto' },
      { kind: 'raw-render-exposure', ev: 0, multiplier: 1 },
      ...neutralToneSteps(),
      {
        kind: 'gamut-to-lut-input',
        matrix: inputMatrix,
        gamut: 'prophoto-rgb',
      },
      { kind: 'encode-lut-transfer', transfer: 'linear', range: 'full' },
      { kind: 'lut3d', size: 2, data, domainMin, domainMax },
      {
        kind: 'lut-output-to-srgb',
        matrix: outputMatrix,
        transfer: 'linear',
        range: 'full',
        role: 'scene-creative',
        intensity: 1,
      },
      { kind: 'output-srgb' },
    ],
  }
}

function clamp01(value: number) {
  return Math.min(1, Math.max(0, value))
}

function linearToSrgb(linear: number) {
  const clamped = Math.max(0, linear)
  return clamped <= 0.0031308
    ? clamped * 12.92
    : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055
}

function toSrgbByte(linear: number) {
  return Math.round(clamp01(linearToSrgb(linear)) * 255)
}

describe('row band processor color boundaries', () => {
  it('preserves signed linear scene LUT input until declared domain sampling', () => {
    const processor = createRowBandProcessor({
      width: 1,
      rowBandRows: 1,
      graph: makeBoundaryGraph({
        data: makeRedRampLut(),
        domainMin: [-1, 0, 0],
        domainMax: [1, 1, 1],
      }),
    })

    const rows = processor.processFloatRows(new Float32Array([-0.5, 0, 0]), 1)

    expect(rows).toEqual(
      new Uint8Array([toSrgbByte(0.25), toSrgbByte(0.25), toSrgbByte(0.25)]),
    )
    expect(rows[0]).toBeLessThan(toSrgbByte(0.5))
  })

  it('preserves signed LUT output until the output gamut matrix is applied', () => {
    const processor = createRowBandProcessor({
      width: 1,
      rowBandRows: 1,
      graph: makeBoundaryGraph({
        data: makeConstantLut([-0.25, 0, 0]),
        outputMatrix: new Float32Array([-1, 0, 0, 0, 1, 0, 0, 0, 1]),
      }),
    })

    const rows = processor.processFloatRows(new Float32Array([0.5, 0, 0]), 1)

    expect(rows).toEqual(new Uint8Array([toSrgbByte(0.25), 0, 0]))
  })
})
