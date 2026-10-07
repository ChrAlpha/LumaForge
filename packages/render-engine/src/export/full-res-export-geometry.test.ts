import type { SupportedExportColorGraphDescriptor } from '@lumaforge/luma-color-runtime'
import { mat3Identity } from '@lumaforge/luma-color-runtime'
import { describe, expect, it, vi } from 'vitest'

import { runFullResolutionJpegExport } from './full-res-export'
import {
  concatByteRows,
  IDENTITY_RAW_RENDER_EXPOSURE_STEP,
  makeCapability,
  makeJpegOutput,
  makePatternedProcessedWindow,
  makeRgbRampLut,
  neutralToneSteps,
} from './full-res-export-test-fixtures'
import {
  EXPORT_GEOMETRY_MATTE,
  INVALID_EXPORT_GEOMETRY,
  planExportGeometry,
} from './geometry/export-geometry'

describe('runFullResolutionJpegExport with geometry', () => {
  const geometryGraph: SupportedExportColorGraphDescriptor = {
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
  }

  function collectingWriter() {
    const writtenRows: Array<{ bytes: Uint8Array; rowCount: number }> = []
    const writer = {
      writeRows: vi.fn(async (bytes: Uint8Array, rowCount: number) => {
        writtenRows.push({ bytes: new Uint8Array(bytes), rowCount })
      }),
      close: vi.fn(async () => makeJpegOutput([new Uint8Array([1])])),
      abort: vi.fn(async () => undefined),
    }
    return { writer, writtenRows }
  }

  async function exportWithGeometry(options: {
    size: number
    geometry?: { matrix: number[]; constrainCrop: boolean }
    preferredRows: number
  }) {
    const rect = { x: 0, y: 0, width: options.size, height: options.size }
    const { writer, writtenRows } = collectingWriter()
    let windowReads = 0

    await runFullResolutionJpegExport({
      capability: makeCapability({
        width: options.size,
        height: options.size,
        rawWidth: options.size,
        rawHeight: options.size,
        visibleCrop: rect,
      }),
      graph: geometryGraph,
      preferredRows: options.preferredRows,
      concurrency: 1,
      readProcessedWindow: async (request) => {
        windowReads += 1
        return makePatternedProcessedWindow(request)
      },
      writerFactory: () => writer,
      ...(options.geometry ? { geometry: options.geometry } : {}),
    })

    return {
      bytes: concatByteRows(writtenRows.map((entry) => entry.bytes)),
      rowCounts: writtenRows.map((entry) => entry.rowCount),
      windowReads,
    }
  }

  it('matches the ungeometried export byte for byte under identity geometry', async () => {
    const plain = await exportWithGeometry({ size: 96, preferredRows: 64 })
    const identity = await exportWithGeometry({
      size: 96,
      preferredRows: 64,
      geometry: { matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1], constrainCrop: true },
    })

    // Identity geometry must not perturb a single pixel, otherwise the
    // resample is lying about what it does at rest.
    expect(identity.bytes).toEqual(plain.bytes)
  })

  it('produces the same bytes no matter how the output was tiled', async () => {
    const geometry = {
      matrix: [
        Math.cos(0.15),
        -Math.sin(0.15),
        0.08,
        Math.sin(0.15),
        Math.cos(0.15),
        0.04,
        0,
        0,
        1,
      ],
      constrainCrop: true,
    }
    const coarse = await exportWithGeometry({
      size: 96,
      preferredRows: 256,
      geometry,
    })
    const fine = await exportWithGeometry({
      size: 96,
      preferredRows: 64,
      geometry,
    })

    // Strip height changes the read plan but must not change the photograph.
    // This is what proves the bounded path is exact rather than approximate.
    expect(fine.windowReads).toBeGreaterThan(coarse.windowReads)
    expect(fine.bytes).toEqual(coarse.bytes)
  })

  it('writes the cropped output frame rather than the source frame', async () => {
    const size = 96
    const geometry = {
      matrix: [
        Math.cos(0.3),
        -Math.sin(0.3),
        0.15,
        Math.sin(0.3),
        Math.cos(0.3),
        0.08,
        0,
        0,
        1,
      ],
      constrainCrop: true,
    }
    const planned = planExportGeometry(geometry, {
      width: size,
      height: size,
    })
    const result = await exportWithGeometry({
      size,
      preferredRows: 64,
      geometry,
    })

    expect(planned.outputWidth).toBeLessThan(size)
    expect(result.rowCounts.reduce((total, count) => total + count, 0)).toBe(
      planned.outputHeight,
    )
    expect(result.bytes.length).toBe(
      planned.outputWidth * planned.outputHeight * 3,
    )
  })

  it('mattes the pixels an unconstrained crop leaves without source', async () => {
    const size = 64
    const result = await exportWithGeometry({
      size,
      preferredRows: 64,
      // Slide the frame sideways so the left edge has nothing behind it.
      geometry: {
        matrix: [1, 0, 0.5, 0, 1, 0, 0, 0, 1],
        constrainCrop: false,
      },
    })

    expect(Array.from(result.bytes.subarray(0, 3))).toEqual([
      ...EXPORT_GEOMETRY_MATTE,
    ])
    // The far edge still carries photograph, not matte.
    const lastPixel = result.bytes.subarray((size - 1) * 3, size * 3)
    expect(Array.from(lastPixel)).not.toEqual([...EXPORT_GEOMETRY_MATTE])
  })

  it('leaves a LUT pipeline byte-identical under identity geometry', async () => {
    const lutGraph: SupportedExportColorGraphDescriptor = {
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
        { kind: 'encode-lut-transfer', transfer: 'linear', range: 'full' },
        {
          kind: 'lut3d',
          size: 2,
          data: makeRgbRampLut(),
          domainMin: [0, 0, 0],
          domainMax: [1, 1, 1],
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

    const run = async (geometry?: {
      matrix: number[]
      constrainCrop: boolean
    }) => {
      const { writer, writtenRows } = collectingWriter()
      const rect = { x: 0, y: 0, width: 96, height: 96 }
      await runFullResolutionJpegExport({
        capability: makeCapability({
          width: 96,
          height: 96,
          rawWidth: 96,
          rawHeight: 96,
          visibleCrop: rect,
        }),
        graph: lutGraph,
        preferredRows: 64,
        concurrency: 1,
        readProcessedWindow: async (request) =>
          makePatternedProcessedWindow(request),
        writerFactory: () => writer,
        ...(geometry ? { geometry } : {}),
      })
      return concatByteRows(writtenRows.map((entry) => entry.bytes))
    }

    // Geometry resamples before the color graph. At identity that resample is
    // a copy, so a LUT pipeline has to come out untouched; any drift here
    // would mean the geometry stage is perturbing color, not just geometry.
    expect(
      await run({ matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1], constrainCrop: true }),
    ).toEqual(await run())
  })

  it('stops a geometried export promptly when the caller aborts', async () => {
    const controller = new AbortController()
    const { writer } = collectingWriter()
    let reads = 0

    const running = runFullResolutionJpegExport({
      capability: makeCapability({
        width: 256,
        height: 256,
        rawWidth: 256,
        rawHeight: 256,
        visibleCrop: { x: 0, y: 0, width: 256, height: 256 },
      }),
      graph: geometryGraph,
      preferredRows: 64,
      concurrency: 1,
      signal: controller.signal,
      readProcessedWindow: async (request) => {
        reads += 1
        // Abort while the export is between tiles rather than before it began.
        if (reads === 1) controller.abort()
        return makePatternedProcessedWindow(request)
      },
      writerFactory: () => writer,
      geometry: {
        matrix: [
          Math.cos(0.2),
          -Math.sin(0.2),
          0.05,
          Math.sin(0.2),
          Math.cos(0.2),
          0.03,
          0,
          0,
          1,
        ],
        constrainCrop: true,
      },
    })

    await expect(running).rejects.toThrow('FULL_RES_EXPORT_CANCELLED')
    const readsAtAbort = reads
    await new Promise((resolve) => setTimeout(resolve, 20))
    // Nothing keeps reading after the rejection; an abort that only stopped
    // the writer would leave the tile loop pulling windows in the background.
    expect(reads).toBe(readsAtAbort)
    expect(writer.close).not.toHaveBeenCalled()
  })

  it('fails closed on a geometry that cannot be exported', async () => {
    const { writer } = collectingWriter()
    const readProcessedWindow = vi.fn()

    await expect(
      runFullResolutionJpegExport({
        capability: makeCapability(),
        graph: geometryGraph,
        preferredRows: 2,
        readProcessedWindow,
        writerFactory: () => writer,
        geometry: { matrix: [1, 0, 0, 0, 1, 0, 0, -2, 1], constrainCrop: true },
      }),
    ).rejects.toThrow(INVALID_EXPORT_GEOMETRY)

    // Validation happens before any window is read or any byte is written.
    expect(readProcessedWindow).not.toHaveBeenCalled()
    expect(writer.writeRows).not.toHaveBeenCalled()
  })
})
