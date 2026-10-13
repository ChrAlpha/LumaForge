import type {
  ExportColorGraphInput,
  SupportedExportColorGraphDescriptor,
} from './color-graph'
import { resolveExportColorGraph } from './color-graph'
import type { Mat3 } from './matrix'
import { getLinearProPhotoToGamutMatrix, mat3Identity } from './matrix'
import { linearProPhotoToOklab, oklabToLinearProPhoto } from './oklab'
import type { LUTColorProfile } from './registry'
import { createRowBandProcessor } from './row-band-processor'
import {
  CHROMA_CLAMP_HIGH,
  CHROMA_CLAMP_LOW,
  HUE_MAX_DELTA_RAD,
  NEUTRAL_SELECTIVE_COLOR,
  resolveSelectiveColorParams,
} from './selective-color'
import { NEUTRAL_USER_COLOR_INTENT } from './user-color-intent'

/** The graph export resolves for an untouched photo with no look, plus `overrides`. */
function resolvedGraph(
  overrides: Partial<ExportColorGraphInput> = {},
): SupportedExportColorGraphDescriptor {
  const graph = resolveExportColorGraph({
    ...NEUTRAL_USER_COLOR_INTENT,
    styleKind: 'none',
    builtinPreset: null,
    intensity: 1,
    lut: null,
    ...overrides,
  })
  if (!graph.supported) throw new Error(graph.message)
  return graph
}

const noLutGraph = resolvedGraph()

const LINEAR_PROBE_LUT_PROFILE: LUTColorProfile = {
  id: 'test-linear-prophoto-probe',
  label: 'Test Linear ProPhoto Probe',
  role: 'scene-creative',
  inputGamut: 'prophoto-rgb',
  inputTransfer: 'linear',
  inputRange: 'full',
  outputGamut: 'srgb-rec709',
  outputTransfer: 'linear',
  outputRange: 'full',
  aliases: [],
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

/** A 2-point LUT whose output at each lattice corner is `corner(r, g, b)`. */
function makeLut(
  corner: (red: number, green: number, blue: number) => readonly number[],
) {
  const lut = new Float32Array(2 * 2 * 2 * 3)
  for (let blue = 0; blue < 2; blue += 1) {
    for (let green = 0; green < 2; green += 1) {
      for (let red = 0; red < 2; red += 1) {
        lut.set(corner(red, green, blue), ((blue * 2 + green) * 2 + red) * 3)
      }
    }
  }
  return lut
}

const makeRedRampLut = () => makeLut((red) => [red, red, red])
const makeIdentityLut = () => makeLut((red, green, blue) => [red, green, blue])

/**
 * The neutral scene steps followed by a linear ProPhoto LUT stage, which no
 * catalog contract resolves to, so the LUT steps are written here.
 */
function makeLinearLutGraph({
  data,
  domainMin = [0, 0, 0],
  domainMax = [1, 1, 1],
  outputMatrix = mat3Identity(),
}: {
  data: Float32Array
  domainMin?: [number, number, number]
  domainMax?: [number, number, number]
  outputMatrix?: Mat3
}): SupportedExportColorGraphDescriptor {
  const sceneSteps = structuredClone(noLutGraph.steps.slice(0, -1))
  return {
    supported: true,
    outputGamut: 'srgb-rec709',
    outputTransfer: 'srgb',
    lutProfile: LINEAR_PROBE_LUT_PROFILE,
    steps: [
      ...sceneSteps,
      {
        kind: 'gamut-to-lut-input',
        matrix: mat3Identity(),
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

function makePrecisionProbeGraph(domainMin: number, domainMax: number) {
  return makeLinearLutGraph({
    data: makeRedRampLut(),
    domainMin: [domainMin, 0, 0],
    domainMax: [domainMax, 1, 1],
  })
}

describe('createRowBandProcessor', () => {
  it('changes no-lut output when user exposure changes', () => {
    const processor = createRowBandProcessor({
      width: 1,
      rowBandRows: 1,
      graph: resolvedGraph({ userExposureEv: 1 }),
    })
    const rows = processor.processFloatRows(
      new Float32Array([0.1, 0.1, 0.1]),
      1,
    )

    expect(rows[0]).toBeGreaterThan(toSrgbByte(0.1))
  })

  it('keeps neutral tone output equal to the pre-tone no-lut reference', () => {
    const processor = createRowBandProcessor({
      width: 1,
      rowBandRows: 1,
      graph: noLutGraph,
    })
    const rows = processor.processFloatRows(
      new Float32Array([0.18, 0.18, 0.18]),
      1,
    )

    expect(rows).toEqual(
      new Uint8Array([toSrgbByte(0.18), toSrgbByte(0.18), toSrgbByte(0.18)]),
    )
  })

  it('applies color balance before tone in no-lut export', () => {
    const processor = createRowBandProcessor({
      width: 1,
      rowBandRows: 1,
      graph: resolvedGraph({ userTemperature: 100 }),
    })

    const rows = processor.processFloatRows(
      new Float32Array([0.18, 0.18, 0.18]),
      1,
    )

    expect(rows[0]).toBeGreaterThan(rows[2])
  })

  it('applies user contrast before LUT input sampling', () => {
    const domainMin = 0.4
    const domainMax = 0.8
    const sourceLinear = 0.36
    const graph = makePrecisionProbeGraph(domainMin, domainMax)
    const contrastStep = graph.steps.find(
      (step) => step.kind === 'user-contrast',
    )
    if (!contrastStep || contrastStep.kind !== 'user-contrast') {
      throw new Error('Missing contrast step')
    }
    contrastStep.amount = 100
    contrastStep.factor = Math.SQRT2

    const processor = createRowBandProcessor({
      width: 1,
      rowBandRows: 1,
      graph,
    })
    const rows = processor.processFloatRows(
      new Float32Array([sourceLinear, sourceLinear, sourceLinear]),
      1,
    )
    const tonedLinear =
      contrastStep.pivot *
      Math.pow(sourceLinear / contrastStep.pivot, contrastStep.factor)
    const normalizedTonedInput = clamp01(
      (tonedLinear - domainMin) / (domainMax - domainMin),
    )
    const normalizedUntonedInput = clamp01(
      (sourceLinear - domainMin) / (domainMax - domainMin),
    )

    expect(normalizedUntonedInput).toBe(0)
    expect(rows).toEqual(
      new Uint8Array([
        toSrgbByte(normalizedTonedInput),
        toSrgbByte(normalizedTonedInput),
        toSrgbByte(normalizedTonedInput),
      ]),
    )
    expect(rows[0]).not.toBe(0)
  })

  it('applies regional tone before LUT input sampling', () => {
    const domainMin = 0.6
    const domainMax = 1.1
    const sourceLinear = 0.72
    const graph = makePrecisionProbeGraph(domainMin, domainMax)
    const regionalStep = graph.steps.find(
      (step) => step.kind === 'user-regional-tone',
    )
    if (!regionalStep || regionalStep.kind !== 'user-regional-tone') {
      throw new Error('Missing regional tone step')
    }
    regionalStep.highlights = 100
    regionalStep.whites = 50

    const processor = createRowBandProcessor({
      width: 1,
      rowBandRows: 1,
      graph,
    })
    const rows = processor.processFloatRows(
      new Float32Array([sourceLinear, sourceLinear, sourceLinear]),
      1,
    )
    const normalizedUntonedInput = clamp01(
      (sourceLinear - domainMin) / (domainMax - domainMin),
    )

    expect(rows[0]).toBeGreaterThan(toSrgbByte(normalizedUntonedInput))
  })

  it('keeps Uint16 rows in Float32 until LUT sampling and final RGB8 quantization', () => {
    const sourceValue = 32768
    const sourceLinear = Math.fround(sourceValue / 65535)
    const domainMin = 0.5
    const domainMax = 0.50002
    const processor = createRowBandProcessor({
      width: 1,
      rowBandRows: 1,
      graph: makePrecisionProbeGraph(domainMin, domainMax),
    })
    const rows = processor.processUint16Rows(
      new Uint16Array([sourceValue, 0, 0]),
      1,
    )
    const normalizedLutInput = clamp01(
      (sourceLinear - domainMin) / (domainMax - domainMin),
    )
    const byteQuantizedLinear = Math.round(sourceLinear * 255) / 255
    const byteQuantizedLutInput = clamp01(
      (byteQuantizedLinear - domainMin) / (domainMax - domainMin),
    )

    expect(rows).toEqual(
      new Uint8Array([
        toSrgbByte(normalizedLutInput),
        toSrgbByte(normalizedLutInput),
        toSrgbByte(normalizedLutInput),
      ]),
    )
    expect(rows[0]).not.toBe(toSrgbByte(byteQuantizedLutInput))
  })

  it('preserves highlight chroma when LUT input exceeds the declared domain', () => {
    const processor = createRowBandProcessor({
      width: 1,
      rowBandRows: 1,
      graph: makeLinearLutGraph({ data: makeIdentityLut() }),
    })

    const rows = processor.processFloatRows(
      new Float32Array([1.6, 1.2, 0.8]),
      1,
    )

    expect(rows[0]).toBe(toSrgbByte(1))
    expect(rows[1]).toBe(toSrgbByte(0.75))
    expect(rows[2]).toBe(toSrgbByte(0.5))
    expect(rows[0]).toBeGreaterThan(rows[1])
    expect(rows[1]).toBeGreaterThan(rows[2])
  })

  it('reuses the RGB8 scratch buffer and returns only the requested row slice', () => {
    const processor = createRowBandProcessor({
      width: 2,
      rowBandRows: 3,
      graph: noLutGraph,
    })
    const first = processor.processFloatRows(
      new Float32Array(2 * 3 * 3).fill(0.25),
      3,
    )
    const second = processor.processFloatRows(
      new Float32Array(2 * 2 * 3).fill(0.5),
      2,
    )
    const third = processor.processUint16Rows(
      new Uint16Array(2 * 1 * 3).fill(32768),
      1,
    )

    expect(processor.rowBandRows).toBe(3)
    expect(processor.reusesOutputBuffer).toBe(true)
    expect(first).toHaveLength(18)
    expect(second).toHaveLength(12)
    expect(third).toHaveLength(6)
    expect(second.byteOffset).toBe(0)
    expect(third.byteOffset).toBe(0)
    expect(second.buffer).toBe(first.buffer)
    expect(third.buffer).toBe(first.buffer)
  })

  it.each([0, -1, 1.5, Number.NaN, Infinity])(
    'rejects invalid width %s',
    (width) => {
      expect(() =>
        createRowBandProcessor({
          width,
          rowBandRows: 1,
          graph: noLutGraph,
        }),
      ).toThrow('ROW_BAND_PROCESSOR_INVALID_WIDTH')
    },
  )

  it.each([0, -1, 1.5, Number.NaN, Infinity])(
    'rejects invalid row band size %s',
    (rowBandRows) => {
      expect(() =>
        createRowBandProcessor({
          width: 1,
          rowBandRows,
          graph: noLutGraph,
        }),
      ).toThrow('ROW_BAND_PROCESSOR_INVALID_ROW_BAND_ROWS')
    },
  )

  it.each([0, -1, 1.5, Number.NaN, Infinity, 3])(
    'rejects invalid row count %s',
    (rowCount) => {
      const processor = createRowBandProcessor({
        width: 1,
        rowBandRows: 2,
        graph: noLutGraph,
      })

      expect(() =>
        processor.processFloatRows(new Float32Array(3), rowCount),
      ).toThrow('ROW_BAND_PROCESSOR_INVALID_ROW_COUNT')
      expect(() =>
        processor.processUint16Rows(new Uint16Array(3), rowCount),
      ).toThrow('ROW_BAND_PROCESSOR_INVALID_ROW_COUNT')
    },
  )

  it('rejects source lengths that do not match width and row count', () => {
    const processor = createRowBandProcessor({
      width: 2,
      rowBandRows: 2,
      graph: noLutGraph,
    })

    expect(() =>
      processor.processFloatRows(new Float32Array(2 * 1 * 3 - 1), 1),
    ).toThrow('ROW_BAND_PROCESSOR_INVALID_SOURCE_LENGTH')
    expect(() =>
      processor.processFloatRows(new Float32Array(2 * 1 * 3 + 1), 1),
    ).toThrow('ROW_BAND_PROCESSOR_INVALID_SOURCE_LENGTH')
    expect(() =>
      processor.processUint16Rows(new Uint16Array(2 * 2 * 3), 1),
    ).toThrow('ROW_BAND_PROCESSOR_INVALID_SOURCE_LENGTH')

    expect(
      processor.processUint16Rows(new Uint16Array(2 * 1 * 3), 1),
    ).toHaveLength(6)
  })

  it('does not depend on method receiver binding', () => {
    const processor = createRowBandProcessor({
      width: 1,
      rowBandRows: 1,
      graph: noLutGraph,
    })
    const { processUint16Rows } = processor

    expect(
      processUint16Rows(new Uint16Array([4000, 5000, 6000]), 1),
    ).toHaveLength(3)
  })

  it('treats a neutral selective-color step as identity at the row-band level', () => {
    // Synthetic linear-ProPhoto row that exercises every channel at multiple
    // chroma levels. After a graph with neutral selective color, the pipeline
    // (no LUT, no tone shift) must round-trip back to the same sRGB bytes a
    // neutral-tone-only graph would produce.
    const pixelCount = 16
    const linear = new Float32Array(pixelCount * 3)
    for (let i = 0; i < pixelCount; i += 1) {
      const t = i / (pixelCount - 1)
      linear[i * 3 + 0] = 0.1 + 0.6 * t
      linear[i * 3 + 1] = 0.5 - 0.4 * t
      linear[i * 3 + 2] = 0.3 + 0.2 * t
    }

    const withSelective = createRowBandProcessor({
      width: pixelCount,
      rowBandRows: 1,
      graph: noLutGraph,
    })

    const bytesWithSelective = withSelective.processFloatRows(linear, 1)

    // Independently re-derive the expected sRGB bytes from the ProPhoto->sRGB
    // matrix + sRGB transfer — the only operations the pipeline should run
    // for an all-neutral graph. This bypasses the OKLab roundtrip entirely;
    // a regression that removes the neutral bypass and applies signedCbrt +
    // matrix multiplies on neutral input would introduce F32 ULP drift that
    // can flip 8-bit byte boundaries, surfacing as a test failure here
    // rather than as a silent preview/export parity break.
    const M_PROPHOTO_TO_SRGB = getLinearProPhotoToGamutMatrix('srgb-rec709')
    const expected = new Uint8Array(pixelCount * 3)
    for (let p = 0; p < pixelCount; p += 1) {
      const r = linear[p * 3 + 0]
      const g = linear[p * 3 + 1]
      const b = linear[p * 3 + 2]
      const sR =
        M_PROPHOTO_TO_SRGB[0] * r +
        M_PROPHOTO_TO_SRGB[1] * g +
        M_PROPHOTO_TO_SRGB[2] * b
      const sG =
        M_PROPHOTO_TO_SRGB[3] * r +
        M_PROPHOTO_TO_SRGB[4] * g +
        M_PROPHOTO_TO_SRGB[5] * b
      const sB =
        M_PROPHOTO_TO_SRGB[6] * r +
        M_PROPHOTO_TO_SRGB[7] * g +
        M_PROPHOTO_TO_SRGB[8] * b
      expected[p * 3 + 0] = toSrgbByte(sR)
      expected[p * 3 + 1] = toSrgbByte(sG)
      expected[p * 3 + 2] = toSrgbByte(sB)
    }

    expect(Array.from(bytesWithSelective)).toEqual(Array.from(expected))

    // Determinism: a fresh processor on the SAME neutral graph returns the
    // same bytes — guards against any per-instance state (pooled buffers,
    // last-baked references) accidentally biasing the first run.
    const second = createRowBandProcessor({
      width: pixelCount,
      rowBandRows: 1,
      graph: noLutGraph,
    })
    const bytesSecond = second.processFloatRows(linear, 1)
    expect(Array.from(bytesSecond)).toEqual(Array.from(expected))
  })

  it('applies red.hue = +50 as an OKLCh hue shift on the pinned skin patch row', () => {
    // Match the T5 skin_attenuation_under_red contract at the row-band level:
    // 4 pixels of the pinned OKLab skin patch -> hue shift = 0.5 * w_red * Δ_max.
    const PINNED_SKIN_LAB = new Float32Array([0.7, 0.072, 0.072])
    const skinLinear = new Float32Array(3)
    oklabToLinearProPhoto(PINNED_SKIN_LAB, skinLinear)

    const pixelCount = 4
    const linear = new Float32Array(pixelCount * 3)
    for (let i = 0; i < pixelCount; i += 1) {
      linear[i * 3 + 0] = skinLinear[0]
      linear[i * 3 + 1] = skinLinear[1]
      linear[i * 3 + 2] = skinLinear[2]
    }

    // Graph where only the selective-color step differs from neutral.
    const redShiftBands = {
      ...NEUTRAL_SELECTIVE_COLOR,
      red: { hue: 50, saturation: 0, lightness: 0 },
    }
    const graph = resolvedGraph({ selectiveColor: redShiftBands })

    // Bake the LUT outside the processor so we can derive the expected hue
    // shift by lifting the apply-row algebra to the selective-color step
    // alone (the rest of the graph is identity for this neutral row).
    const { prepared } = resolveSelectiveColorParams({
      selectiveColor: redShiftBands,
    })

    // Sample the LUT at the skin patch hue (~45°) the same way the apply
    // does (linear lerp between buckets) — this is what w_red(45°) maps to
    // after partition-of-unity smoothstep.
    const labIn = new Float32Array(3)
    linearProPhotoToOklab(skinLinear, labIn)
    const hRad = Math.atan2(labIn[2], labIn[1])
    const TWO_PI = Math.PI * 2
    const hNormRaw = hRad / TWO_PI + 1
    const hNorm = hNormRaw - Math.floor(hNormRaw)
    const LUT_SIZE = 256
    const x = hNorm * LUT_SIZE
    const i0f = Math.floor(x)
    const t = x - i0f
    const i0 = i0f % LUT_SIZE
    const i1 = (i0 + 1) % LUT_SIZE
    const hueShiftLut =
      (1 - t) * prepared.buffer[4 * i0 + 0] + t * prepared.buffer[4 * i1 + 0]

    // Apply the same chroma-clamp strength the row apply uses for the skin
    // patch's chroma magnitude.
    const C = Math.sqrt(labIn[1] * labIn[1] + labIn[2] * labIn[2])
    const denom = CHROMA_CLAMP_HIGH - CHROMA_CLAMP_LOW
    let strength = 1
    if (denom > 0) {
      const u = (C - CHROMA_CLAMP_LOW) / denom
      const uc = Math.min(1, Math.max(0, u))
      strength = uc * uc * (3 - 2 * uc)
    }
    const expectedDelta = strength * hueShiftLut

    // Sanity: the algebra above matches the T5 macro form for the canonical
    // skin patch (delta ≈ 0.5 * w_red(45°) * Δ_max, with w_red ≈ 1 - smoothstep
    // of the red-orange bracket fraction). We're only relying on the LUT
    // sample being internally consistent.
    expect(expectedDelta).toBeGreaterThan(0)
    expect(expectedDelta).toBeLessThanOrEqual(HUE_MAX_DELTA_RAD)

    // Apply the row through the processor, then read the linear-ProPhoto
    // values BEFORE the output matrix by attaching a probe path. Since the
    // row-band processor only emits sRGB bytes, we instead verify by
    // comparing against a processor on the same graph with the LUT input
    // replaced by an oracle: feed the same skin patch through one row, then
    // through a graph identical except neutral selective-color, and assert
    // the two outputs differ in the predicted hue direction.
    const processor = createRowBandProcessor({
      width: pixelCount,
      rowBandRows: 1,
      graph,
    })
    const neutralProcessor = createRowBandProcessor({
      width: pixelCount,
      rowBandRows: 1,
      graph: noLutGraph,
    })

    const out = processor.processFloatRows(linear, 1)
    const outNeutral = neutralProcessor.processFloatRows(linear, 1)

    // For a +hue red shift on a skin patch (~45°), R should drop slightly and
    // G should rise slightly (hue rotating toward yellow/orange). All four
    // pixels are identical so we only need to check pixel 0.
    expect(out[0]).not.toEqual(outNeutral[0])
    expect(out[0]).toBeLessThan(outNeutral[0])
    expect(out[1]).toBeGreaterThanOrEqual(outNeutral[1])
  })

  it('preserves signed linear scene LUT input until declared domain sampling', () => {
    const processor = createRowBandProcessor({
      width: 1,
      rowBandRows: 1,
      graph: makeLinearLutGraph({
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
      graph: makeLinearLutGraph({
        data: makeLut(() => [-0.25, 0, 0]),
        outputMatrix: new Float32Array([-1, 0, 0, 0, 1, 0, 0, 0, 1]),
      }),
    })

    const rows = processor.processFloatRows(new Float32Array([0.5, 0, 0]), 1)

    expect(rows).toEqual(new Uint8Array([toSrgbByte(0.25), 0, 0]))
  })
})
