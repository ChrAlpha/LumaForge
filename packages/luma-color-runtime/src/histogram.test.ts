import { describe, expect, it } from 'vitest'

import { resolveColorBalanceParams } from './color-balance'
import type { SupportedExportColorGraphDescriptor } from './color-graph'
import { createPreviewHistogramProcessor } from './histogram'
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

const neutralColorBalance = resolveColorBalanceParams()

const noLutGraph: SupportedExportColorGraphDescriptor = {
  supported: true,
  outputGamut: 'srgb-rec709',
  outputTransfer: 'srgb',
  lutProfile: null,
  steps: [
    { kind: 'input-linear-prophoto' },
    { kind: 'raw-render-exposure', ev: 0, multiplier: 1 },
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
    { kind: 'output-srgb' },
  ],
}

function finishTwoPixelHistogram(source: Uint16Array) {
  const processor = createPreviewHistogramProcessor({
    width: 2,
    rowBandRows: 1,
    graph: noLutGraph,
  })
  processor.processUint16Rows(source, 1)
  return processor.finish({
    source: 'quick',
    width: 2,
    height: 1,
    totalRows: 1,
    ownership: 'main-thread-chunked-no-copy',
    inputByteLength: source.buffer.byteLength,
  })
}

describe('createPreviewHistogramProcessor', () => {
  it('accumulates RGB and luma bins from processed sRGB output', () => {
    const histogram = finishTwoPixelHistogram(
      new Uint16Array([0, 0, 0, 65535, 65535, 65535]),
    )

    expect(histogram.state).toBe('ready')
    expect(histogram.source).toBe('quick')
    expect(histogram.sampledPixels).toBe(2)
    expect(histogram.totalPixels).toBe(2)
    expect(histogram.bins.red[0]).toBe(1)
    expect(histogram.bins.green[0]).toBe(1)
    expect(histogram.bins.blue[0]).toBe(1)
    expect(histogram.bins.luma[0]).toBe(1)
    expect(histogram.bins.red[255]).toBe(1)
    expect(histogram.bins.green[255]).toBe(1)
    expect(histogram.bins.blue[255]).toBe(1)
    expect(histogram.bins.luma[255]).toBe(1)
    expect(histogram.clipping.shadowAnyChannel).toBe(1)
    expect(histogram.clipping.highlightAnyChannel).toBe(1)
  })

  it('applies raw render exposure and user exposure through the shared graph', () => {
    const graph: SupportedExportColorGraphDescriptor = {
      ...noLutGraph,
      steps: noLutGraph.steps.map((step) =>
        step.kind === 'raw-render-exposure'
          ? { kind: 'raw-render-exposure', ev: 1, multiplier: 2 }
          : step.kind === 'user-exposure'
            ? { kind: 'user-exposure', ev: 1, multiplier: 2 }
            : step,
      ),
    }
    const processor = createPreviewHistogramProcessor({
      width: 1,
      rowBandRows: 1,
      graph,
    })

    processor.processUint16Rows(new Uint16Array([8192, 8192, 8192]), 1)
    const histogram = processor.finish({
      source: 'quick',
      width: 1,
      height: 1,
      totalRows: 1,
      ownership: 'main-thread-chunked-no-copy',
      inputByteLength: 6,
    })

    const nonZeroLumaBins = Array.from(histogram.bins.luma.entries()).filter(
      ([, count]) => count > 0,
    )
    expect(nonZeroLumaBins).toHaveLength(1)
    expect(nonZeroLumaBins[0]![0]).toBeGreaterThan(150)
  })

  it('applies regional tone through the shared graph', () => {
    const graph: SupportedExportColorGraphDescriptor = {
      ...noLutGraph,
      steps: noLutGraph.steps.map((step) =>
        step.kind === 'user-regional-tone'
          ? {
              ...step,
              highlights: 100,
              whites: 50,
            }
          : step,
      ),
    }
    const processor = createPreviewHistogramProcessor({
      width: 1,
      rowBandRows: 1,
      graph,
    })

    processor.processUint16Rows(new Uint16Array([49152, 49152, 49152]), 1)
    const histogram = processor.finish({
      source: 'quick',
      width: 1,
      height: 1,
      totalRows: 1,
      ownership: 'main-thread-chunked-no-copy',
      inputByteLength: 6,
    })

    const nonZeroLumaBins = Array.from(histogram.bins.luma.entries()).filter(
      ([, count]) => count > 0,
    )
    expect(nonZeroLumaBins).toHaveLength(1)
    expect(nonZeroLumaBins[0]![0]).toBeGreaterThan(225)
  })

  it('never detaches or copies the source buffer in the default path', () => {
    const source = new Uint16Array([0, 0, 0, 65535, 65535, 65535])
    const beforeByteLength = source.buffer.byteLength
    const histogram = finishTwoPixelHistogram(source)

    expect(source.buffer.byteLength).toBe(beforeByteLength)
    expect(histogram.diagnostics.ownership).toBe('main-thread-chunked-no-copy')
    expect(histogram.diagnostics.copiedInputBytes).toBe(0)
    expect(histogram.diagnostics.transferredInput).toBe(false)
  })

  it('rejects invalid row slices before accumulation', () => {
    const processor = createPreviewHistogramProcessor({
      width: 2,
      rowBandRows: 1,
      graph: noLutGraph,
    })

    expect(() =>
      processor.processUint16Rows(new Uint16Array([0, 0, 0]), 1),
    ).toThrow('PREVIEW_HISTOGRAM_INVALID_SOURCE_LENGTH')
    expect(() => processor.processUint16Rows(new Uint16Array(12), 2)).toThrow(
      'PREVIEW_HISTOGRAM_INVALID_ROW_COUNT',
    )
  })

  it('rejects finish when processed rows do not match total rows', () => {
    const processor = createPreviewHistogramProcessor({
      width: 2,
      rowBandRows: 1,
      graph: noLutGraph,
    })

    processor.processUint16Rows(new Uint16Array([0, 0, 0, 0, 0, 0]), 1)

    expect(() =>
      processor.finish({
        source: 'quick',
        width: 2,
        height: 2,
        totalRows: 2,
        ownership: 'main-thread-chunked-no-copy',
        inputByteLength: 12,
      }),
    ).toThrow('PREVIEW_HISTOGRAM_ROW_COUNT_MISMATCH')
    expect(() =>
      processor.finish({
        source: 'quick',
        width: 2,
        height: 1,
        totalRows: 2,
        ownership: 'main-thread-chunked-no-copy',
        inputByteLength: 12,
      }),
    ).toThrow('PREVIEW_HISTOGRAM_INVALID_ROW_COUNT')
  })

  it('rejects finish when output width does not match processor width', () => {
    const processor = createPreviewHistogramProcessor({
      width: 2,
      rowBandRows: 1,
      graph: noLutGraph,
    })

    processor.processUint16Rows(new Uint16Array([0, 0, 0, 0, 0, 0]), 1)

    expect(() =>
      processor.finish({
        source: 'quick',
        width: 1,
        height: 1,
        totalRows: 1,
        ownership: 'main-thread-chunked-no-copy',
        inputByteLength: 12,
      }),
    ).toThrow('PREVIEW_HISTOGRAM_INVALID_WIDTH')
  })

  it('returns finished bins and clipping that do not mutate after later processor use', () => {
    const processor = createPreviewHistogramProcessor({
      width: 1,
      rowBandRows: 1,
      graph: noLutGraph,
    })

    processor.processUint16Rows(new Uint16Array([0, 0, 0]), 1)
    const first = processor.finish({
      source: 'quick',
      width: 1,
      height: 1,
      totalRows: 1,
      ownership: 'main-thread-chunked-no-copy',
      inputByteLength: 6,
    })
    processor.processUint16Rows(new Uint16Array([65535, 65535, 65535]), 1)
    const second = processor.finish({
      source: 'quick',
      width: 1,
      height: 2,
      totalRows: 2,
      ownership: 'main-thread-chunked-no-copy',
      inputByteLength: 12,
    })

    expect(first.sampledPixels).toBe(1)
    expect(first.bins.red[0]).toBe(1)
    expect(first.bins.red[255]).toBe(0)
    expect(first.bins.luma[255]).toBe(0)
    expect(first.clipping.shadowAnyChannel).toBe(1)
    expect(first.clipping.highlightAnyChannel).toBe(0)
    expect(second.sampledPixels).toBe(2)
    expect(second.bins.red[0]).toBe(1)
    expect(second.bins.red[255]).toBe(1)
    expect(second.clipping.highlightAnyChannel).toBe(1)
  })
})
