import type {
  ExportColorGraphStep,
  SupportedExportColorGraphDescriptor,
} from './color-graph'
import {
  EXPORT_HDR_LUT_STEP_KINDS,
  EXPORT_LUT_STEP_KINDS,
  EXPORT_PLAIN_STEP_KINDS,
} from './color-graph'
import { encodeHdrGainMapRows, resolveHdrGainMapSupport } from './hdr-gain-map'
import {
  createHdrDisplayLightDecoder,
  HDR_TO_SDR_TONE_MAP,
  toneMapHdrToSdr,
} from './hdr-output'
import type { HdrPreviewView } from './hdr-preview'
import { encodeHdrPreviewRows } from './hdr-preview'
import {
  HDR_NOMINAL_PEAK_NITS,
  HDR_REFERENCE_WHITE_NITS,
  HLG_SYSTEM_GAMMA,
} from './hdr-reference'
import { isHdrTransfer } from './log-encoding'
import { compressLutInputToDomain } from './lut-domain'
import { clamp01, mix, sampleLutTrilinear } from './lut3d'
import { getGamutMatrix } from './matrix'
import { getTransferFunction } from './registry'
import { applyUserSaturationTo } from './saturation'
import {
  applySelectiveColorRow,
  isSelectiveColorNeutral,
  resolveSelectiveColorParams,
} from './selective-color'
import {
  contrastScaleFromLuminance,
  hasRegionalTone,
  regionalToneScaleFromLuminance,
} from './tone'

const CHANNELS_PER_PIXEL = 3
const UINT16_MAX = 65535

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
const SRGB_TO_PROPHOTO_MATRIX = getGamutMatrix('srgb-rec709', 'prophoto-rgb')

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

type StepOfKind<Kind> = Extract<ExportColorGraphStep, { kind: Kind }>

/** A step list narrowed to exactly `Kinds`, in order. */
type StepsOfKinds<Kinds extends readonly ExportColorGraphStep['kind'][]> = {
  -readonly [Index in keyof Kinds]: StepOfKind<Kinds[Index]>
}

type PlainSteps = StepsOfKinds<typeof EXPORT_PLAIN_STEP_KINDS>
type LutSteps = StepsOfKinds<typeof EXPORT_LUT_STEP_KINDS>
type HdrLutSteps = StepsOfKinds<typeof EXPORT_HDR_LUT_STEP_KINDS>

function hasStepKinds<Kinds extends readonly ExportColorGraphStep['kind'][]>(
  steps: readonly ExportColorGraphStep[],
  kinds: Kinds,
): steps is StepsOfKinds<Kinds> {
  return (
    steps.length === kinds.length &&
    steps.every((step, index) => step.kind === kinds[index])
  )
}

function getRawRenderExposureMultiplier(
  step: StepOfKind<'raw-render-exposure'>,
) {
  return Number.isFinite(step.multiplier) ? step.multiplier : 1
}

function getUserColorBalanceGain(
  step: StepOfKind<'user-color-balance'>,
): readonly [number, number, number] {
  return [
    Number.isFinite(step.gain[0]) ? step.gain[0] : 1,
    Number.isFinite(step.gain[1]) ? step.gain[1] : 1,
    Number.isFinite(step.gain[2]) ? step.gain[2] : 1,
  ]
}

function getUserExposureMultiplier(step: StepOfKind<'user-exposure'>) {
  return Number.isFinite(step.multiplier) ? step.multiplier : 1
}

type MutableRgb = [number, number, number]

function applyUserContrastScalarTo(
  r: number,
  g: number,
  b: number,
  step: StepOfKind<'user-contrast'>,
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
  const scale = contrastScaleFromLuminance(y, step.factor, step.pivot)
  out[0] = positiveR * scale
  out[1] = positiveG * scale
  out[2] = positiveB * scale
  return out
}

function applyUserRegionalToneScalarTo(
  r: number,
  g: number,
  b: number,
  step: StepOfKind<'user-regional-tone'>,
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
  const scale = regionalToneScaleFromLuminance(y, step)

  out[0] = positiveR * scale
  out[1] = positiveG * scale
  out[2] = positiveB * scale
  return out
}

/** Applies a step in place to the first `length` values of `sceneScratch`. */
type SceneScratchStep = (sceneScratch: Float32Array, length: number) => void

function compileSelectiveColor(
  step: StepOfKind<'user-selective-color'>,
): SceneScratchStep {
  // Neutral bands are identity, but the OKLab round trip inside
  // applySelectiveColorRow drifts about 1 ULP in linear ProPhoto, which can
  // flip a downstream sRGB byte at a tightly clamped LUT domain. Skip them.
  if (isSelectiveColorNeutral(step.bands)) return () => {}
  const { prepared } = resolveSelectiveColorParams({
    selectiveColor: step.bands,
  })
  return (sceneScratch, length) => {
    const view = sceneScratch.subarray(0, length)
    applySelectiveColorRow(
      view,
      view,
      prepared,
      step.chromaClampLow,
      step.chromaClampHigh,
    )
  }
}

/**
 * The scene steps both graphs share, from the RAW render exposure through
 * selective color, written to `sceneScratch` in linear ProPhoto.
 */
function compileSceneStage(
  steps: PlainSteps | LutSteps | HdrLutSteps,
): (linear: Float32Array, sceneScratch: Float32Array) => void {
  const rawRenderExposureMultiplier = getRawRenderExposureMultiplier(steps[1])
  const colorBalanceGain = getUserColorBalanceGain(steps[2])
  const exposureMultiplier = getUserExposureMultiplier(steps[3])
  const contrastStep = steps[4]
  const regionalToneStep = steps[5]
  const saturationStep = steps[6]
  const isSatIdentity =
    saturationStep.saturation === 0 && saturationStep.vibrance === 0
  const applySelectiveColor = compileSelectiveColor(steps[7])
  const toneScratch: MutableRgb = [0, 0, 0]

  return (linear, sceneScratch) => {
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

    applySelectiveColor(sceneScratch, length)
  }
}

/**
 * Writes the graph's SDR bytes for `linear`, with the edited scene in linear
 * ProPhoto as `sceneScratch`. An applier compiled for the HDR rendition
 * leaves the scene the look renders there on return: its source.
 */
type GraphApplier = (
  linear: Float32Array,
  bytes: Uint8Array,
  sceneScratch: Float32Array,
) => void

function compilePlainGraphApplier(steps: PlainSteps): GraphApplier {
  const applyScene = compileSceneStage(steps)

  return (linear, bytes, sceneScratch) => {
    const length = linear.length
    applyScene(linear, sceneScratch)

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

/**
 * Samples the LUT for one pixel of the edited scene (linear ProPhoto) and its
 * SDR display light, writing the LUT's output signal with its range removed.
 * A display look reads the display light; every other role reads the scene
 * in its input gamut.
 */
type LutSampler = (
  sceneR: number,
  sceneG: number,
  sceneB: number,
  baseDisplayLinearR: number,
  baseDisplayLinearG: number,
  baseDisplayLinearB: number,
  out: MutableRgb,
) => void

function compileLutSampler(
  inputStep: StepOfKind<'gamut-to-lut-input'>,
  encodeStep: StepOfKind<'encode-lut-transfer'>,
  lutStep: StepOfKind<'lut3d'>,
  outputStep: StepOfKind<'lut-output-to-srgb' | 'lut-hdr-output-to-srgb'>,
): LutSampler {
  const inputMatrix = inputStep.matrix
  const encodeTransfer = getTransferFunction(encodeStep.transfer)
  if (!encodeTransfer) throw new Error('FULL_RES_EXPORT_UNSUPPORTED_PIPELINE')
  const readsDisplay = outputStep.role === 'display-look' || !inputMatrix
  const inputIsLegalRange = encodeStep.range === 'legal'
  const outputIsLegalRange = outputStep.range === 'legal'
  const domainMin = lutStep.domainMin
  const domainMax = lutStep.domainMax
  const inverseDomainSpanR =
    domainMax[0] === domainMin[0] ? 0 : 1 / (domainMax[0] - domainMin[0])
  const inverseDomainSpanG =
    domainMax[1] === domainMin[1] ? 0 : 1 / (domainMax[1] - domainMin[1])
  const inverseDomainSpanB =
    domainMax[2] === domainMin[2] ? 0 : 1 / (domainMax[2] - domainMin[2])
  const lutInputEncoded: MutableRgb = [0, 0, 0]
  const lutInputDomain: MutableRgb = [0, 0, 0]

  return (
    sceneR,
    sceneG,
    sceneB,
    baseDisplayLinearR,
    baseDisplayLinearG,
    baseDisplayLinearB,
    out,
  ) => {
    let lutInputLinearR = baseDisplayLinearR
    let lutInputLinearG = baseDisplayLinearG
    let lutInputLinearB = baseDisplayLinearB

    if (!readsDisplay) {
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
      out,
    )
    out[0] = removeSignalRangeFromLutOutput(out[0], outputIsLegalRange)
    out[1] = removeSignalRangeFromLutOutput(out[1], outputIsLegalRange)
    out[2] = removeSignalRangeFromLutOutput(out[2], outputIsLegalRange)
  }
}

/** The edited scene (linear ProPhoto) as SDR display light, at or above zero. */
function writeBaseDisplayLinear(
  sceneR: number,
  sceneG: number,
  sceneB: number,
  out: MutableRgb,
) {
  out[0] = clampMin0(
    PROPHOTO_TO_SRGB_MATRIX[0] * sceneR +
      PROPHOTO_TO_SRGB_MATRIX[1] * sceneG +
      PROPHOTO_TO_SRGB_MATRIX[2] * sceneB,
  )
  out[1] = clampMin0(
    PROPHOTO_TO_SRGB_MATRIX[3] * sceneR +
      PROPHOTO_TO_SRGB_MATRIX[4] * sceneG +
      PROPHOTO_TO_SRGB_MATRIX[5] * sceneB,
  )
  out[2] = clampMin0(
    PROPHOTO_TO_SRGB_MATRIX[6] * sceneR +
      PROPHOTO_TO_SRGB_MATRIX[7] * sceneG +
      PROPHOTO_TO_SRGB_MATRIX[8] * sceneB,
  )
}

/**
 * Writes the scene the look renders to `sceneScratch`: the edited scene mixed
 * by the look strength with the LUT's light (sRGB primaries, linear,
 * unclamped) carried to linear ProPhoto.
 */
function writeLookSceneAt(
  sceneScratch: Float32Array,
  index: number,
  lutLinearR: number,
  lutLinearG: number,
  lutLinearB: number,
  intensity: number,
) {
  sceneScratch[index] = mix(
    sceneScratch[index],
    SRGB_TO_PROPHOTO_MATRIX[0] * lutLinearR +
      SRGB_TO_PROPHOTO_MATRIX[1] * lutLinearG +
      SRGB_TO_PROPHOTO_MATRIX[2] * lutLinearB,
    intensity,
  )
  sceneScratch[index + 1] = mix(
    sceneScratch[index + 1],
    SRGB_TO_PROPHOTO_MATRIX[3] * lutLinearR +
      SRGB_TO_PROPHOTO_MATRIX[4] * lutLinearG +
      SRGB_TO_PROPHOTO_MATRIX[5] * lutLinearB,
    intensity,
  )
  sceneScratch[index + 2] = mix(
    sceneScratch[index + 2],
    SRGB_TO_PROPHOTO_MATRIX[6] * lutLinearR +
      SRGB_TO_PROPHOTO_MATRIX[7] * lutLinearG +
      SRGB_TO_PROPHOTO_MATRIX[8] * lutLinearB,
    intensity,
  )
}

/**
 * The LUT graph's applier. With `writeLookScene` a scene-creative LUT also
 * leaves the scene its look renders in `sceneScratch`: the edited scene
 * mixed by the look strength with the LUT output in linear ProPhoto,
 * unclamped, as the SDR bytes mix them in display light.
 */
function compileLutGraphApplier(
  steps: LutSteps,
  writeLookScene: boolean,
): GraphApplier {
  const applyScene = compileSceneStage(steps)
  const outputStep = steps[11]
  const sampleLut = compileLutSampler(steps[8], steps[9], steps[10], outputStep)
  const outputMatrix = outputStep.matrix
  const decodeTransfer = getTransferFunction(outputStep.transfer)
  if (!decodeTransfer) throw new Error('FULL_RES_EXPORT_UNSUPPORTED_PIPELINE')
  const role = outputStep.role
  const intensity = outputStep.intensity
  if (writeLookScene && role !== 'scene-creative') {
    throw new Error('HDR_GAIN_MAP_UNSUPPORTED_PIPELINE')
  }
  const base: MutableRgb = [0, 0, 0]
  const lutSample: MutableRgb = [0, 0, 0]

  return (linear, bytes, sceneScratch) => {
    const length = linear.length
    applyScene(linear, sceneScratch)

    for (let index = 0; index < length; index += 3) {
      const sceneR = sceneScratch[index]
      const sceneG = sceneScratch[index + 1]
      const sceneB = sceneScratch[index + 2]
      writeBaseDisplayLinear(sceneR, sceneG, sceneB, base)
      const baseDisplayLinearR = base[0]
      const baseDisplayLinearG = base[1]
      const baseDisplayLinearB = base[2]
      sampleLut(
        sceneR,
        sceneG,
        sceneB,
        baseDisplayLinearR,
        baseDisplayLinearG,
        baseDisplayLinearB,
        lutSample,
      )

      const lutOutputLinearR = decodeTransfer.decode(lutSample[0])
      const lutOutputLinearG = decodeTransfer.decode(lutSample[1])
      const lutOutputLinearB = decodeTransfer.decode(lutSample[2])
      const lutDisplayLinearR =
        outputMatrix[0] * lutOutputLinearR +
        outputMatrix[1] * lutOutputLinearG +
        outputMatrix[2] * lutOutputLinearB
      const lutDisplayLinearG =
        outputMatrix[3] * lutOutputLinearR +
        outputMatrix[4] * lutOutputLinearG +
        outputMatrix[5] * lutOutputLinearB
      const lutDisplayLinearB =
        outputMatrix[6] * lutOutputLinearR +
        outputMatrix[7] * lutOutputLinearG +
        outputMatrix[8] * lutOutputLinearB

      if (writeLookScene) {
        writeLookSceneAt(
          sceneScratch,
          index,
          lutDisplayLinearR,
          lutDisplayLinearG,
          lutDisplayLinearB,
          intensity,
        )
      }

      const styledDisplayLinearR = clampMin0(lutDisplayLinearR)
      const styledDisplayLinearG = clampMin0(lutDisplayLinearG)
      const styledDisplayLinearB = clampMin0(lutDisplayLinearB)

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

      bytes[index] = toEncodedByte(
        mix(
          linearToSrgb(baseDisplayLinearR),
          linearToSrgb(styledDisplayLinearR),
          intensity,
        ),
      )
      bytes[index + 1] = toEncodedByte(
        mix(
          linearToSrgb(baseDisplayLinearG),
          linearToSrgb(styledDisplayLinearG),
          intensity,
        ),
      )
      bytes[index + 2] = toEncodedByte(
        mix(
          linearToSrgb(baseDisplayLinearB),
          linearToSrgb(styledDisplayLinearB),
          intensity,
        ),
      )
    }
  }
}

/**
 * The applier of a graph whose LUT outputs an HDR signal. The LUT's display
 * light is the look's HDR rendition; its SDR picture is that light through
 * the BT.2390 EETF onto SDR white. Both mix with the edited scene by the look
 * strength in linear light, so at zero strength each is the export without a
 * look. With `writeLookScene` the applier leaves the HDR rendition's scene in
 * `sceneScratch`.
 */
function compileHdrLutGraphApplier(
  steps: HdrLutSteps,
  writeLookScene: boolean,
): GraphApplier {
  const applyScene = compileSceneStage(steps)
  const outputStep = steps[11]
  if (
    outputStep.referenceWhiteNits !== HDR_REFERENCE_WHITE_NITS ||
    outputStep.nominalPeakNits !== HDR_NOMINAL_PEAK_NITS ||
    outputStep.hlgSystemGamma !== HLG_SYSTEM_GAMMA ||
    outputStep.toneMap !== HDR_TO_SDR_TONE_MAP ||
    !isHdrTransfer(outputStep.transfer)
  ) {
    throw new Error('FULL_RES_EXPORT_UNSUPPORTED_PIPELINE')
  }
  const sampleLut = compileLutSampler(steps[8], steps[9], steps[10], outputStep)
  const outputMatrix = outputStep.matrix
  const decodeDisplayLight = createHdrDisplayLightDecoder(
    outputStep.transfer,
    outputMatrix,
  )
  const intensity = outputStep.intensity
  const base: MutableRgb = [0, 0, 0]
  const lutSample: MutableRgb = [0, 0, 0]
  const lutLight: MutableRgb = [0, 0, 0]
  const sdrLook: MutableRgb = [0, 0, 0]

  return (linear, bytes, sceneScratch) => {
    const length = linear.length
    applyScene(linear, sceneScratch)

    for (let index = 0; index < length; index += 3) {
      const sceneR = sceneScratch[index]
      const sceneG = sceneScratch[index + 1]
      const sceneB = sceneScratch[index + 2]
      writeBaseDisplayLinear(sceneR, sceneG, sceneB, base)
      sampleLut(sceneR, sceneG, sceneB, base[0], base[1], base[2], lutSample)
      decodeDisplayLight(lutSample[0], lutSample[1], lutSample[2], lutLight)

      const lutDisplayLinearR =
        outputMatrix[0] * lutLight[0] +
        outputMatrix[1] * lutLight[1] +
        outputMatrix[2] * lutLight[2]
      const lutDisplayLinearG =
        outputMatrix[3] * lutLight[0] +
        outputMatrix[4] * lutLight[1] +
        outputMatrix[5] * lutLight[2]
      const lutDisplayLinearB =
        outputMatrix[6] * lutLight[0] +
        outputMatrix[7] * lutLight[1] +
        outputMatrix[8] * lutLight[2]

      if (writeLookScene) {
        writeLookSceneAt(
          sceneScratch,
          index,
          lutDisplayLinearR,
          lutDisplayLinearG,
          lutDisplayLinearB,
          intensity,
        )
      }

      toneMapHdrToSdr(
        clampMin0(lutDisplayLinearR),
        clampMin0(lutDisplayLinearG),
        clampMin0(lutDisplayLinearB),
        sdrLook,
      )
      bytes[index] = toSrgbByte(mix(base[0], sdrLook[0], intensity))
      bytes[index + 1] = toSrgbByte(mix(base[1], sdrLook[1], intensity))
      bytes[index + 2] = toSrgbByte(mix(base[2], sdrLook[2], intensity))
    }
  }
}

/**
 * The graph's applier. With `hdr` the graph must have an HDR rendition, and
 * the applier leaves the scene that rendition is drawn from in
 * `sceneScratch`; the SDR bytes are the same either way.
 */
function compileGraphApplier(
  graph: SupportedExportColorGraphDescriptor,
  { hdr = false }: { hdr?: boolean } = {},
): GraphApplier {
  if (hdr && !resolveHdrGainMapSupport(graph).supported) {
    throw new Error('HDR_GAIN_MAP_UNSUPPORTED_PIPELINE')
  }
  const { steps } = graph
  if (
    graph.lutProfile === null &&
    hasStepKinds(steps, EXPORT_PLAIN_STEP_KINDS)
  ) {
    return compilePlainGraphApplier(steps)
  }

  if (hasStepKinds(steps, EXPORT_HDR_LUT_STEP_KINDS)) {
    return compileHdrLutGraphApplier(steps, hdr)
  }

  if (!hasStepKinds(steps, EXPORT_LUT_STEP_KINDS)) {
    throw new Error('FULL_RES_EXPORT_UNSUPPORTED_PIPELINE')
  }

  return compileLutGraphApplier(steps, hdr)
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

export type HdrGainMapRows = {
  /** The SDR export's bytes, exactly as `createRowBandProcessor` writes them. */
  sdr: Uint8Array
  /** One gain map code per SDR sample (3 channels, full resolution). */
  gainMap: Uint8Array
}

export type HdrGainMapRowBandProcessor = {
  rowBandRows: number
  processUint16Rows: (source: Uint16Array, rowCount: number) => HdrGainMapRows
}

/**
 * The row-band processor of a gain-map export: the graph's SDR bytes plus
 * the gain map that lifts them to the HDR rendition. It refuses a graph
 * without an HDR rendition (`resolveHdrGainMapSupport`).
 */
export function createHdrGainMapRowBandProcessor({
  width,
  rowBandRows,
  graph,
}: CreateRowBandProcessorInput): HdrGainMapRowBandProcessor {
  assertPositiveSafeInteger(width, 'ROW_BAND_PROCESSOR_INVALID_WIDTH')
  assertPositiveSafeInteger(
    rowBandRows,
    'ROW_BAND_PROCESSOR_INVALID_ROW_BAND_ROWS',
  )

  const maxLength = expectedRowLength(width, rowBandRows)
  if (!Number.isSafeInteger(maxLength)) {
    throw new TypeError('ROW_BAND_PROCESSOR_INVALID_ROW_BAND_ROWS')
  }
  const applyGraph = compileGraphApplier(graph, { hdr: true })
  const floatScratch = new Float32Array(maxLength)
  const sceneScratch = new Float32Array(maxLength)
  const sdrScratch = new Uint8Array(maxLength)
  const gainMapScratch = new Uint8Array(maxLength)

  return {
    rowBandRows,
    processUint16Rows(source, rowCount) {
      const length = validateRows(source.length, width, rowBandRows, rowCount)
      const linear = floatScratch.subarray(0, length)
      for (let index = 0; index < length; index += 1) {
        linear[index] = (source[index] ?? 0) / UINT16_MAX
      }
      const sdr = sdrScratch.subarray(0, length)
      const gainMap = gainMapScratch.subarray(0, length)
      applyGraph(linear, sdr, sceneScratch)
      encodeHdrGainMapRows(sceneScratch, sdr, gainMap, length)
      return { sdr, gainMap }
    },
  }
}

export type HdrPreviewRowBandProcessor = {
  rowBandRows: number
  /** Preview bytes (sRGB, three per pixel) for the view; reused per call. */
  processUint16Rows: (source: Uint16Array, rowCount: number) => Uint8Array
}

/**
 * The row-band processor of an HDR preview view: what the gain-map export's
 * HDR rendition holds, drawn for an SDR display. It refuses a graph without
 * an HDR rendition, as the gain-map export does.
 */
export function createHdrPreviewRowBandProcessor({
  width,
  rowBandRows,
  graph,
  view,
}: CreateRowBandProcessorInput & {
  view: HdrPreviewView
}): HdrPreviewRowBandProcessor {
  assertPositiveSafeInteger(width, 'ROW_BAND_PROCESSOR_INVALID_WIDTH')
  assertPositiveSafeInteger(
    rowBandRows,
    'ROW_BAND_PROCESSOR_INVALID_ROW_BAND_ROWS',
  )

  const maxLength = expectedRowLength(width, rowBandRows)
  if (!Number.isSafeInteger(maxLength)) {
    throw new TypeError('ROW_BAND_PROCESSOR_INVALID_ROW_BAND_ROWS')
  }
  const applyGraph = compileGraphApplier(graph, { hdr: true })
  const floatScratch = new Float32Array(maxLength)
  const sceneScratch = new Float32Array(maxLength)
  const sdrScratch = new Uint8Array(maxLength)
  const outScratch = new Uint8Array(maxLength)

  return {
    rowBandRows,
    processUint16Rows(source, rowCount) {
      const length = validateRows(source.length, width, rowBandRows, rowCount)
      const linear = floatScratch.subarray(0, length)
      for (let index = 0; index < length; index += 1) {
        linear[index] = (source[index] ?? 0) / UINT16_MAX
      }
      const sdr = sdrScratch.subarray(0, length)
      const out = outScratch.subarray(0, length)
      applyGraph(linear, sdr, sceneScratch)
      encodeHdrPreviewRows(sceneScratch, sdr, view, out, length)
      return out
    },
  }
}
