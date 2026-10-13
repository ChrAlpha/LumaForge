import type { SupportedExportColorGraphDescriptor } from './color-graph'
import { compressLutInputToDomain } from './lut-domain'
import { mix, sampleLutTrilinear } from './lut3d'
import { getGamutMatrix } from './matrix'
import { getTransferFunction } from './registry'
import { applyUserSaturationTo } from './saturation'
import type { PreparedSelectiveColorLut } from './selective-color'
import {
  applySelectiveColorRow,
  LUT_SIZE as SELECTIVE_COLOR_LUT_SIZE,
  resolveSelectiveColorParams,
} from './selective-color'
import { regionalToneScaleFromLuminance } from './tone'

const CHANNELS_PER_PIXEL = 3
const UINT16_MAX = 65535

function clamp01(value: number) {
  if (value <= 0) return 0
  if (value >= 1) return 1
  return value
}

function clampMin0(value: number) {
  return value < 0 ? 0 : value
}

function linearToSrgb(linear: number) {
  const clamped = clampMin0(linear)
  return clamped <= 0.0031308
    ? clamped * 12.92
    : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055
}

function toSrgbByte(linear: number) {
  return Math.round(clamp01(linearToSrgb(linear)) * 255)
}

function toEncodedByte(encoded: number) {
  return Math.round(clamp01(encoded) * 255)
}

const LEGAL_RANGE_SCALE = (940 - 64) / 1023
const LEGAL_RANGE_OFFSET = 64 / 1023
const LEGAL_RANGE_INV_SCALE = 1023 / (940 - 64)
const PROPHOTO_TO_SRGB_MATRIX = getGamutMatrix('prophoto-rgb', 'srgb-rec709')

function applySignalRangeForLutInput(value: number, isLegalRange: boolean) {
  if (!isLegalRange) return value
  return value * LEGAL_RANGE_SCALE + LEGAL_RANGE_OFFSET
}

function removeSignalRangeFromLutOutput(value: number, isLegalRange: boolean) {
  if (!isLegalRange) return value
  return (value - LEGAL_RANGE_OFFSET) * LEGAL_RANGE_INV_SCALE
}

function normalizeLutSample(
  value: number,
  domainMin: number,
  inverseDomainSpan: number,
) {
  if (inverseDomainSpan === 0) return 0
  return clamp01((value - domainMin) * inverseDomainSpan)
}

type UserColorBalanceStep = Extract<
  SupportedExportColorGraphDescriptor['steps'][number],
  { kind: 'user-color-balance' }
>

type UserSelectiveColorStep = Extract<
  SupportedExportColorGraphDescriptor['steps'][number],
  { kind: 'user-selective-color' }
>

type UserSaturationStep = Extract<
  SupportedExportColorGraphDescriptor['steps'][number],
  { kind: 'user-saturation' }
>

function isSimpleNoLutGraph(
  graph: SupportedExportColorGraphDescriptor,
): graph is SupportedExportColorGraphDescriptor & {
  steps: [
    { kind: 'input-linear-prophoto' },
    Extract<
      SupportedExportColorGraphDescriptor['steps'][number],
      { kind: 'raw-render-exposure' }
    >,
    UserColorBalanceStep,
    Extract<
      SupportedExportColorGraphDescriptor['steps'][number],
      { kind: 'user-exposure' }
    >,
    Extract<
      SupportedExportColorGraphDescriptor['steps'][number],
      { kind: 'user-contrast' }
    >,
    Extract<
      SupportedExportColorGraphDescriptor['steps'][number],
      { kind: 'user-regional-tone' }
    >,
    UserSaturationStep,
    UserSelectiveColorStep,
    { kind: 'output-srgb' },
  ]
} {
  return (
    graph.lutProfile === null &&
    graph.steps.length === 9 &&
    graph.steps[0]?.kind === 'input-linear-prophoto' &&
    graph.steps[1]?.kind === 'raw-render-exposure' &&
    graph.steps[2]?.kind === 'user-color-balance' &&
    graph.steps[3]?.kind === 'user-exposure' &&
    graph.steps[4]?.kind === 'user-contrast' &&
    graph.steps[5]?.kind === 'user-regional-tone' &&
    graph.steps[6]?.kind === 'user-saturation' &&
    graph.steps[7]?.kind === 'user-selective-color' &&
    graph.steps[8]?.kind === 'output-srgb'
  )
}

function isSupportedLutGraph(
  graph: SupportedExportColorGraphDescriptor,
): graph is SupportedExportColorGraphDescriptor & {
  steps: [
    { kind: 'input-linear-prophoto' },
    Extract<
      SupportedExportColorGraphDescriptor['steps'][number],
      { kind: 'raw-render-exposure' }
    >,
    UserColorBalanceStep,
    Extract<
      SupportedExportColorGraphDescriptor['steps'][number],
      { kind: 'user-exposure' }
    >,
    Extract<
      SupportedExportColorGraphDescriptor['steps'][number],
      { kind: 'user-contrast' }
    >,
    Extract<
      SupportedExportColorGraphDescriptor['steps'][number],
      { kind: 'user-regional-tone' }
    >,
    UserSaturationStep,
    UserSelectiveColorStep,
    Extract<
      SupportedExportColorGraphDescriptor['steps'][number],
      { kind: 'gamut-to-lut-input' }
    >,
    Extract<
      SupportedExportColorGraphDescriptor['steps'][number],
      { kind: 'encode-lut-transfer' }
    >,
    Extract<
      SupportedExportColorGraphDescriptor['steps'][number],
      { kind: 'lut3d' }
    >,
    Extract<
      SupportedExportColorGraphDescriptor['steps'][number],
      { kind: 'lut-output-to-srgb' }
    >,
    { kind: 'output-srgb' },
  ]
} {
  return (
    graph.steps.length === 13 &&
    graph.steps[0]?.kind === 'input-linear-prophoto' &&
    graph.steps[1]?.kind === 'raw-render-exposure' &&
    graph.steps[2]?.kind === 'user-color-balance' &&
    graph.steps[3]?.kind === 'user-exposure' &&
    graph.steps[4]?.kind === 'user-contrast' &&
    graph.steps[5]?.kind === 'user-regional-tone' &&
    graph.steps[6]?.kind === 'user-saturation' &&
    graph.steps[7]?.kind === 'user-selective-color' &&
    graph.steps[8]?.kind === 'gamut-to-lut-input' &&
    graph.steps[9]?.kind === 'encode-lut-transfer' &&
    graph.steps[10]?.kind === 'lut3d' &&
    graph.steps[11]?.kind === 'lut-output-to-srgb' &&
    graph.steps[12]?.kind === 'output-srgb'
  )
}

function getRawRenderExposureMultiplier(
  step: Extract<
    SupportedExportColorGraphDescriptor['steps'][number],
    { kind: 'raw-render-exposure' }
  >,
) {
  return Number.isFinite(step.multiplier) ? step.multiplier : 1
}

function getUserColorBalanceGain(
  step: UserColorBalanceStep,
): readonly [number, number, number] {
  return [
    Number.isFinite(step.gain[0]) ? step.gain[0] : 1,
    Number.isFinite(step.gain[1]) ? step.gain[1] : 1,
    Number.isFinite(step.gain[2]) ? step.gain[2] : 1,
  ]
}

type UserExposureStep = Extract<
  SupportedExportColorGraphDescriptor['steps'][number],
  { kind: 'user-exposure' }
>
type UserContrastStep = Extract<
  SupportedExportColorGraphDescriptor['steps'][number],
  { kind: 'user-contrast' }
>
type UserRegionalToneStep = Extract<
  SupportedExportColorGraphDescriptor['steps'][number],
  { kind: 'user-regional-tone' }
>

function getUserExposureMultiplier(step: UserExposureStep) {
  return Number.isFinite(step.multiplier) ? step.multiplier : 1
}

type MutableRgb = [number, number, number]

function applyUserContrastScalarTo(
  r: number,
  g: number,
  b: number,
  step: UserContrastStep,
  out: MutableRgb,
) {
  if (step.amount === 0) {
    out[0] = r
    out[1] = g
    out[2] = b
    return out
  }

  const positiveR = Math.max(r, 0)
  const positiveG = Math.max(g, 0)
  const positiveB = Math.max(b, 0)
  const y =
    step.luminanceCoefficients[0] * positiveR +
    step.luminanceCoefficients[1] * positiveG +
    step.luminanceCoefficients[2] * positiveB
  if (y <= 0) {
    out[0] = 0
    out[1] = 0
    out[2] = 0
    return out
  }

  const targetY = step.pivot * Math.pow(y / step.pivot, step.factor)
  const scale = targetY / y
  out[0] = positiveR * scale
  out[1] = positiveG * scale
  out[2] = positiveB * scale
  return out
}

function hasRegionalTone(step: UserRegionalToneStep) {
  return (
    step.highlights !== 0 ||
    step.shadows !== 0 ||
    step.whites !== 0 ||
    step.blacks !== 0
  )
}

function applyUserRegionalToneScalarTo(
  r: number,
  g: number,
  b: number,
  step: UserRegionalToneStep,
  out: MutableRgb,
) {
  if (!hasRegionalTone(step)) {
    out[0] = r
    out[1] = g
    out[2] = b
    return out
  }

  const positiveR = Math.max(r, 0)
  const positiveG = Math.max(g, 0)
  const positiveB = Math.max(b, 0)
  const y =
    step.luminanceCoefficients[0] * positiveR +
    step.luminanceCoefficients[1] * positiveG +
    step.luminanceCoefficients[2] * positiveB
  const scale = regionalToneScaleFromLuminance(y, {
    highlights: step.highlights,
    shadows: step.shadows,
    whites: step.whites,
    blacks: step.blacks,
    pivot: step.pivot,
  })

  out[0] = positiveR * scale
  out[1] = positiveG * scale
  out[2] = positiveB * scale
  return out
}

type SelectiveColorContext = {
  step: UserSelectiveColorStep
  lutBuffer: Float32Array
  prepared: PreparedSelectiveColorLut
  bandsRef: UserSelectiveColorStep['bands'] | null
}

function createSelectiveColorContext(
  step: UserSelectiveColorStep,
): SelectiveColorContext {
  const lutBuffer = new Float32Array(4 * SELECTIVE_COLOR_LUT_SIZE)
  return {
    step,
    lutBuffer,
    prepared: {
      bands: step.bands,
      buffer: lutBuffer,
      constantsVersion: step.constantsVersion,
    },
    bandsRef: null,
  }
}

function allBandsNeutral(step: UserSelectiveColorStep) {
  const bands = step.bands
  for (const id of [
    'red',
    'orange',
    'yellow',
    'green',
    'aqua',
    'blue',
    'purple',
    'magenta',
  ] as const) {
    const band = bands[id]
    if (band.hue !== 0 || band.saturation !== 0 || band.lightness !== 0) {
      return false
    }
  }
  return true
}

function ensureSelectiveColorPrepared(context: SelectiveColorContext) {
  const bands = context.step.bands
  if (context.bandsRef === bands) {
    return context.prepared
  }
  const { prepared } = resolveSelectiveColorParams(
    { selectiveColor: bands },
    context.lutBuffer,
  )
  context.prepared = prepared
  context.bandsRef = bands
  return prepared
}

function applySelectiveColorToSceneScratch(
  sceneScratch: Float32Array,
  pixelLength: number,
  context: SelectiveColorContext,
) {
  // All-neutral bands are mathematically identity, but the OKLab roundtrip
  // inside applySelectiveColorRow introduces ~1 ULP drift in linear ProPhoto.
  // That drift can flip a 1-byte boundary in the downstream sRGB byte at
  // tightly-clamped LUT domains, breaking byte-exact precision contracts.
  // Skip the apply when every band is neutral to preserve byte-exactness.
  if (allBandsNeutral(context.step)) {
    return
  }
  const prepared = ensureSelectiveColorPrepared(context)
  const view = sceneScratch.subarray(0, pixelLength)
  applySelectiveColorRow(
    view,
    view,
    prepared,
    context.step.chromaClampLow,
    context.step.chromaClampHigh,
  )
}

type GraphApplier = (
  linear: Float32Array,
  bytes: Uint8Array,
  sceneScratch: Float32Array,
) => void

function compileGraphApplier(
  graph: SupportedExportColorGraphDescriptor,
): GraphApplier {
  if (isSimpleNoLutGraph(graph)) {
    const rawRenderExposureMultiplier = getRawRenderExposureMultiplier(
      graph.steps[1],
    )
    const colorBalanceGain = getUserColorBalanceGain(graph.steps[2])
    const exposureMultiplier = getUserExposureMultiplier(graph.steps[3])
    const contrastStep = graph.steps[4]
    const regionalToneStep = graph.steps[5]
    const saturationStep = graph.steps[6]
    const isSatIdentity =
      saturationStep.saturation === 0 && saturationStep.vibrance === 0
    const selectiveColorContext = createSelectiveColorContext(graph.steps[7])
    const toneScratch: MutableRgb = [0, 0, 0]

    return (linear, bytes, sceneScratch) => {
      const length = linear.length
      for (let index = 0; index < length; index += 3) {
        const baseR = (linear[index] ?? 0) * rawRenderExposureMultiplier
        const baseG = (linear[index + 1] ?? 0) * rawRenderExposureMultiplier
        const baseB = (linear[index + 2] ?? 0) * rawRenderExposureMultiplier
        const exposedR = baseR * colorBalanceGain[0] * exposureMultiplier
        const exposedG = baseG * colorBalanceGain[1] * exposureMultiplier
        const exposedB = baseB * colorBalanceGain[2] * exposureMultiplier
        const contrasted = applyUserContrastScalarTo(
          exposedR,
          exposedG,
          exposedB,
          contrastStep,
          toneScratch,
        )
        const scene = applyUserRegionalToneScalarTo(
          contrasted[0],
          contrasted[1],
          contrasted[2],
          regionalToneStep,
          toneScratch,
        )
        sceneScratch[index] = scene[0]
        sceneScratch[index + 1] = scene[1]
        sceneScratch[index + 2] = scene[2]
      }

      if (!isSatIdentity) {
        for (let index = 0; index < length; index += 3) {
          applyUserSaturationTo(
            sceneScratch,
            index,
            saturationStep.saturation,
            saturationStep.vibrance,
          )
        }
      }

      applySelectiveColorToSceneScratch(
        sceneScratch,
        length,
        selectiveColorContext,
      )

      for (let index = 0; index < length; index += 3) {
        const sceneR = sceneScratch[index]
        const sceneG = sceneScratch[index + 1]
        const sceneB = sceneScratch[index + 2]
        const displayLinearR = clampMin0(
          PROPHOTO_TO_SRGB_MATRIX[0] * sceneR +
            PROPHOTO_TO_SRGB_MATRIX[1] * sceneG +
            PROPHOTO_TO_SRGB_MATRIX[2] * sceneB,
        )
        const displayLinearG = clampMin0(
          PROPHOTO_TO_SRGB_MATRIX[3] * sceneR +
            PROPHOTO_TO_SRGB_MATRIX[4] * sceneG +
            PROPHOTO_TO_SRGB_MATRIX[5] * sceneB,
        )
        const displayLinearB = clampMin0(
          PROPHOTO_TO_SRGB_MATRIX[6] * sceneR +
            PROPHOTO_TO_SRGB_MATRIX[7] * sceneG +
            PROPHOTO_TO_SRGB_MATRIX[8] * sceneB,
        )
        bytes[index] = toSrgbByte(displayLinearR)
        bytes[index + 1] = toSrgbByte(displayLinearG)
        bytes[index + 2] = toSrgbByte(displayLinearB)
      }
    }
  }

  if (!isSupportedLutGraph(graph)) {
    throw new Error('FULL_RES_EXPORT_UNSUPPORTED_PIPELINE')
  }

  const rawRenderExposureMultiplier = getRawRenderExposureMultiplier(
    graph.steps[1],
  )
  const colorBalanceGain = getUserColorBalanceGain(graph.steps[2])
  const exposureMultiplier = getUserExposureMultiplier(graph.steps[3])
  const contrastStep = graph.steps[4]
  const regionalToneStep = graph.steps[5]
  const saturationStep = graph.steps[6]
  const isSatIdentity =
    saturationStep.saturation === 0 && saturationStep.vibrance === 0
  const selectiveColorContext = createSelectiveColorContext(graph.steps[7])
  const inputMatrix = graph.steps[8].matrix
  const encodeStep = graph.steps[9]
  const lutStep = graph.steps[10]
  const outputStep = graph.steps[11]
  const outputMatrix = outputStep.matrix
  const encodeTransfer = getTransferFunction(encodeStep.transfer)
  const decodeTransfer = getTransferFunction(outputStep.transfer)
  if (!encodeTransfer || !decodeTransfer) {
    throw new Error('FULL_RES_EXPORT_UNSUPPORTED_PIPELINE')
  }

  const inputIsLegalRange = encodeStep.range === 'legal'
  const outputIsLegalRange = outputStep.range === 'legal'
  const role = outputStep.role
  const intensity = outputStep.intensity
  const domainMin = lutStep.domainMin
  const domainMax = lutStep.domainMax
  const inverseDomainSpanR =
    domainMax[0] === domainMin[0] ? 0 : 1 / (domainMax[0] - domainMin[0])
  const inverseDomainSpanG =
    domainMax[1] === domainMin[1] ? 0 : 1 / (domainMax[1] - domainMin[1])
  const inverseDomainSpanB =
    domainMax[2] === domainMin[2] ? 0 : 1 / (domainMax[2] - domainMin[2])
  const toneScratch: MutableRgb = [0, 0, 0]
  const lutInputEncoded: MutableRgb = [0, 0, 0]
  const lutInputDomain: MutableRgb = [0, 0, 0]
  const lutSample: [number, number, number] = [0, 0, 0]

  return (linear, bytes, sceneScratch) => {
    const length = linear.length
    for (let index = 0; index < length; index += 3) {
      const baseR = (linear[index] ?? 0) * rawRenderExposureMultiplier
      const baseG = (linear[index + 1] ?? 0) * rawRenderExposureMultiplier
      const baseB = (linear[index + 2] ?? 0) * rawRenderExposureMultiplier
      const exposedR = baseR * colorBalanceGain[0] * exposureMultiplier
      const exposedG = baseG * colorBalanceGain[1] * exposureMultiplier
      const exposedB = baseB * colorBalanceGain[2] * exposureMultiplier
      const contrasted = applyUserContrastScalarTo(
        exposedR,
        exposedG,
        exposedB,
        contrastStep,
        toneScratch,
      )
      const scene = applyUserRegionalToneScalarTo(
        contrasted[0],
        contrasted[1],
        contrasted[2],
        regionalToneStep,
        toneScratch,
      )
      sceneScratch[index] = scene[0]
      sceneScratch[index + 1] = scene[1]
      sceneScratch[index + 2] = scene[2]
    }

    if (!isSatIdentity) {
      for (let index = 0; index < length; index += 3) {
        applyUserSaturationTo(
          sceneScratch,
          index,
          saturationStep.saturation,
          saturationStep.vibrance,
        )
      }
    }

    applySelectiveColorToSceneScratch(
      sceneScratch,
      length,
      selectiveColorContext,
    )

    for (let index = 0; index < length; index += 3) {
      const sceneR = sceneScratch[index]
      const sceneG = sceneScratch[index + 1]
      const sceneB = sceneScratch[index + 2]

      const baseDisplayLinearR = clampMin0(
        PROPHOTO_TO_SRGB_MATRIX[0] * sceneR +
          PROPHOTO_TO_SRGB_MATRIX[1] * sceneG +
          PROPHOTO_TO_SRGB_MATRIX[2] * sceneB,
      )
      const baseDisplayLinearG = clampMin0(
        PROPHOTO_TO_SRGB_MATRIX[3] * sceneR +
          PROPHOTO_TO_SRGB_MATRIX[4] * sceneG +
          PROPHOTO_TO_SRGB_MATRIX[5] * sceneB,
      )
      const baseDisplayLinearB = clampMin0(
        PROPHOTO_TO_SRGB_MATRIX[6] * sceneR +
          PROPHOTO_TO_SRGB_MATRIX[7] * sceneG +
          PROPHOTO_TO_SRGB_MATRIX[8] * sceneB,
      )

      let lutInputLinearR = baseDisplayLinearR
      let lutInputLinearG = baseDisplayLinearG
      let lutInputLinearB = baseDisplayLinearB

      if (role !== 'display-look' && inputMatrix) {
        lutInputLinearR =
          inputMatrix[0] * sceneR +
          inputMatrix[1] * sceneG +
          inputMatrix[2] * sceneB
        lutInputLinearG =
          inputMatrix[3] * sceneR +
          inputMatrix[4] * sceneG +
          inputMatrix[5] * sceneB
        lutInputLinearB =
          inputMatrix[6] * sceneR +
          inputMatrix[7] * sceneG +
          inputMatrix[8] * sceneB
      }

      lutInputEncoded[0] = applySignalRangeForLutInput(
        encodeTransfer.encode(lutInputLinearR),
        inputIsLegalRange,
      )
      lutInputEncoded[1] = applySignalRangeForLutInput(
        encodeTransfer.encode(lutInputLinearG),
        inputIsLegalRange,
      )
      lutInputEncoded[2] = applySignalRangeForLutInput(
        encodeTransfer.encode(lutInputLinearB),
        inputIsLegalRange,
      )
      compressLutInputToDomain(
        lutInputEncoded,
        domainMin,
        domainMax,
        lutInputDomain,
      )

      sampleLutTrilinear(
        lutStep.data,
        lutStep.size,
        normalizeLutSample(lutInputDomain[0], domainMin[0], inverseDomainSpanR),
        normalizeLutSample(lutInputDomain[1], domainMin[1], inverseDomainSpanG),
        normalizeLutSample(lutInputDomain[2], domainMin[2], inverseDomainSpanB),
        lutSample,
      )

      const lutOutputLinearR = decodeTransfer.decode(
        removeSignalRangeFromLutOutput(lutSample[0], outputIsLegalRange),
      )
      const lutOutputLinearG = decodeTransfer.decode(
        removeSignalRangeFromLutOutput(lutSample[1], outputIsLegalRange),
      )
      const lutOutputLinearB = decodeTransfer.decode(
        removeSignalRangeFromLutOutput(lutSample[2], outputIsLegalRange),
      )

      const styledDisplayLinearR = clampMin0(
        outputMatrix[0] * lutOutputLinearR +
          outputMatrix[1] * lutOutputLinearG +
          outputMatrix[2] * lutOutputLinearB,
      )
      const styledDisplayLinearG = clampMin0(
        outputMatrix[3] * lutOutputLinearR +
          outputMatrix[4] * lutOutputLinearG +
          outputMatrix[5] * lutOutputLinearB,
      )
      const styledDisplayLinearB = clampMin0(
        outputMatrix[6] * lutOutputLinearR +
          outputMatrix[7] * lutOutputLinearG +
          outputMatrix[8] * lutOutputLinearB,
      )

      if (role === 'scene-creative') {
        bytes[index] = toSrgbByte(
          mix(baseDisplayLinearR, styledDisplayLinearR, intensity),
        )
        bytes[index + 1] = toSrgbByte(
          mix(baseDisplayLinearG, styledDisplayLinearG, intensity),
        )
        bytes[index + 2] = toSrgbByte(
          mix(baseDisplayLinearB, styledDisplayLinearB, intensity),
        )
        continue
      }

      const baseDisplayColorR = linearToSrgb(baseDisplayLinearR)
      const baseDisplayColorG = linearToSrgb(baseDisplayLinearG)
      const baseDisplayColorB = linearToSrgb(baseDisplayLinearB)
      const styledDisplayColorR = linearToSrgb(styledDisplayLinearR)
      const styledDisplayColorG = linearToSrgb(styledDisplayLinearG)
      const styledDisplayColorB = linearToSrgb(styledDisplayLinearB)

      bytes[index] = toEncodedByte(
        mix(baseDisplayColorR, styledDisplayColorR, intensity),
      )
      bytes[index + 1] = toEncodedByte(
        mix(baseDisplayColorG, styledDisplayColorG, intensity),
      )
      bytes[index + 2] = toEncodedByte(
        mix(baseDisplayColorB, styledDisplayColorB, intensity),
      )
    }
  }
}

export type RowBandProcessor = {
  rowBandRows: number
  reusesOutputBuffer: boolean
  processFloatRows: (source: Float32Array, rowCount: number) => Uint8Array
  processUint16Rows: (source: Uint16Array, rowCount: number) => Uint8Array
}

export type CreateRowBandProcessorInput = {
  width: number
  rowBandRows: number
  graph: SupportedExportColorGraphDescriptor
}

function assertPositiveSafeInteger(value: number, errorCode: string) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(errorCode)
  }
}

function expectedRowLength(width: number, rowCount: number) {
  return width * rowCount * CHANNELS_PER_PIXEL
}

function validateRows(
  sourceLength: number,
  width: number,
  rowBandRows: number,
  rowCount: number,
) {
  assertPositiveSafeInteger(rowCount, 'ROW_BAND_PROCESSOR_INVALID_ROW_COUNT')
  if (rowCount > rowBandRows) {
    throw new Error('ROW_BAND_PROCESSOR_INVALID_ROW_COUNT')
  }

  const expectedLength = expectedRowLength(width, rowCount)
  if (
    !Number.isSafeInteger(expectedLength) ||
    sourceLength !== expectedLength
  ) {
    throw new Error('ROW_BAND_PROCESSOR_INVALID_SOURCE_LENGTH')
  }

  return expectedLength
}

export function createRowBandProcessor({
  width,
  rowBandRows,
  graph,
}: CreateRowBandProcessorInput): RowBandProcessor {
  assertPositiveSafeInteger(width, 'ROW_BAND_PROCESSOR_INVALID_WIDTH')
  assertPositiveSafeInteger(
    rowBandRows,
    'ROW_BAND_PROCESSOR_INVALID_ROW_BAND_ROWS',
  )

  const maxLength = expectedRowLength(width, rowBandRows)
  if (!Number.isSafeInteger(maxLength)) {
    throw new TypeError('ROW_BAND_PROCESSOR_INVALID_ROW_BAND_ROWS')
  }

  const applyGraph = compileGraphApplier(graph)
  const floatScratch = new Float32Array(maxLength)
  const sceneScratch = new Float32Array(maxLength)
  const rgb8Scratch = new Uint8Array(maxLength)

  function processFloatRows(source: Float32Array, rowCount: number) {
    const length = validateRows(source.length, width, rowBandRows, rowCount)
    const rows = rgb8Scratch.subarray(0, length)
    applyGraph(source, rows, sceneScratch)
    return rows
  }

  function processUint16Rows(source: Uint16Array, rowCount: number) {
    const length = validateRows(source.length, width, rowBandRows, rowCount)
    for (let index = 0; index < length; index += 1) {
      floatScratch[index] = (source[index] ?? 0) / UINT16_MAX
    }

    return processFloatRows(floatScratch.subarray(0, length), rowCount)
  }

  return {
    rowBandRows,
    reusesOutputBuffer: true,
    processFloatRows,
    processUint16Rows,
  }
}
