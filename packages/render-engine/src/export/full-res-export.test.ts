import type { LumaRawProcessedWindowRequest } from '@lumaforge/luma-raw-runtime'
import { describe, expect, it, vi } from 'vitest'

import { runFullResolutionJpegExport } from './full-res-export'
import {
  IDENTITY_RAW_RENDER_EXPOSURE_STEP,
  makeCapability,
  makeJpegOutput,
  makePatternedProcessedWindow,
  makeProcessedWindow,
  neutralToneSteps,
} from './full-res-export-test-fixtures'
import type { FileBackedOutputResult } from './jpeg/output-result'
import { materializeOutputBlob } from './jpeg/output-result'

async function runFullResolutionJpegExportBlob(
  input: Parameters<typeof runFullResolutionJpegExport>[0],
) {
  return materializeOutputBlob(await runFullResolutionJpegExport(input))
}

describe('runFullResolutionJpegExport', () => {
  it('reports strip progress and returns the JPEG blob', async () => {
    const progress: number[] = []
    const writtenRows: Array<{ rowCount: number; bytes: Uint8Array }> = []
    const readProcessedWindow = vi.fn(
      (request: LumaRawProcessedWindowRequest) =>
        Promise.resolve(makeProcessedWindow(request)),
    )
    const writer = {
      writeRows: vi.fn(async (bytes: Uint8Array, rowCount: number) => {
        writtenRows.push({ rowCount, bytes: new Uint8Array(bytes) })
      }),
      close: vi.fn(async () => makeJpegOutput([new Uint8Array([1, 2, 3])])),
      abort: vi.fn(async () => undefined),
    }

    const blob = await runFullResolutionJpegExportBlob({
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
      onProgress(entry) {
        progress.push(entry.progress)
      },
    })

    expect(blob.type).toBe('image/jpeg')
    expect(readProcessedWindow).toHaveBeenCalledTimes(1)
    expect(writtenRows.map((entry) => entry.rowCount)).toEqual([2, 2])
    expect(writtenRows.map((entry) => entry.bytes)).toEqual([
      new Uint8Array(4 * 2 * 3).fill(188),
      new Uint8Array(4 * 2 * 3).fill(188),
    ])
    expect(progress.at(-1)).toBe(99)
    expect(progress).not.toContain(100)
  })

  it('keeps completion progress below 100 while the writer output is closing', async () => {
    const progress: number[] = []
    const writer = {
      writeRows: vi.fn(async () => undefined),
      close: vi.fn(async () => {
        expect(progress).not.toContain(100)
        return makeJpegOutput([new Uint8Array([1, 2, 3])])
      }),
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
      readProcessedWindow: async (request) => makeProcessedWindow(request),
      writerFactory: () => writer,
      onProgress(entry) {
        progress.push(entry.progress)
      },
    })

    expect(writer.close).toHaveBeenCalledTimes(1)
    expect(progress.at(-1)).toBe(99)
    expect(progress).not.toContain(100)
  })

  it('does not allocate a full-strip Float32 tile while writing row bands', async () => {
    const outputRect = { x: 0, y: 0, width: 3, height: 130 }
    const fullStripSampleCount = outputRect.width * outputRect.height * 3
    const rowBandSampleCount = outputRect.width * 64 * 3
    const allocations: number[] = []
    const OriginalFloat32Array = globalThis.Float32Array
    const Float32ArraySpy = new Proxy(OriginalFloat32Array, {
      construct(target, args, newTarget) {
        if (typeof args[0] === 'number') {
          allocations.push(args[0])
        }

        return Reflect.construct(target, args, newTarget)
      },
    })
    const writtenRows: Array<{ bytes: Uint8Array; rowCount: number }> = []
    const writer = {
      writeRows: vi.fn(async (bytes: Uint8Array, rowCount: number) => {
        writtenRows.push({ bytes: new Uint8Array(bytes), rowCount })
      }),
      close: vi.fn(async () => makeJpegOutput([new Uint8Array([1])])),
      abort: vi.fn(async () => undefined),
    }

    Object.defineProperty(globalThis, 'Float32Array', {
      configurable: true,
      writable: true,
      value: Float32ArraySpy,
    })

    try {
      await runFullResolutionJpegExport({
        capability: makeCapability({
          width: outputRect.width,
          height: outputRect.height,
          rawWidth: outputRect.width,
          rawHeight: outputRect.height,
          visibleCrop: outputRect,
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
            { kind: 'output-srgb' },
          ],
        },
        preferredRows: outputRect.height,
        readProcessedWindow: async (request) =>
          makePatternedProcessedWindow(request),
        writerFactory: () => writer,
      })
    } finally {
      Object.defineProperty(globalThis, 'Float32Array', {
        configurable: true,
        writable: true,
        value: OriginalFloat32Array,
      })
    }

    expect(writtenRows.map((entry) => entry.rowCount)).toEqual([64, 64, 2])
    expect(allocations).toContain(rowBandSampleCount)
    expect(allocations).not.toContain(fullStripSampleCount)
  })

  it('keeps retained custom-writer row views stable across reusable row bands', async () => {
    const outputRect = { x: 0, y: 0, width: 3, height: 130 }
    const retainedRows: Uint8Array[] = []
    const snapshots: Uint8Array[] = []
    const rowCounts: number[] = []
    const writer = {
      writeRows: vi.fn(async (bytes: Uint8Array, rowCount: number) => {
        retainedRows.push(bytes)
        snapshots.push(new Uint8Array(bytes))
        rowCounts.push(rowCount)
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
      preferredRows: outputRect.height,
      readProcessedWindow: async (request) =>
        makePatternedProcessedWindow(request),
      writerFactory: () => writer,
    })

    expect(rowCounts).toEqual([64, 64, 2])
    expect(retainedRows).toHaveLength(3)
    expect(new Set(retainedRows.map((row) => row.buffer)).size).toBe(
      retainedRows.length,
    )
    retainedRows.forEach((row, index) => {
      expect(row).toEqual(snapshots[index])
    })
  })

  it('normalizes fractional preferred rows before scheduling processed windows', async () => {
    const writtenRows: number[] = []
    const readProcessedWindow = vi.fn(
      (request: LumaRawProcessedWindowRequest) =>
        Promise.resolve(makeProcessedWindow(request)),
    )
    const writer = {
      writeRows: vi.fn(async (_bytes: Uint8Array, rowCount: number) => {
        writtenRows.push(rowCount)
      }),
      close: vi.fn(async () => makeJpegOutput()),
      abort: vi.fn(async () => undefined),
    }

    await runFullResolutionJpegExport({
      capability: makeCapability({
        height: 130,
        rawHeight: 130,
        visibleCrop: { x: 0, y: 0, width: 4, height: 130 },
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
          { kind: 'output-srgb' },
        ],
      },
      preferredRows: 64.5,
      readProcessedWindow,
      writerFactory: () => writer,
    })

    expect(
      readProcessedWindow.mock.calls.map(
        ([request]) => request.outputRect.height,
      ),
    ).toEqual([64, 64, 2])
    expect(writtenRows).toEqual([64, 64, 2])
  })

  it('maps full export strips to processed windows and writes requested output rows', async () => {
    const writtenRows: number[] = []
    const readProcessedWindow = vi.fn(
      (request: LumaRawProcessedWindowRequest) =>
        Promise.resolve(makeProcessedWindow(request)),
    )
    const writer = {
      writeRows: vi.fn(async (_bytes: Uint8Array, rowCount: number) => {
        writtenRows.push(rowCount)
      }),
      close: vi.fn(async () => makeJpegOutput()),
      abort: vi.fn(async () => undefined),
    }

    await runFullResolutionJpegExport({
      capability: makeCapability({
        width: 4,
        height: 4,
        rawWidth: 20,
        rawHeight: 30,
        visibleCrop: { x: 5, y: 7, width: 4, height: 4 },
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
          { kind: 'output-srgb' },
        ],
      },
      preferredRows: 2,
      readProcessedWindow,
      writerFactory: () => writer,
    })

    expect(readProcessedWindow.mock.calls.map(([request]) => request)).toEqual([
      {
        outputRect: { x: 0, y: 0, width: 4, height: 4 },
        halo: { left: 2, top: 2, right: 2, bottom: 2 },
      },
    ])
    expect(writtenRows).toEqual([2, 2])
  })

  it('returns file-backed writer output without materializing it', async () => {
    const openBlob = vi.fn(async () => new Blob(['jpeg']))
    const output: FileBackedOutputResult = {
      kind: 'file-backed',
      exportId: 'export-1',
      filename: 'frame.jpg',
      byteLength: 4,
      mimeType: 'image/jpeg',
      openBlob,
    }
    const writer = {
      writeRows: vi.fn(async () => undefined),
      close: vi.fn(async () => output),
      abort: vi.fn(async () => undefined),
    }

    await expect(
      runFullResolutionJpegExport({
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
        preferredRows: 4,
        readProcessedWindow: async (request) => makeProcessedWindow(request),
        writerFactory: () => writer,
      }),
    ).resolves.toBe(output)
    expect(openBlob).not.toHaveBeenCalled()
  })

  it('emits a checkpoint after each committed strip', async () => {
    const checkpoints: unknown[] = []
    const writer = {
      writeRows: vi.fn(async () => undefined),
      close: vi.fn(async () => makeJpegOutput([new Uint8Array([1])])),
      abort: vi.fn(async () => undefined),
    }

    await runFullResolutionJpegExport({
      capability: makeCapability({
        height: 130,
        rawHeight: 130,
        visibleCrop: { x: 0, y: 0, width: 4, height: 130 },
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
          { kind: 'output-srgb' },
        ],
      },
      preferredRows: 64,
      concurrency: 1,
      readProcessedWindow: vi.fn((request: LumaRawProcessedWindowRequest) =>
        Promise.resolve(makeProcessedWindow(request)),
      ),
      writerFactory: () => writer,
      onCheckpoint(entry) {
        checkpoints.push(entry)
      },
    })

    expect(checkpoints).toEqual([
      { completedRowsForDiagnostics: 64, totalRows: 130, stripRows: 64 },
      { completedRowsForDiagnostics: 128, totalRows: 130, stripRows: 64 },
      { completedRowsForDiagnostics: 130, totalRows: 130, stripRows: 64 },
    ])
  })

  it('emits strip and summary performance metrics without changing output rows', async () => {
    const metrics: unknown[] = []
    const writtenRows: Array<{ rowCount: number; bytes: Uint8Array }> = []
    const writer = {
      writeRows: vi.fn(async (bytes: Uint8Array, rowCount: number) => {
        writtenRows.push({ rowCount, bytes: new Uint8Array(bytes) })
      }),
      close: vi.fn(async () => makeJpegOutput([new Uint8Array([1])])),
      abort: vi.fn(async () => undefined),
    }

    const blob = await runFullResolutionJpegExportBlob({
      capability: makeCapability({
        width: 4,
        height: 128,
        rawHeight: 128,
        visibleCrop: { x: 0, y: 0, width: 4, height: 128 },
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
          { kind: 'output-srgb' },
        ],
      },
      preferredRows: 64,
      readProcessedWindow: async (request) => makeProcessedWindow(request),
      writerFactory: () => writer,
      onMetric(metric) {
        metrics.push(metric)
      },
    })

    expect(blob.type).toBe('image/jpeg')
    expect(writer.writeRows).toHaveBeenCalledTimes(2)
    expect(writtenRows.map((entry) => entry.rowCount)).toEqual([64, 64])
    expect(
      writtenRows.reduce((total, entry) => total + entry.rowCount, 0),
    ).toBe(128)
    expect(writtenRows.map((entry) => entry.bytes)).toEqual([
      new Uint8Array(4 * 64 * 3).fill(188),
      new Uint8Array(4 * 64 * 3).fill(188),
    ])
    expect(metrics.map((metric) => (metric as { kind: string }).kind)).toEqual([
      'strip',
      'strip',
      'summary',
    ])
    expect(metrics.at(-1)).toMatchObject({
      kind: 'summary',
      concurrency: 2,
    })
  })
})
