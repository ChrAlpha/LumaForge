import type {
  ExportColorGraphDescriptor,
  SupportedExportColorGraphDescriptor,
} from '@lumaforge/luma-color-runtime'
import {
  createHdrGainMapRowBandProcessor,
  createRowBandProcessor,
  HDR_GAIN_MAP_NEUTRAL_CODE,
  resolveHdrGainMapSupport,
} from '@lumaforge/luma-color-runtime'
import type {
  LumaRawExportCapability,
  LumaRawProcessedWindow,
  LumaRawProcessedWindowRequest,
} from '@lumaforge/luma-raw-runtime'

import { assessProcessedExport } from './exportability'
import type {
  ExportGeometry,
  PlannedExportGeometry,
} from './geometry/export-geometry'
import {
  applyGeometryMatte,
  planExportGeometry,
  planGeometryTiles,
  resampleGeometryTile,
} from './geometry/export-geometry'
import {
  createGainMapContainer,
  HDR_GAIN_MAP_JPEG_QUALITY,
} from './jpeg/gain-map-container'
import type { ExportOutputResult } from './jpeg/output-result'
import { materializeOutputBlob } from './jpeg/output-result'
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
  /**
   * Export an ISO 21496-1 gain-map JPEG: the SDR export, byte for byte, as
   * the primary image, plus the gain map to the graph's HDR rendition. A
   * graph without one (a LUT look) is refused before any read. The gain map
   * is encoded through `sink` (the WASM encoder by default) and handed to
   * the primary sink when it closes.
   */
  hdrGainMap?: { sink?: JpegRowSink }
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
  rows: Array<{
    bytes: Uint8Array
    /** The gain map rows of a gain-map export, matching `bytes`. */
    gainMap: Uint8Array | null
    rowCount: number
  }>
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
 * Ceiling on one tile's source window, in pixels. Sized to sit alongside the
 * ungeometried path, which reads a full-width strip (about 6M pixels for a
 * 100 MP frame at the default strip height).
 */
const GEOMETRY_MAX_WINDOW_PIXELS = 4_000_000
/** Splitting stops here; below this the per-read overhead stops paying off. */
const GEOMETRY_MIN_TILE_WIDTH = 64
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

const GAIN_MAP_MATTE = [
  HDR_GAIN_MAP_NEUTRAL_CODE,
  HDR_GAIN_MAP_NEUTRAL_CODE,
  HDR_GAIN_MAP_NEUTRAL_CODE,
] as const

/**
 * The row-band color stage of one strip preparer: the SDR bytes, plus the
 * gain map rows when the export carries one. Both reuse their buffers.
 */
type StripColorStage = {
  rowBandRows: number
  process: (
    source: Uint16Array,
    rowCount: number,
  ) => { sdr: Uint8Array; gainMap: Uint8Array | null }
}

function createStripColorStage(input: {
  width: number
  rowBandRows: number
  graph: SupportedExportColorGraphDescriptor
  gainMap: boolean
}): StripColorStage {
  const { width, rowBandRows, graph } = input
  if (input.gainMap) {
    const processor = createHdrGainMapRowBandProcessor({
      width,
      rowBandRows,
      graph,
    })
    return {
      rowBandRows: processor.rowBandRows,
      process: (source, rowCount) =>
        processor.processUint16Rows(source, rowCount),
    }
  }
  const processor = createRowBandProcessor({ width, rowBandRows, graph })
  return {
    rowBandRows: processor.rowBandRows,
    process: (source, rowCount) => ({
      sdr: processor.processUint16Rows(source, rowCount),
      gainMap: null,
    }),
  }
}

function createGainMapWriter(
  input: RunFullResolutionJpegExportInput,
  output: { width: number; height: number },
) {
  if (!input.hdrGainMap) return null
  return createJpegRowWriter({
    width: output.width,
    height: output.height,
    quality: HDR_GAIN_MAP_JPEG_QUALITY,
    sink: input.hdrGainMap.sink ?? createWasmJpegRowSink(),
  })
}

async function outputBytes(output: ExportOutputResult) {
  if (output.kind === 'bytes') return output.bytes
  return new Uint8Array(
    await (await materializeOutputBlob(output)).arrayBuffer(),
  )
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
  const rowBandProcessor = createStripColorStage({
    width: outputWidth,
    rowBandRows: Math.min(64, stripRows),
    graph,
    gainMap: Boolean(input.hdrGainMap),
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

    // Tiles are planned per strip: how far the geometry drags a row varies
    // down the frame, so the split that keeps a read bounded does too.
    const tiles = planGeometryTiles({
      planned,
      stripRect: {
        x: 0,
        y: stripRect.y,
        width: outputWidth,
        height: stripRect.height,
      },
      source,
      maxWindowPixels: GEOMETRY_MAX_WINDOW_PIXELS,
      minTileWidth: GEOMETRY_MIN_TILE_WIDTH,
      halo: GEOMETRY_HALO,
    })

    for (const { tileRect, sourceRect } of tiles) {
      throwIfAborted(signal)
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
      const outputRows = rowBandProcessor.process(
        stripData.subarray(bandStart, bandStart + outputWidth * rowCount * 3),
        rowCount,
      )
      const bytes = new Uint8Array(outputRows.sdr)
      // Matte in output space: a linear matte fed through the color graph
      // would come back as whatever the tone curve and LUT made of it.
      applyGeometryMatte({
        rgb8: bytes,
        coverage,
        pixelCount: outputWidth * rowCount,
        coverageOffset: row * outputWidth,
      })
      const gainMap = outputRows.gainMap
        ? new Uint8Array(outputRows.gainMap)
        : null
      if (gainMap) {
        // The matte has no HDR rendition of its own: no gain.
        applyGeometryMatte({
          rgb8: gainMap,
          coverage,
          pixelCount: outputWidth * rowCount,
          coverageOffset: row * outputWidth,
          matte: GAIN_MAP_MATTE,
        })
      }
      rows.push({ bytes, gainMap, rowCount })
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
  const rowBandProcessor = createStripColorStage({
    width: input.capability.width,
    rowBandRows: Math.min(64, stripRows),
    graph,
    gainMap: Boolean(input.hdrGainMap),
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
      const outputRows = rowBandProcessor.process(source, rowCount)
      rows.push({
        bytes: new Uint8Array(outputRows.sdr),
        gainMap: outputRows.gainMap ? new Uint8Array(outputRows.gainMap) : null,
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
  // The source gate runs before any window read or sink session, so a
  // capability the assessment refuses never starts an export.
  if (!assessProcessedExport(input.capability).exportable) {
    throw new Error('FULL_RES_EXPORT_UNSUPPORTED_SOURCE')
  }

  if (!input.graph.supported) {
    throw new Error('FULL_RES_EXPORT_UNSUPPORTED_PIPELINE')
  }
  const graph = input.graph
  if (input.hdrGainMap && !resolveHdrGainMapSupport(graph).supported) {
    throw new Error('FULL_RES_EXPORT_HDR_UNSUPPORTED_LOOK')
  }
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
    let gainMapWriter: JpegRowWriter | null = null
    let closed = false
    let gainMapClosed = false
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
      gainMapWriter = createGainMapWriter(input, outputSize)
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
            if (gainMapWriter) {
              if (!rowChunk.gainMap)
                throw new Error('HDR_GAIN_MAP_ROWS_MISSING')
              await gainMapWriter.writeRows(rowChunk.gainMap, rowChunk.rowCount)
            }
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

      let output: ExportOutputResult
      if (gainMapWriter) {
        const gainMapOutput = await gainMapWriter.close()
        gainMapClosed = true
        output = await writer.close({
          gainMapContainer: createGainMapContainer(
            await outputBytes(gainMapOutput),
          ),
        })
        closed = true
        // A sink that did not store the gain map would deliver an SDR file.
        if (!output.gainMap) {
          throw new Error('FULL_RES_EXPORT_GAIN_MAP_SINK_UNSUPPORTED')
        }
      } else {
        output = await writer.close()
        closed = true
      }
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
      if (gainMapWriter && !gainMapClosed) {
        try {
          await gainMapWriter.abort()
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
