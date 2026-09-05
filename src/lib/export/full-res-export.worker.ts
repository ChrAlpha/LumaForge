import { createLumaJpegRuntime } from '@lumaforge/luma-jpeg-runtime'
import { createLumaRawRuntime } from '@lumaforge/luma-raw-runtime'
import type {
  JpegExportMetadata,
  JpegRowSink,
} from '@lumaforge/render-engine/export'
import {
  JPEG_HEADER_SCAN_BYTES,
  planJpegMetadataInjection,
  preserveJpegMetadata,
  runFullResolutionJpegExport,
  sha256OfJpegWithMetadata,
} from '@lumaforge/render-engine/export'
import { createStreamingSha256 } from '@lumaforge/render-engine/manifest'

import { createRawExportSession } from '../raw/export-runtime-adapter'
import type {
  FullResExportWorkerRequest,
  FullResExportWorkerResponse,
  FullResWorkerOutputResult,
} from './full-res-export-client'
import type { ExportOutputResult } from './output-sink'
import {
  createBlobOutputResult,
  createOpfsFileBackedOutputResult,
  createOpfsOutputWritable,
  materializeOutputBlob,
} from './output-sink'

type ProcessedWindowExportLifecycleInput<Result> = {
  beginProcessedWindowExport?: (signal?: AbortSignal) => Promise<unknown>
  endProcessedWindowExport?: (signal?: AbortSignal) => Promise<unknown>
  runExport: () => Promise<Result>
  signal?: AbortSignal
}

function toErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message
  }

  return 'FULL_RES_EXPORT_FAILED'
}

function getErrorNextRows(error: unknown) {
  if (typeof error === 'object' && error && 'nextRows' in error) {
    const nextRows = (error as { nextRows?: unknown }).nextRows
    if (typeof nextRows === 'number') {
      return nextRows
    }
  }

  return undefined
}

function createOpfsJpegRowSink(input: {
  exportId: string
  filename: string
  outputFileName?: string
  /** Metadata the app injects lazily when the file-backed output is delivered. */
  metadata?: JpegExportMetadata | null
}): JpegRowSink {
  const outputFileName = input.outputFileName ?? 'output.jpg'

  return {
    createSession({ width, height, quality }) {
      let byteLength = 0
      let state: 'open' | 'closed' | 'aborted' = 'open'
      const writablePromise = createOpfsOutputWritable({
        exportId: input.exportId,
        outputFileName,
      })
      const runtime = createLumaJpegRuntime({
        async onChunk(chunk) {
          const writable = await writablePromise
          const byteBuffer = chunk.bytes.buffer.slice(
            chunk.bytes.byteOffset,
            chunk.bytes.byteOffset + chunk.bytes.byteLength,
          ) as ArrayBuffer
          await writable.write(byteBuffer)
          byteLength += chunk.bytes.byteLength
        },
      })
      const encoder = runtime.createEncoder({
        width,
        height,
        quality,
        finishMode: 'chunks',
      })

      function assertOpen() {
        if (state === 'aborted') {
          throw new Error('JPEG_WRITER_ABORTED')
        }
        if (state === 'closed') {
          throw new Error('JPEG_WRITER_CLOSED')
        }
      }

      async function abortWritable() {
        try {
          const writable = await writablePromise
          if ('abort' in writable && typeof writable.abort === 'function') {
            await writable.abort()
          }
        } catch {
          // Preserve the primary encoder/export failure.
        }
      }

      async function abortSession() {
        if (state === 'aborted' || state === 'closed') {
          return
        }

        state = 'aborted'
        try {
          encoder.abort()
        } finally {
          await abortWritable()
          runtime.dispose()
        }
      }

      return {
        async writeRows(rows, rowCount) {
          assertOpen()
          try {
            await encoder.writeRows(rows, rowCount)
          } catch (error) {
            try {
              await abortSession()
            } catch {
              // Preserve the original encoder failure.
            }
            throw error
          }
        },
        async close() {
          assertOpen()
          try {
            await encoder.finish()
            const writable = await writablePromise
            // File-backed output stays metadata-free on disk; the app injects
            // EXIF on delivery, so the recorded hash must describe that layout.
            const finalized = await writable.close({
              hash: (bytes) =>
                sha256OfJpegWithMetadata(
                  bytes,
                  planJpegMetadataInjection({
                    header: bytes.subarray(
                      0,
                      Math.min(bytes.length, JPEG_HEADER_SCAN_BYTES),
                    ),
                    fullSize: bytes.length,
                    metadata: input.metadata,
                    width,
                    height,
                  }),
                ),
            })
            state = 'closed'
            runtime.dispose()
            return createOpfsFileBackedOutputResult({
              exportId: input.exportId,
              filename: input.filename,
              byteLength,
              mimeType: 'image/jpeg',
              outputFileName,
              sha256: finalized.sha256,
            })
          } catch (error) {
            try {
              await abortSession()
            } catch {
              // Preserve the original finish failure.
            }
            throw error
          }
        },
        async abort() {
          await abortSession()
        },
      }
    },
  }
}

const JPEG_EXPORT_METADATA_KEYS = [
  'make',
  'model',
  'lens',
  'iso',
  'aperture',
  'focalLength',
  'shutter',
  'shutterSpeed',
  'timestamp',
] as const

/**
 * Project the RAW probe onto the EXIF fields the encoder injects, so the same
 * plain object is hashed in the worker and injected on delivery.
 */
function toJpegExportMetadata(probe: unknown): JpegExportMetadata | null {
  if (!probe || typeof probe !== 'object') return null
  const source = probe as Record<string, unknown>
  const metadata: Record<string, unknown> = {}
  for (const key of JPEG_EXPORT_METADATA_KEYS) {
    const value = source[key]
    if (value === undefined || value === null) continue
    metadata[key] = value
  }
  return Object.keys(metadata).length > 0
    ? (metadata as JpegExportMetadata)
    : null
}

async function prepareSuccessOutput(input: {
  output: ExportOutputResult
  metadata: unknown
  width: number
  height: number
}): Promise<FullResWorkerOutputResult> {
  if (input.output.kind === 'file-backed') {
    return {
      kind: 'file-backed',
      storage: 'opfs',
      exportId: input.output.exportId,
      filename: input.output.filename,
      byteLength: input.output.byteLength,
      mimeType: input.output.mimeType,
      ...(input.output.sha256 ? { sha256: input.output.sha256 } : {}),
      deliveryMetadata: input.metadata as JpegExportMetadata | null | undefined,
    }
  }

  const blobWithMetadata = await preserveJpegMetadata({
    jpeg: await materializeOutputBlob(input.output),
    metadata: input.metadata as JpegExportMetadata | null | undefined,
    width: input.width,
    height: input.height,
  })

  return createBlobOutputResult({
    filename: input.output.filename,
    blob: blobWithMetadata,
    sha256: await sha256OfBlobBytes(blobWithMetadata),
  })
}

function readBlobBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === 'function') {
    return blob.arrayBuffer().then((buffer) => new Uint8Array(buffer))
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener('load', () => {
      resolve(new Uint8Array(reader.result as ArrayBuffer))
    })
    reader.addEventListener('error', () => {
      reject(reader.error ?? new Error('Blob read failed.'))
    })
    reader.readAsArrayBuffer(blob)
  })
}

/** The delivered JPEG (after metadata injection) is what the manifest must identify. */
async function sha256OfBlobBytes(blob: Blob): Promise<string> {
  const hasher = createStreamingSha256()
  hasher.update(await readBlobBytes(blob))
  return hasher.digestHex()
}

const activeRequests = new Map<string, AbortController>()

export async function runProcessedWindowExportLifecycle<Result>({
  beginProcessedWindowExport,
  endProcessedWindowExport,
  runExport,
  signal,
}: ProcessedWindowExportLifecycleInput<Result>): Promise<Result> {
  let processedWindowExportActive = false

  if (beginProcessedWindowExport) {
    await beginProcessedWindowExport(signal)
    processedWindowExportActive = true
  }

  let primaryError: unknown
  let cleanupError: unknown
  let hasPrimaryError = false
  let result: Result

  try {
    result = await runExport()
  } catch (error) {
    primaryError = error
    hasPrimaryError = true
  }

  if (processedWindowExportActive && endProcessedWindowExport) {
    try {
      await endProcessedWindowExport()
    } catch (error) {
      cleanupError = error
    }
  }

  if (hasPrimaryError) {
    throw primaryError
  }

  if (cleanupError !== undefined) {
    throw cleanupError
  }

  return result!
}

async function handleStart(
  message: Extract<FullResExportWorkerRequest, { kind: 'start' }>,
) {
  const controller = new AbortController()
  activeRequests.set(message.requestId, controller)
  const memoryProfile = message.executionPlan?.runtimeMemoryProfile ?? 'desktop'
  const runtime = createLumaRawRuntime({
    memoryProfile,
    requireCrossOriginIsolation: memoryProfile === 'desktop',
  })
  let runtimeDisposed = false
  const disposeRuntime = () => {
    if (runtimeDisposed) {
      return
    }

    runtimeDisposed = true
    runtime.dispose()
  }

  try {
    await runtime.init()
    const session = await runtime.openSession(
      message.file,
      undefined,
      controller.signal,
    )
    let sessionDisposed = false
    const disposeSession = () => {
      if (sessionDisposed) {
        return
      }

      sessionDisposed = true
      session.dispose()
    }

    try {
      const exportSession = createRawExportSession(session)
      const exportMetadata = toJpegExportMetadata(session.probe)
      const capability = await exportSession.probeExportCapability(
        controller.signal,
      )
      const jpegSink =
        message.executionPlan?.outputSink === 'opfs-file' && message.checkpoint
          ? createOpfsJpegRowSink({
              exportId: message.checkpoint.exportId,
              filename:
                message.filename ?? `${message.checkpoint.exportId}.jpg`,
              metadata: exportMetadata,
            })
          : undefined
      const output = await runProcessedWindowExportLifecycle({
        beginProcessedWindowExport: exportSession.beginProcessedWindowExport,
        endProcessedWindowExport: exportSession.endProcessedWindowExport,
        signal: controller.signal,
        runExport() {
          return runFullResolutionJpegExport({
            capability,
            graph: message.graph,
            preferredRows:
              message.executionPlan?.preferredRows ?? message.preferredRows,
            concurrency:
              message.executionPlan?.concurrency ?? message.concurrency,
            quality: message.quality,
            jpegSink,
            signal: controller.signal,
            readProcessedWindow: exportSession.readProcessedWindow,
            retryPolicy:
              message.executionPlan?.checkpointMode === 'safe-retry'
                ? 'surface-resource-failure'
                : 'in-process',
            onCheckpoint: message.checkpoint
              ? async (entry) => {
                  self.postMessage({
                    kind: 'metric',
                    requestId: message.requestId,
                    metric: {
                      kind: 'checkpoint',
                      requestId: message.requestId,
                      completedRowsForDiagnostics:
                        entry.completedRowsForDiagnostics,
                      totalRows: entry.totalRows,
                      stripRows: entry.stripRows,
                      timestamp: new Date().toISOString(),
                    },
                  } satisfies FullResExportWorkerResponse)
                }
              : undefined,
            onProgress(progress) {
              self.postMessage({
                kind: 'progress',
                requestId: message.requestId,
                progress,
              } satisfies FullResExportWorkerResponse)
            },
            ...(message.collectMetrics
              ? {
                  metricContext: {
                    requestId: message.requestId,
                    fileName: message.file.name,
                    browser: globalThis.navigator?.userAgent,
                  },
                  onMetric(metric) {
                    self.postMessage({
                      kind: 'metric',
                      requestId: message.requestId,
                      metric,
                    } satisfies FullResExportWorkerResponse)
                  },
                }
              : {}),
          })
        },
      })

      const result = await prepareSuccessOutput({
        output,
        metadata: exportMetadata,
        width: capability.width,
        height: capability.height,
      })
      disposeSession()
      disposeRuntime()
      self.postMessage({
        kind: 'success',
        requestId: message.requestId,
        result,
      } satisfies FullResExportWorkerResponse)
    } finally {
      disposeSession()
    }
  } catch (error) {
    const nextRows = getErrorNextRows(error)
    self.postMessage({
      kind: 'error',
      requestId: message.requestId,
      message: toErrorMessage(error),
      ...(nextRows === undefined ? {} : { nextRows }),
    } satisfies FullResExportWorkerResponse)
  } finally {
    activeRequests.delete(message.requestId)
    disposeRuntime()
  }
}

self.onmessage = (event: MessageEvent<FullResExportWorkerRequest>) => {
  const message = event.data

  if (message.kind === 'cancel') {
    activeRequests.get(message.requestId)?.abort()
    return
  }

  void handleStart(message)
}

export {}
