import type { SupportedExportColorGraphDescriptor } from '@lumaforge/luma-color-runtime'
import {
  createRowBandProcessor,
  mat3Identity,
} from '@lumaforge/luma-color-runtime'
import type { LumaRawProcessedWindowRequest } from '@lumaforge/luma-raw-runtime'
import { describe, expect, it, vi } from 'vitest'

import { runFullResolutionJpegExport } from './full-res-export'
import {
  clamp01,
  concatByteRows,
  IDENTITY_RAW_RENDER_EXPOSURE_STEP,
  linearToSrgb,
  makeCapability,
  makeJpegOutput,
  makePatternedProcessedWindow,
  makeProcessedWindow,
  makeRgbRampLut,
  neutralToneSteps,
} from './full-res-export-test-fixtures'
import { processedWindowToLinearProPhotoTile } from './processed-window-transform'

describe('runFullResolutionJpegExport', () => {
  it('writes row bands that match the same LUT graph applied to the full strip', async () => {
    const outputRect = { x: 0, y: 0, width: 3, height: 130 }
    const graph: SupportedExportColorGraphDescriptor = {
      supported: true,
      outputGamut: 'srgb-rec709',
      outputTransfer: 'srgb',
      lutProfile: null,
      steps: [
        { kind: 'input-linear-prophoto' },
        { kind: 'raw-render-exposure', ev: 0.1375, multiplier: 1.1 },
        ...neutralToneSteps(),
        {
          kind: 'gamut-to-lut-input',
          matrix: mat3Identity(),
          gamut: 'prophoto-rgb',
        },
        { kind: 'encode-lut-transfer', transfer: 'linear', range: 'full' },
        {
          kind: 'lut3d',
          size: 2,
          data: makeRgbRampLut(),
          domainMin: [0.12, 0.12, 0.12],
          domainMax: [0.95, 0.95, 0.95],
        },
        {
          kind: 'lut-output-to-srgb',
          matrix: mat3Identity(),
          transfer: 'linear',
          range: 'full',
          role: 'scene-creative',
          intensity: 0.65,
        },
        { kind: 'output-srgb' },
      ],
    }
    const expectedWindow = makePatternedProcessedWindow({
      outputRect,
      halo: { left: 2, top: 2, right: 2, bottom: 2 },
    })
    const expectedTile = processedWindowToLinearProPhotoTile(
      expectedWindow,
      outputRect,
    )
    const expectedRows = createRowBandProcessor({
      width: outputRect.width,
      rowBandRows: outputRect.height,
      graph,
    }).processFloatRows(expectedTile.data, outputRect.height)
    const writtenRows: Array<{ bytes: Uint8Array; rowCount: number }> = []
    const writer = {
      writeRows: vi.fn(async (bytes: Uint8Array, rowCount: number) => {
        writtenRows.push({ bytes: new Uint8Array(bytes), rowCount })
      }),
      close: vi.fn(async () => makeJpegOutput([new Uint8Array([1])])),
      abort: vi.fn(async () => undefined),
    }

    await runFullResolutionJpegExport({
      capability: makeCapability({
        width: outputRect.width,
        height: outputRect.height,
        rawWidth: outputRect.width,
        rawHeight: outputRect.height,
        visibleCrop: outputRect,
      }),
      graph,
      preferredRows: outputRect.height,
      readProcessedWindow: async (request) =>
        makePatternedProcessedWindow(request),
      writerFactory: () => writer,
    })

    expect(writtenRows.map((entry) => entry.rowCount)).toEqual([64, 64, 2])
    expect(writtenRows.map((entry) => entry.bytes.length)).toEqual([
      64 * outputRect.width * 3,
      64 * outputRect.width * 3,
      2 * outputRect.width * 3,
    ])
    expect(concatByteRows(writtenRows.map((entry) => entry.bytes))).toEqual(
      new Uint8Array(expectedRows),
    )
  })

  it('attributes row-band graph processing to color metrics and writes to JPEG metrics', async () => {
    const metrics: unknown[] = []
    const writer = {
      writeRows: vi.fn(async () => undefined),
      close: vi.fn(async () => makeJpegOutput([new Uint8Array([1])])),
      abort: vi.fn(async () => undefined),
    }
    let now = 0
    const nowSpy = vi
      .spyOn(globalThis.performance, 'now')
      .mockImplementation(() => {
        now += 1
        return now
      })

    try {
      await runFullResolutionJpegExport({
        capability: makeCapability(),
        graph: {
          supported: true,
          outputGamut: 'srgb-rec709',
          outputTransfer: 'srgb',
          lutProfile: null,
          steps: [
            { kind: 'input-linear-prophoto' },
            IDENTITY_RAW_RENDER_EXPOSURE_STEP,
            ...neutralToneSteps(),
            { kind: 'output-srgb' },
          ],
        },
        preferredRows: 2,
        readProcessedWindow: async (request) => makeProcessedWindow(request),
        writerFactory: () => writer,
        onMetric(metric) {
          metrics.push(metric)
        },
      })
    } finally {
      nowSpy.mockRestore()
    }

    const stripMetric = metrics.find(
      (metric) => (metric as { kind: string }).kind === 'strip',
    ) as { colorMs: number; jpegWriteMs: number }

    expect(writer.writeRows).toHaveBeenCalledTimes(2)
    expect(stripMetric.colorMs).toBeGreaterThan(1)
    expect(stripMetric.jpegWriteMs).toBeGreaterThan(0)
    expect(stripMetric.colorMs).toBeGreaterThan(stripMetric.jpegWriteMs)
  })

  it('decodes BT.709 LUT output before final sRGB JPEG encoding', async () => {
    const bt709EncodedGray = 0.4090077
    const lut = new Float32Array(2 * 2 * 2 * 3)
    lut.fill(bt709EncodedGray)
    const writtenRows: Array<{ bytes: Uint8Array; rowCount: number }> = []
    const writer = {
      writeRows: vi.fn(async (bytes: Uint8Array, rowCount: number) => {
        writtenRows.push({ bytes: new Uint8Array(bytes), rowCount })
      }),
      close: vi.fn(async () => makeJpegOutput()),
      abort: vi.fn(async () => undefined),
    }

    await runFullResolutionJpegExport({
      capability: makeCapability({
        width: 2,
        height: 1,
        rawWidth: 2,
        rawHeight: 1,
        visibleCrop: { x: 0, y: 0, width: 2, height: 1 },
      }),
      graph: {
        supported: true,
        outputGamut: 'srgb-rec709',
        outputTransfer: 'srgb',
        lutProfile: null,
        steps: [
          { kind: 'input-linear-prophoto' },
          IDENTITY_RAW_RENDER_EXPOSURE_STEP,
          ...neutralToneSteps(),
          {
            kind: 'gamut-to-lut-input',
            matrix: mat3Identity(),
            gamut: 'v-gamut',
          },
          { kind: 'encode-lut-transfer', transfer: 'v-log', range: 'full' },
          {
            kind: 'lut3d',
            size: 2,
            data: lut,
            domainMin: [0, 0, 0],
            domainMax: [1, 1, 1],
          },
          {
            kind: 'lut-output-to-srgb',
            matrix: mat3Identity(),
            transfer: 'bt709',
            range: 'full',
            role: 'combined-look-output',
            intensity: 1,
          },
          { kind: 'output-srgb' },
        ],
      },
      readProcessedWindow: vi.fn((request: LumaRawProcessedWindowRequest) =>
        Promise.resolve(makeProcessedWindow(request, 32768)),
      ),
      writerFactory: () => writer,
    })

    const bt709Linear = Math.pow((bt709EncodedGray + 0.099) / 1.099, 1 / 0.45)
    const expected = Math.round(linearToSrgb(bt709Linear) * 255)
    const encodedByte = Math.round(bt709EncodedGray * 255)

    expect(writtenRows).toHaveLength(1)
    expect(writtenRows[0]?.rowCount).toBe(1)
    expect(writtenRows[0]?.bytes).toHaveLength(6)
    expect(writtenRows[0]?.bytes.slice(0, 3)).toEqual(
      new Uint8Array([expected, expected, expected]),
    )
    expect(writtenRows[0]?.bytes.slice(3, 6)).toEqual(
      new Uint8Array([expected, expected, expected]),
    )
    expect(writtenRows[0]?.bytes[0]).not.toBe(encodedByte)
  })

  it('applies raw render exposure before final sRGB encoding', async () => {
    const writtenRows: Array<{ bytes: Uint8Array }> = []
    const writer = {
      writeRows: vi.fn(async (bytes: Uint8Array) => {
        writtenRows.push({ bytes: new Uint8Array(bytes) })
      }),
      close: vi.fn(async () => makeJpegOutput()),
      abort: vi.fn(async () => undefined),
    }

    await runFullResolutionJpegExport({
      capability: makeCapability(),
      graph: {
        supported: true,
        outputGamut: 'srgb-rec709',
        outputTransfer: 'srgb',
        lutProfile: null,
        steps: [
          { kind: 'input-linear-prophoto' },
          { kind: 'raw-render-exposure', ev: 1, multiplier: 2 },
          ...neutralToneSteps(),
          { kind: 'output-srgb' },
        ],
      },
      readProcessedWindow: vi.fn((request: LumaRawProcessedWindowRequest) =>
        Promise.resolve(makeProcessedWindow(request, 16384)),
      ),
      writerFactory: () => writer,
    })

    const expected = Math.round(linearToSrgb(0.5) * 255)
    const unexposed = Math.round(linearToSrgb(0.25) * 255)

    expect(writtenRows[0]?.bytes[0]).toBe(expected)
    expect(writtenRows[0]?.bytes[0]).not.toBe(unexposed)
  })

  it('applies raw render exposure before scene LUT input and base mixing', async () => {
    const intensity = 0.5
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

    const writtenRows: Array<{ bytes: Uint8Array }> = []
    const writer = {
      writeRows: vi.fn(async (bytes: Uint8Array) => {
        writtenRows.push({ bytes: new Uint8Array(bytes) })
      }),
      close: vi.fn(async () => makeJpegOutput()),
      abort: vi.fn(async () => undefined),
    }

    await runFullResolutionJpegExport({
      capability: makeCapability(),
      graph: {
        supported: true,
        outputGamut: 'srgb-rec709',
        outputTransfer: 'srgb',
        lutProfile: null,
        steps: [
          { kind: 'input-linear-prophoto' },
          { kind: 'raw-render-exposure', ev: 1, multiplier: 2 },
          ...neutralToneSteps(),
          {
            kind: 'gamut-to-lut-input',
            matrix: mat3Identity(),
            gamut: 'prophoto-rgb',
          },
          { kind: 'encode-lut-transfer', transfer: 'linear', range: 'full' },
          {
            kind: 'lut3d',
            size: 2,
            data: lut,
            domainMin: [0, 0, 0],
            domainMax: [0.5, 0.5, 0.5],
          },
          {
            kind: 'lut-output-to-srgb',
            matrix: mat3Identity(),
            transfer: 'linear',
            range: 'full',
            role: 'scene-creative',
            intensity,
          },
          { kind: 'output-srgb' },
        ],
      },
      readProcessedWindow: vi.fn((request: LumaRawProcessedWindowRequest) =>
        Promise.resolve(makeProcessedWindow(request, 16384)),
      ),
      writerFactory: () => writer,
    })

    const unexposedBaseLinear = 16384 / 65535
    const exposedBaseLinear = unexposedBaseLinear * 2
    const expectedLinear =
      exposedBaseLinear + (1 - exposedBaseLinear) * intensity
    const ignoresExposureForLutInput =
      exposedBaseLinear + (0.5 - exposedBaseLinear) * intensity
    const ignoresExposureForBaseMix =
      unexposedBaseLinear + (1 - unexposedBaseLinear) * intensity
    const expected = Math.round(clamp01(linearToSrgb(expectedLinear)) * 255)

    expect(writtenRows[0]?.bytes[0]).toBe(expected)
    expect(writtenRows[0]?.bytes[0]).not.toBe(
      Math.round(clamp01(linearToSrgb(ignoresExposureForLutInput)) * 255),
    )
    expect(writtenRows[0]?.bytes[0]).not.toBe(
      Math.round(clamp01(linearToSrgb(ignoresExposureForBaseMix)) * 255),
    )
  })

  it('uses the color graph before writing JPEG rows', async () => {
    const writtenRows: Array<{ rowCount: number; bytes: Uint8Array }> = []
    const readProcessedWindow = vi.fn(
      (request: LumaRawProcessedWindowRequest) =>
        Promise.resolve(makeProcessedWindow(request, 65535)),
    )
    const writer = {
      writeRows: vi.fn(async (bytes: Uint8Array, rowCount: number) => {
        writtenRows.push({ rowCount, bytes: new Uint8Array(bytes) })
      }),
      close: vi.fn(async () => makeJpegOutput()),
      abort: vi.fn(async () => undefined),
    }

    await runFullResolutionJpegExport({
      capability: makeCapability(),
      graph: {
        supported: true,
        outputGamut: 'srgb-rec709',
        outputTransfer: 'srgb',
        lutProfile: null,
        steps: [
          { kind: 'input-linear-prophoto' },
          IDENTITY_RAW_RENDER_EXPOSURE_STEP,
          ...neutralToneSteps(),
          { kind: 'output-srgb' },
        ],
      },
      preferredRows: 2,
      readProcessedWindow,
      writerFactory: () => writer,
    })

    expect(writtenRows.map((entry) => entry.rowCount)).toEqual([2, 2])
    expect(writtenRows[0]?.bytes[0]).toBe(255)
  })

  it('matches scene-referred LUT domain, range, decode, and intensity semantics', async () => {
    const writtenRows: Array<{ rowCount: number; bytes: Uint8Array }> = []
    const legalScale = (940 - 64) / 1023
    const legalOffset = 64 / 1023
    const domainMin = 0.25
    const domainMax = 0.75
    const intensity = 0.25
    const lut = new Float32Array(2 * 2 * 2 * 3)

    for (let blue = 0; blue < 2; blue += 1) {
      for (let green = 0; green < 2; green += 1) {
        for (let red = 0; red < 2; red += 1) {
          const value = red
          const index = ((blue * 2 + green) * 2 + red) * 3
          lut[index] = value
          lut[index + 1] = value
          lut[index + 2] = value
        }
      }
    }

    const writer = {
      writeRows: vi.fn(async (bytes: Uint8Array, rowCount: number) => {
        writtenRows.push({ rowCount, bytes: new Uint8Array(bytes) })
      }),
      close: vi.fn(async () => makeJpegOutput()),
      abort: vi.fn(async () => undefined),
    }

    await runFullResolutionJpegExport({
      capability: makeCapability(),
      graph: {
        supported: true,
        outputGamut: 'srgb-rec709',
        outputTransfer: 'srgb',
        lutProfile: null,
        steps: [
          { kind: 'input-linear-prophoto' },
          IDENTITY_RAW_RENDER_EXPOSURE_STEP,
          ...neutralToneSteps(),
          {
            kind: 'gamut-to-lut-input',
            matrix: mat3Identity(),
            gamut: 'prophoto-rgb',
          },
          {
            kind: 'encode-lut-transfer',
            transfer: 'gamma24',
            range: 'legal',
          },
          {
            kind: 'lut3d',
            size: 2,
            data: lut,
            domainMin: [domainMin, domainMin, domainMin],
            domainMax: [domainMax, domainMax, domainMax],
          },
          {
            kind: 'lut-output-to-srgb',
            matrix: mat3Identity(),
            transfer: 'gamma24',
            range: 'legal',
            role: 'scene-creative',
            intensity,
          },
          { kind: 'output-srgb' },
        ],
      },
      preferredRows: 2,
      readProcessedWindow: vi.fn((request: LumaRawProcessedWindowRequest) =>
        Promise.resolve(makeProcessedWindow(request, 32768)),
      ),
      writerFactory: () => writer,
    })

    const baseLinear = 32768 / 65535
    const lutInputEncoded =
      clamp01(Math.pow(baseLinear, 1 / 2.4)) * legalScale + legalOffset
    const normalized = clamp01(
      (lutInputEncoded - domainMin) / (domainMax - domainMin),
    )
    const lutOutputLinear = Math.max(
      Math.pow((normalized - legalOffset) / legalScale, 2.4),
      0,
    )
    const mixedLinear = baseLinear + (lutOutputLinear - baseLinear) * intensity
    const expectedByte = Math.round(clamp01(linearToSrgb(mixedLinear)) * 255)

    expect(writtenRows.map((entry) => entry.rowCount)).toEqual([2, 2])
    expect(writtenRows[0]?.bytes[0]).toBe(expectedByte)
    expect(writtenRows[0]?.bytes[0]).not.toBe(188)
  })
})
