import type {
  ExportColorGraphDescriptor,
  SupportedExportColorGraphDescriptor,
} from '@lumaforge/luma-color-runtime'
import { createRowBandProcessor } from '@lumaforge/luma-color-runtime'
import type {
  LumaRawExportCapability,
  LumaRawProcessedWindow,
  LumaRawProcessedWindowRequest,
} from '@lumaforge/luma-raw-runtime'

import type {
  ExportGeometry,
  PlannedExportGeometry,
} from './geometry/export-geometry'
import {
  applyGeometryMatte,
  planExportGeometry,
  preimageRect,
  resampleGeometryTile,
} from './geometry/export-geometry'
import type { JpegRowSink, JpegRowWriter } from './jpeg/row-writer'
import { createJpegRowWriter } from './jpeg/row-writer'
import { createWasmJpegRowSink } from './jpeg/wasm-row-sink'
import type { ExportPerfMetric } from './perf/export-metrics'
import { createExportMetricCollector, nowMs } from './perf/export-metrics'
import {
  normalizeExportConcurrency,
  runOrderedConcurrent,
} from './pipeline-concurrency'
import {
  processedWindowToRgb16Rows,
  processedWindowToSourceWindow,
} from './processed-window-transform'
import type { ExportStrip } from './strip-scheduler'
import {
  normalizePreferredStripRows,
  planExportStrips,
  reduceStripRows,
} from './strip-scheduler'

export type FullResolutionExportProgress = {
  completedStrips: number
  totalStrips: number
  progress: number
}

export type RunFullResolutionJpegExportInput = {
  capability: LumaRawExportCapability
  graph: ExportColorGraphDescriptor
  readProcessedWindow: (
    request: LumaRawProcessedWindowRequest,
    signal?: AbortSignal,
  ) => Promise<LumaRawProcessedWindow>
  signal?: AbortSignal
  onProgress?: (progress: FullResolutionExportProgress) => void
  metricContext?: {
    requestId: string
    fileName?: string
    browser?: string
  }
  onMetric?: (metric: ExportPerfMetric) => void
  preferredRows?: number
  concurrency?: number
  quality?: number
  jpegSink?: JpegRowSink
  writerFactory?: () => JpegRowWriter
  /**
   * Optional geometry applied at full resolution before the color graph. When
   * absent the export runs exactly as it did before geometry existed.
   */
  geometry?: ExportGeometry
  retryPolicy?: 'in-process' | 'surface-resource-failure'
  onCheckpoint?: (entry: {
    completedRowsForDiagnostics: number
    totalRows: number
    stripRows: number
  }) => void | Promise<void>
}

export class FullResExportResourceFailure extends Error {
  readonly nextRows: number

  constructor(nextRows: number) {
    super('FULL_RES_EXPORT_RESOURCE_FAILURE')
    this.name = 'FullResExportResourceFailure'
    this.nextRows = nextRows
  }
}

type PreparedStrip = {
  index: number
  rows: Array<{ bytes: Uint8Array; rowCount: number }>
  metrics: {
    rows: number
    rawReadMs: number
    colorMs: number
    totalMs: number
  }
}

type AttemptAbortScope = {
  signal: AbortSignal
  abort: () => void
  dispose: () => void
}

const MIN_EXPORT_STRIP_ROWS = 64
const DEFAULT_EXPORT_STRIP_ROWS = 512

/**
 * Geometry holds a whole strip of output in memory instead of one row band, so
 * its strips stay shorter than the ungeometried path's.
 */
const GEOMETRY_MAX_STRIP_ROWS = 256
/**
 * Column width of one resample tile. Wide enough that the per-tile window read
 * keeps its share of LibRaw's fixed cost small, narrow enough that a rotated
 * tile's preimage stays a few megabytes rather than a full-width band.
 */
const GEOMETRY_TILE_WIDTH = 2048
/** Bilinear taps reach one pixel past the preimage; two covers rounding. */
const GEOMETRY_HALO = 2
const NO_HALO = { left: 0, top: 0, right: 0, bottom: 0 } as const

function createWriter(
  input: RunFullResolutionJpegExportInput,
  output: { width: number; height: number },
) {
  if (input.writerFactory) {
    return input.writerFactory()
  }

  return createJpegRowWriter({
    width: output.width,
    height: output.height,
    quality: input.quality ?? 0.92,
    sink: input.jpegSink ?? createWasmJpegRowSink(),
  })
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new Error('FULL_RES_EXPORT_CANCELLED')
  }
}

function createAttemptAbortScope(
  parentSignal?: AbortSignal,
): AttemptAbortScope {
  const controller = new AbortController()
  const abort = () => {
    controller.abort()
  }

  if (parentSignal?.aborted) {
    abort()
  } else {
    parentSignal?.addEventListener('abort', abort, { once: true })
  }

  return {
    signal: controller.signal,
    abort,
    dispose() {
      parentSignal?.removeEventListener('abort', abort)
    },
  }
}

function isLibRawProcessedExportCapability(
  capability: LumaRawExportCapability,
) {
  const color = capability.color
  return (
    capability.supported === true &&
    capability.strategy === 'libraw-processed-window' &&
    capability.windows.librawProcessed === true &&
    color !== undefined &&
    'cameraWhiteBalanceAppliedByRuntime' in color &&
    'cameraMatrixAppliedByRuntime' in color &&
    color?.workingSpace === 'linear-prophoto-rgb' &&
    color.cameraWhiteBalanceAppliedByRuntime === true &&
    color.cameraMatrixAppliedByRuntime === true
  )
}

function currentErrorLooksLikeResourceExhaustion(error: unknown) {
  const tokens: string[] = []

  if (error instanceof Error) {
    tokens.push(error.name, error.message)
  }

  if (typeof error === 'object' && error && 'code' in error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string') {
      tokens.push(code)
    }
  }

  if (typeof error === 'string') {
    tokens.push(error)
  }

  const haystack = tokens.join(' ').toUpperCase()

  return (
    haystack.includes('RESOURCE_ALLOCATION_FAILED') ||
    haystack.includes('FULL_RES_EXPORT_RESOURCE_FAILURE') ||
    haystack.includes('OUT_OF_MEMORY') ||
    haystack.includes('MEMORY') ||
    haystack.includes('ALLOCATION')
  )
}

function getErrorCause(error: unknown) {
  if (typeof error === 'object' && error && 'cause' in error) {
    return (error as { cause?: unknown }).cause
  }

  return undefined
}

function looksLikeResourceExhaustion(error: unknown) {
  let current: unknown = error
  const seen = new Set<unknown>()

  while (current !== undefined && !seen.has(current)) {
    seen.add(current)
    if (currentErrorLooksLikeResourceExhaustion(current)) {
      return true
    }
    current = getErrorCause(current)
  }

  return false
}

/**
 * Strip preparer for a geometried export.
 *
 * Walks the output strip in column tiles, reads each tile's own preimage from
 * the source, resamples it into a strip-sized linear accumulator, then runs the
 * existing row-band color stage over the result. Memory is bounded by the strip
 * and one tile window, not by how far the geometry drags a row across the frame.
 */
function createGeometryStripPreparer(
  input: RunFullResolutionJpegExportInput,
  stripRows: number,
  graph: SupportedExportColorGraphDescriptor,
  planned: PlannedExportGeometry,
  signal: AbortSignal,
) {
  const outputWidth = planned.outputWidth
  const rowBandProcessor = createRowBandProcessor({
    width: outputWidth,
    rowBandRows: Math.min(64, stripRows),
    graph,
  })
  const stripData = new Uint16Array(outputWidth * stripRows * 3)
  const coverage = new Uint8Array(outputWidth * stripRows)
  const source = {
    width: input.capability.width,
    height: input.capability.height,
  }

  return async function prepareStrip(
    strip: ExportStrip,
    index: number,
  ): Promise<PreparedStrip> {
    throwIfAborted(signal)

    const stripStart = nowMs()
    const stripRect = strip.output
    const stripSamples = outputWidth * stripRect.height * 3
    const stripPixels = outputWidth * stripRect.height
    // Uncovered pixels must read as uncovered, not as the previous strip's.
    stripData.fill(0, 0, stripSamples)
    coverage.fill(0, 0, stripPixels)

    let rawReadMs = 0
    let colorMs = 0

    for (let tileX = 0; tileX < outputWidth; tileX += GEOMETRY_TILE_WIDTH) {
      throwIfAborted(signal)
      const tileRect = {
        x: tileX,
        y: stripRect.y,
        width: Math.min(GEOMETRY_TILE_WIDTH, outputWidth - tileX),
        height: stripRect.height,
      }
      const sourceRect = preimageRect(planned, tileRect, source, GEOMETRY_HALO)
      // No source behind this tile at all; it stays uncovered and is matted.
      if (!sourceRect) continue

      const rawStart = nowMs()
      const processedWindow = await input.readProcessedWindow(
        { outputRect: sourceRect, halo: NO_HALO },
        signal,
      )
      rawReadMs += nowMs() - rawStart

      throwIfAborted(signal)

      const resampleStart = nowMs()
      resampleGeometryTile({
        planned,
        source,
        window: processedWindowToSourceWindow(processedWindow, sourceRect),
        target: { stripRect, tileRect, data: stripData, coverage },
      })
      colorMs += nowMs() - resampleStart
    }

    const rows: PreparedStrip['rows'] = []
    for (
      let row = 0;
      row < stripRect.height;
      row += rowBandProcessor.rowBandRows
    ) {
      throwIfAborted(signal)
      const rowCount = Math.min(
        rowBandProcessor.rowBandRows,
        stripRect.height - row,
      )
      const bandStart = row * outputWidth * 3
      const rowColorStart = nowMs()
      const outputRows = rowBandProcessor.processUint16Rows(
        stripData.subarray(bandStart, bandStart + outputWidth * rowCount * 3),
        rowCount,
      )
      const bytes = new Uint8Array(outputRows)
      // Matte in output space: a linear matte fed through the color graph
      // would come back as whatever the tone curve and LUT made of it.
      applyGeometryMatte({
        rgb8: bytes,
        coverage,
        pixelCount: outputWidth * rowCount,
        coverageOffset: row * outputWidth,
      })
      rows.push({ bytes, rowCount })
      colorMs += nowMs() - rowColorStart
    }

    return {
      index,
      rows,
      metrics: {
        rows: stripRect.height,
        rawReadMs,
        colorMs,
        totalMs: nowMs() - stripStart,
      },
    }
  }
}

function createStripPreparer(
  input: RunFullResolutionJpegExportInput,
  stripRows: number,
  graph: SupportedExportColorGraphDescriptor,
  signal: AbortSignal,
) {
  const rowBandProcessor = createRowBandProcessor({
    width: input.capability.width,
    rowBandRows: Math.min(64, stripRows),
    graph,
  })
  const rgb16Band = new Uint16Array(
    input.capability.width * rowBandProcessor.rowBandRows * 3,
  )
  const rgb16BandViews = new Map<number, Uint16Array>()

  function getRgb16BandSource(sampleCount: number) {
    let source = rgb16BandViews.get(sampleCount)
    if (!source) {
      source = rgb16Band.subarray(0, sampleCount)
      rgb16BandViews.set(sampleCount, source)
    }

    return source
  }

  return async function prepareStrip(
    strip: ExportStrip,
    index: number,
  ): Promise<PreparedStrip> {
    throwIfAborted(signal)

    const stripStart = nowMs()
    const rawStart = nowMs()
    const processedWindow = await input.readProcessedWindow(
      {
        outputRect: strip.output,
        halo: { left: 2, top: 2, right: 2, bottom: 2 },
      },
      signal,
    )
    const rawReadMs = nowMs() - rawStart

    throwIfAborted(signal)

    const colorStart = nowMs()
    const tile = processedWindowToRgb16Rows(processedWindow, strip.output)
    let colorMs = nowMs() - colorStart
    const rows: PreparedStrip['rows'] = []

    for (let row = 0; row < tile.height; row += rowBandProcessor.rowBandRows) {
      throwIfAborted(signal)
      const rowCount = Math.min(rowBandProcessor.rowBandRows, tile.height - row)
      const sampleCount = tile.width * rowCount * 3
      const source = getRgb16BandSource(sampleCount)
      const rowColorStart = nowMs()
      for (let bandRow = 0; bandRow < rowCount; bandRow += 1) {
        source.set(tile.row(row + bandRow), bandRow * tile.width * 3)
      }
      const outputRows = rowBandProcessor.processUint16Rows(source, rowCount)
      rows.push({
        bytes: new Uint8Array(outputRows),
        rowCount,
      })
      colorMs += nowMs() - rowColorStart
    }

    return {
      index,
      rows,
      metrics: {
        rows: tile.height,
        rawReadMs,
        colorMs,
        totalMs: nowMs() - stripStart,
      },
    }
  }
}

export async function runFullResolutionJpegExport(
  input: RunFullResolutionJpegExportInput,
) {
  if (!isLibRawProcessedExportCapability(input.capability)) {
    throw new Error('FULL_RES_EXPORT_UNSUPPORTED_SOURCE')
  }

  if (!input.graph.supported) {
    throw new Error('FULL_RES_EXPORT_UNSUPPORTED_PIPELINE')
  }
  const graph = input.graph
  // Planning validates the geometry before a single window is read, so an
  // unexportable transform fails closed instead of part way through a file.
  const planned = input.geometry
    ? planExportGeometry(input.geometry, {
        width: input.capability.width,
        height: input.capability.height,
      })
    : null
  const outputSize = planned
    ? { width: planned.outputWidth, height: planned.outputHeight }
    : { width: input.capability.width, height: input.capability.height }

  const metricCollector = input.onMetric
    ? createExportMetricCollector({
        requestId: input.metricContext?.requestId ?? 'full-res-export',
        fileName: input.metricContext?.fileName,
        browser: input.metricContext?.browser,
        width: outputSize.width,
        height: outputSize.height,
      })
    : null
  const exportStart = nowMs()

  let stripRows = normalizePreferredStripRows(
    input.preferredRows ?? DEFAULT_EXPORT_STRIP_ROWS,
  )
  if (planned) {
    stripRows = Math.min(stripRows, GEOMETRY_MAX_STRIP_ROWS)
  }
  let concurrency = normalizeExportConcurrency(input.concurrency, 'balanced')
  let retries = 0

  while (true) {
    // Strips are planned over the OUTPUT frame; under geometry each one pulls
    // whatever source it needs rather than mapping to a source band.
    const strips = planExportStrips({
      width: outputSize.width,
      height: outputSize.height,
      preferredRows: stripRows,
      minRows: MIN_EXPORT_STRIP_ROWS,
      halo: 2,
    })
    let writer: JpegRowWriter | null = null
    let closed = false
    const attemptStripMetrics: ExportPerfMetric[] = []
    const attemptAbortScope = createAttemptAbortScope(input.signal)

    try {
      const makePreparer = () =>
        planned
          ? createGeometryStripPreparer(
              input,
              stripRows,
              graph,
              planned,
              attemptAbortScope.signal,
            )
          : createStripPreparer(
              input,
              stripRows,
              graph,
              attemptAbortScope.signal,
            )
      const availablePreparers: Array<ReturnType<typeof makePreparer>> = [
        makePreparer(),
      ]
      writer = createWriter(input, outputSize)
      let completedStrips = 0

      await runOrderedConcurrent(
        strips,
        concurrency,
        async (strip, index) => {
          const preparer = availablePreparers.pop() ?? makePreparer()

          try {
            return await preparer(strip, index)
          } finally {
            availablePreparers.push(preparer)
          }
        },
        async (prepared) => {
          throwIfAborted(attemptAbortScope.signal)

          let jpegWriteMs = 0
          for (const rowChunk of prepared.rows) {
            const jpegStart = nowMs()
            await writer!.writeRows(rowChunk.bytes, rowChunk.rowCount)
            jpegWriteMs += nowMs() - jpegStart
          }

          throwIfAborted(attemptAbortScope.signal)

          if (metricCollector) {
            attemptStripMetrics.push(
              metricCollector.record({
                kind: 'strip',
                stripIndex: prepared.index,
                totalStrips: strips.length,
                rows: prepared.metrics.rows,
                rawReadMs: prepared.metrics.rawReadMs,
                colorMs: prepared.metrics.colorMs,
                jpegWriteMs,
                totalMs: prepared.metrics.totalMs + jpegWriteMs,
              }),
            )
          }

          completedStrips += 1
          await input.onCheckpoint?.({
            completedRowsForDiagnostics: Math.min(
              outputSize.height,
              completedStrips * stripRows,
            ),
            totalRows: outputSize.height,
            stripRows,
          })
          input.onProgress?.({
            completedStrips,
            totalStrips: strips.length,
            progress:
              completedStrips === strips.length
                ? 99
                : Math.round((completedStrips / strips.length) * 100),
          })
        },
        {
          onError() {
            attemptAbortScope.abort()
          },
        },
      )

      const output = await writer.close()
      closed = true
      if (metricCollector) {
        for (const metric of attemptStripMetrics) {
          input.onMetric?.(metric)
        }

        input.onMetric?.(
          metricCollector.record({
            kind: 'summary',
            stripRows,
            retries,
            concurrency,
            totalMs: nowMs() - exportStart,
            outputBytes: output.byteLength,
          }),
        )
      }
      return output
    } catch (error) {
      attemptAbortScope.abort()

      if (writer && !closed) {
        try {
          await writer.abort()
        } catch {
          // Preserve the original orchestration failure.
        }
      }

      throwIfAborted(input.signal)

      if (!looksLikeResourceExhaustion(error)) {
        throw error
      }

      const nextStripRows = reduceStripRows(stripRows, MIN_EXPORT_STRIP_ROWS)

      if (input.retryPolicy === 'surface-resource-failure') {
        throw new FullResExportResourceFailure(nextStripRows)
      }

      if (nextStripRows >= stripRows && concurrency <= 1) {
        throw new Error('FULL_RES_EXPORT_RESOURCE_FAILURE')
      }

      concurrency = 1
      stripRows = nextStripRows
      retries += 1
    } finally {
      attemptAbortScope.dispose()
    }
  }
}
