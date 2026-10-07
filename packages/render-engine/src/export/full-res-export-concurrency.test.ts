import type {
  LumaRawProcessedWindow,
  LumaRawProcessedWindowRequest,
} from '@lumaforge/luma-raw-runtime'
import { describe, expect, it, vi } from 'vitest'

import type { FullResExportResourceFailure } from './full-res-export'
import { runFullResolutionJpegExport } from './full-res-export'
import {
  IDENTITY_RAW_RENDER_EXPOSURE_STEP,
  makeCapability,
  makeJpegOutput,
  makeProcessedWindow,
  neutralToneSteps,
} from './full-res-export-test-fixtures'
import { materializeOutputBlob } from './jpeg/output-result'
import { createWasmJpegRowSink } from './jpeg/wasm-row-sink'

async function runFullResolutionJpegExportBlob(
  input: Parameters<typeof runFullResolutionJpegExport>[0],
) {
  return materializeOutputBlob(await runFullResolutionJpegExport(input))
}

describe('runFullResolutionJpegExport', () => {
  it('keeps JPEG writes ordered when concurrency is greater than one', async () => {
    const writtenFirstBytes: number[] = []
    const readOrder: number[] = []
    let releaseFirst!: () => void
    const firstRead = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const writer = {
      writeRows: vi.fn(async (bytes: Uint8Array) => {
        writtenFirstBytes.push(bytes[0] ?? -1)
      }),
      close: vi.fn(async () => makeJpegOutput([new Uint8Array([1])])),
      abort: vi.fn(async () => undefined),
    }

    const exportPromise = runFullResolutionJpegExport({
      capability: makeCapability({
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
      concurrency: 2,
      async readProcessedWindow(request) {
        readOrder.push(request.outputRect.y)
        if (request.outputRect.y === 0) {
          await firstRead
          return makeProcessedWindow(request, 0)
        }

        return makeProcessedWindow(request, 65535)
      },
      writerFactory: () => writer,
    })

    await Promise.resolve()
    expect(readOrder).toEqual([0, 64])
    expect(writer.writeRows).not.toHaveBeenCalled()

    releaseFirst()
    await exportPromise

    expect(writtenFirstBytes).toEqual([0, 255])
  })

  it('retries RESOURCE_ALLOCATION_FAILED with smaller strips and preserves JPEG dimensions', async () => {
    const writtenRows: Array<{ rowCount: number; bytes: Uint8Array }> = []
    let failedOnce = false
    const readProcessedWindow = vi.fn(
      (request: LumaRawProcessedWindowRequest) => {
        if (!failedOnce) {
          failedOnce = true
          return Promise.reject(new Error('RESOURCE_ALLOCATION_FAILED'))
        }

        return Promise.resolve(makeProcessedWindow(request))
      },
    )
    const writer = {
      writeRows: vi.fn(async (bytes: Uint8Array, rowCount: number) => {
        writtenRows.push({ rowCount, bytes: new Uint8Array(bytes) })
      }),
      close: vi.fn(async () => makeJpegOutput([new Uint8Array([1, 2, 3])])),
      abort: vi.fn(async () => undefined),
    }

    const blob = await runFullResolutionJpegExportBlob({
      capability: makeCapability({
        height: 256,
        rawHeight: 256,
        visibleCrop: { x: 0, y: 0, width: 4, height: 256 },
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
      preferredRows: 256,
      readProcessedWindow,
      writerFactory: () => writer,
    })

    expect(blob.type).toBe('image/jpeg')
    expect(writer.abort).toHaveBeenCalledTimes(1)
    expect(readProcessedWindow).toHaveBeenCalledTimes(3)
    expect(
      readProcessedWindow.mock.calls.map(
        ([request]) => request.outputRect.height,
      ),
    ).toEqual([256, 128, 128])
    expect(writtenRows.map((entry) => entry.rowCount)).toEqual([64, 64, 64, 64])
    expect(
      writtenRows.reduce((total, entry) => total + entry.rowCount, 0),
    ).toBe(256)
    expect(
      writtenRows.map((entry) => entry.bytes.length / (entry.rowCount * 3)),
    ).toEqual([4, 4, 4, 4])
  })

  it('cancels stale in-flight strip preparation before resource fallback retry', async () => {
    const events: string[] = []
    let staleReadResolved = false
    const firstWriter = {
      writeRows: vi.fn(async () => undefined),
      close: vi.fn(),
      abort: vi.fn(async () => undefined),
    }
    const secondWriter = {
      writeRows: vi.fn(async () => undefined),
      close: vi.fn(async () => makeJpegOutput([new Uint8Array([1])])),
      abort: vi.fn(async () => undefined),
    }
    const attemptWriters = [firstWriter, secondWriter]
    const readProcessedWindow = vi.fn(
      (
        request: LumaRawProcessedWindowRequest,
        signal?: AbortSignal,
      ): Promise<LumaRawProcessedWindow> => {
        if (request.outputRect.height === 256 && request.outputRect.y === 0) {
          events.push('stale-read-start')

          return new Promise<LumaRawProcessedWindow>((_resolve, reject) => {
            signal?.addEventListener(
              'abort',
              () => {
                events.push('stale-read-aborted')
                reject(new Error('STALE_ATTEMPT_ABORTED'))
              },
              { once: true },
            )

            if (signal?.aborted) {
              events.push('stale-read-aborted')
              reject(new Error('STALE_ATTEMPT_ABORTED'))
            }
          }).then((window) => {
            staleReadResolved = true
            return window
          })
        }

        if (request.outputRect.height === 256 && request.outputRect.y === 256) {
          events.push('resource-error')
          return Promise.reject(new Error('RESOURCE_ALLOCATION_FAILED'))
        }

        events.push(`retry-${request.outputRect.y}`)
        return Promise.resolve(makeProcessedWindow(request))
      },
    )

    const blob = await runFullResolutionJpegExportBlob({
      capability: makeCapability({
        height: 512,
        rawHeight: 512,
        visibleCrop: { x: 0, y: 0, width: 4, height: 512 },
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
      preferredRows: 256,
      concurrency: 2,
      readProcessedWindow,
      writerFactory: () => {
        const writer = attemptWriters.shift()
        if (!writer) {
          throw new Error('unexpected writer request')
        }
        return writer
      },
    })

    expect(blob.type).toBe('image/jpeg')
    expect(staleReadResolved).toBe(false)
    expect(events.slice(0, 3)).toEqual([
      'stale-read-start',
      'resource-error',
      'stale-read-aborted',
    ])
    expect(events.indexOf('stale-read-aborted')).toBeLessThan(
      events.indexOf('retry-0'),
    )
    expect(firstWriter.writeRows).not.toHaveBeenCalled()
    expect(firstWriter.abort).toHaveBeenCalledTimes(1)
    expect(secondWriter.writeRows).toHaveBeenCalledTimes(8)
    expect(secondWriter.close).toHaveBeenCalledTimes(1)
    expect(secondWriter.abort).not.toHaveBeenCalled()
  })

  it('surfaces resource failures for caller-managed fresh-worker retry', async () => {
    const writer = {
      writeRows: vi.fn(async () => undefined),
      close: vi.fn(),
      abort: vi.fn(async () => undefined),
    }

    await expect(
      runFullResolutionJpegExport({
        capability: makeCapability({
          height: 512,
          rawHeight: 512,
          visibleCrop: { x: 0, y: 0, width: 4, height: 512 },
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
        preferredRows: 256,
        concurrency: 2,
        retryPolicy: 'surface-resource-failure',
        readProcessedWindow: vi
          .fn()
          .mockRejectedValue(new Error('RESOURCE_ALLOCATION_FAILED')),
        writerFactory: () => writer,
      }),
    ).rejects.toMatchObject({
      name: 'FullResExportResourceFailure',
      message: 'FULL_RES_EXPORT_RESOURCE_FAILURE',
      nextRows: 128,
    } satisfies Partial<FullResExportResourceFailure>)

    expect(writer.abort).toHaveBeenCalledTimes(1)
  })

  it('retries with a fresh writer after a resource failure and emits performance metrics only for the successful attempt', async () => {
    const metrics: unknown[] = []
    const firstWriter = {
      writeRows: vi.fn(async () => undefined),
      close: vi.fn(),
      abort: vi.fn(async () => undefined),
    }
    const secondWriter = {
      writeRows: vi.fn(async () => undefined),
      close: vi.fn(async () => makeJpegOutput([new Uint8Array([1])])),
      abort: vi.fn(async () => undefined),
    }
    const attemptWriters = [firstWriter, secondWriter]
    let callCount = 0
    const readProcessedWindow = vi.fn(
      (request: LumaRawProcessedWindowRequest) => {
        callCount += 1
        if (callCount === 2) {
          return Promise.reject(new Error('RESOURCE_ALLOCATION_FAILED'))
        }

        return Promise.resolve(makeProcessedWindow(request))
      },
    )

    const blob = await runFullResolutionJpegExportBlob({
      capability: makeCapability({
        height: 512,
        rawHeight: 512,
        visibleCrop: { x: 0, y: 0, width: 4, height: 512 },
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
      preferredRows: 256,
      concurrency: 3,
      readProcessedWindow,
      writerFactory: () => {
        const writer = attemptWriters.shift()
        if (!writer) {
          throw new Error('unexpected writer request')
        }
        return writer
      },
      onMetric(metric) {
        metrics.push(metric)
      },
    })

    expect(blob.type).toBe('image/jpeg')
    expect(attemptWriters).toHaveLength(0)
    expect(readProcessedWindow).toHaveBeenCalledTimes(6)
    expect(readProcessedWindow.mock.calls[0]?.[0].outputRect.height).toBe(256)
    expect(readProcessedWindow.mock.calls[2]?.[0].outputRect.height).toBe(128)
    expect(readProcessedWindow.mock.calls[5]?.[0].outputRect.height).toBe(128)
    expect(firstWriter.writeRows).toHaveBeenCalledTimes(4)
    expect(firstWriter.abort).toHaveBeenCalledTimes(1)
    expect(firstWriter.close).not.toHaveBeenCalled()
    expect(secondWriter.writeRows).toHaveBeenCalledTimes(8)
    expect(secondWriter.close).toHaveBeenCalledTimes(1)
    expect(secondWriter.abort).not.toHaveBeenCalled()
    expect(metrics.map((metric) => (metric as { kind: string }).kind)).toEqual([
      'strip',
      'strip',
      'strip',
      'strip',
      'summary',
    ])
    expect(
      metrics
        .filter((metric) => (metric as { kind: string }).kind === 'strip')
        .map((metric) => ({
          rows: (metric as { rows: number }).rows,
          totalStrips: (metric as { totalStrips: number }).totalStrips,
        })),
    ).toEqual([
      { rows: 128, totalStrips: 4 },
      { rows: 128, totalStrips: 4 },
      { rows: 128, totalStrips: 4 },
      { rows: 128, totalStrips: 4 },
    ])
    expect(metrics.at(-1)).toMatchObject({
      kind: 'summary',
      stripRows: 128,
      retries: 1,
      concurrency: 1,
    })
  })

  it('retries writer allocation failures and throws FULL_RES_EXPORT_RESOURCE_FAILURE after exhaustion', async () => {
    const readProcessedWindow = vi.fn()
    const writerFactory = vi.fn(() => {
      throw new Error('RESOURCE_ALLOCATION_FAILED')
    })

    await expect(
      runFullResolutionJpegExport({
        capability: makeCapability({
          height: 256,
          rawHeight: 256,
          visibleCrop: { x: 0, y: 0, width: 4, height: 256 },
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
        preferredRows: 256,
        readProcessedWindow,
        writerFactory,
      }),
    ).rejects.toThrow('FULL_RES_EXPORT_RESOURCE_FAILURE')

    expect(writerFactory).toHaveBeenCalledTimes(3)
    expect(readProcessedWindow).not.toHaveBeenCalled()
  })

  it('retries wrapped JPEG encoder resource failures with smaller strips', async () => {
    const writtenRows: number[] = []
    let failedOnce = false
    let sessionCount = 0
    const jpegSink = createWasmJpegRowSink(() => ({
      createEncoder() {
        sessionCount += 1
        return {
          async writeRows(_bytes: Uint8Array, rowCount: number) {
            if (!failedOnce) {
              failedOnce = true
              throw new Error('RESOURCE_ALLOCATION_FAILED')
            }
            writtenRows.push(rowCount)
          },
          async finish() {
            return new Blob([new Uint8Array([1, 2, 3])], {
              type: 'image/jpeg',
            })
          },
          abort: vi.fn(),
        }
      },
      dispose: vi.fn(),
    }))

    const blob = await runFullResolutionJpegExportBlob({
      capability: makeCapability({
        height: 256,
        rawHeight: 256,
        visibleCrop: { x: 0, y: 0, width: 4, height: 256 },
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
      preferredRows: 256,
      readProcessedWindow: vi.fn((request: LumaRawProcessedWindowRequest) =>
        Promise.resolve(makeProcessedWindow(request)),
      ),
      jpegSink,
    })

    expect(blob.type).toBe('image/jpeg')
    expect(sessionCount).toBe(2)
    expect(writtenRows).toEqual([64, 64, 64, 64])
  })

  it('throws FULL_RES_EXPORT_RESOURCE_FAILURE after exhausting strip retries', async () => {
    const writer = {
      writeRows: vi.fn(),
      close: vi.fn(),
      abort: vi.fn(async () => undefined),
    }
    const readProcessedWindow = vi.fn(() =>
      Promise.reject(new Error('RESOURCE_ALLOCATION_FAILED')),
    )

    await expect(
      runFullResolutionJpegExport({
        capability: makeCapability({
          height: 256,
          rawHeight: 256,
          visibleCrop: { x: 0, y: 0, width: 4, height: 256 },
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
        preferredRows: 256,
        readProcessedWindow,
        writerFactory: () => writer,
      }),
    ).rejects.toThrow('FULL_RES_EXPORT_RESOURCE_FAILURE')

    expect(readProcessedWindow).toHaveBeenCalledTimes(3)
    expect(writer.writeRows).not.toHaveBeenCalled()
    expect(writer.abort).toHaveBeenCalledTimes(3)
  })
})
