import type { SupportedExportColorGraphDescriptor } from '@lumaforge/luma-color-runtime'
import {
  createRowBandProcessor,
  mat3Identity,
} from '@lumaforge/luma-color-runtime'
import type { LumaRawProcessedWindowRequest } from '@lumaforge/luma-raw-runtime'
import { describe, expect, it, vi } from 'vitest'

import { runFullResolutionJpegExport } from './full-res-export'
import {
  concatByteRows,
  makeCapability,
  makeJpegOutput,
  makePatternedProcessedWindow,
  makeProcessedWindow,
  makeRgbRampLut,
  neutralGraph,
  neutralSceneSteps,
} from './full-res-export-test-fixtures'

describe('runFullResolutionJpegExport', () => {
  it('writes row bands that match the same LUT graph applied to the full strip', async () => {
    const outputRect = { x: 0, y: 0, width: 3, height: 130 }
    const graph: SupportedExportColorGraphDescriptor = {
      supported: true,
      outputGamut: 'srgb-rec709',
      outputTransfer: 'srgb',
      lutProfile: null,
      steps: [
        ...neutralSceneSteps({
          rawRenderExposure: {
            ev: 0.1375,
            multiplier: 1.1,
            source: 'image-statistics',
          },
        }),
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
    const expectedRows = createRowBandProcessor({
      width: outputRect.width,
      rowBandRows: outputRect.height,
      graph,
    }).processUint16Rows(expectedWindow.data, outputRect.height)
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
        graph: neutralGraph(),
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
      graph: neutralGraph(),
      preferredRows: 2,
      readProcessedWindow,
      writerFactory: () => writer,
    })

    expect(writtenRows.map((entry) => entry.rowCount)).toEqual([2, 2])
    expect(writtenRows[0]?.bytes[0]).toBe(255)
  })
})
