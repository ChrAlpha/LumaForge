import { createLumaJpegRuntime } from '@lumaforge/luma-jpeg-runtime'
import { createLumaRawRuntime } from '@lumaforge/luma-raw-runtime'
import type {
  ExportOutputResult,
  JpegExportMetadata,
  JpegRowSink,
} from '@lumaforge/render-engine/export'
import {
  createBlobOutputResult,
  JPEG_HEADER_SCAN_BYTES,
  materializeOutputBlob,
  planExportGeometry,
  planJpegMetadataInjection,
  preserveJpegMetadata,
  runFullResolutionJpegExport,
  sha256OfJpegWithMetadata,
} from '@lumaforge/render-engine/export'

import { sha256OfBlob } from './blob-sha256'
import type {
  FullResExportWorkerRequest,
  FullResExportWorkerResponse,
  FullResExportWorkerStartMessage,
  FullResWorkerOutputLocation,
  FullResWorkerOutputResult,
} from './full-res-export-client'
import {
  createOpfsFileBackedOutputResult,
  createOpfsOutputWritable,
} from './output-sink'

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

const OPFS_OUTPUT_FILE_NAME = 'output.jpg'

type OpfsOutputWritable = Awaited<ReturnType<typeof createOpfsOutputWritable>>

function isOpfsEntryName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value !== '.' &&
    value !== '..' &&
    !/[/\\]/.test(value)
  )
}

/**
 * The sink comes from the execution plan and its output location alone. An
 * `opfs-file` plan needs a well-formed OPFS location inside a tab directory,
 * and a blob-handoff plan must not carry one.
 */
function resolveOutputLocation(
  message: FullResExportWorkerStartMessage,
): FullResWorkerOutputLocation | null {
  const outputSink = message.executionPlan.outputSink
  const location: unknown = message.outputLocation

  if (outputSink === 'opfs-file') {
    if (
      typeof location !== 'object' ||
      location === null ||
      (location as { sink?: unknown }).sink !== 'opfs-file' ||
      !isOpfsEntryName((location as { tabDirectory?: unknown }).tabDirectory) ||
      !isOpfsEntryName((location as { exportId?: unknown }).exportId)
    ) {
      throw new Error('FULL_RES_EXPORT_OUTPUT_LOCATION_INVALID')
    }
    return location as FullResWorkerOutputLocation
  }

  if (location !== undefined && location !== null) {
    throw new Error('FULL_RES_EXPORT_OUTPUT_LOCATION_INVALID')
  }
  return null
}

async function openOpfsOutput(location: FullResWorkerOutputLocation) {
  try {
    return await createOpfsOutputWritable({
      tabDirectory: location.tabDirectory,
      exportId: location.exportId,
      outputFileName: OPFS_OUTPUT_FILE_NAME,
    })
  } catch {
    throw new Error('FULL_RES_EXPORT_OPFS_OUTPUT_UNAVAILABLE')
  }
}

function createOpfsJpegRowSink(input: {
  location: FullResWorkerOutputLocation
  filename: string
  /** Metadata the app injects lazily when the file-backed output is delivered. */
  metadata?: JpegExportMetadata | null
  /** Hands over the output opened before decode; null once it is taken. */
  takeOpenedWritable: () => OpfsOutputWritable | null
}): JpegRowSink {
  const outputFileName = OPFS_OUTPUT_FILE_NAME

  return {
    createSession({ width, height, quality }) {
      let byteLength = 0
      let state: 'open' | 'closed' | 'aborted' = 'open'
      const openedWritable = input.takeOpenedWritable()
      const writablePromise = openedWritable
        ? Promise.resolve(openedWritable)
        : createOpfsOutputWritable({
            tabDirectory: input.location.tabDirectory,
            exportId: input.location.exportId,
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
              tabDirectory: input.location.tabDirectory,
              exportId: input.location.exportId,
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

/**
 * Size of the frame the encoder wrote. Geometry crops it out of the source
 * frame, so it is read off the same plan the export engine ran rather than
 * the source capability.
 */
function deliveredFrameSize(
  geometry: FullResExportWorkerStartMessage['geometry'],
  source: { width: number; height: number },
) {
  if (!geometry) return { width: source.width, height: source.height }
  const planned = planExportGeometry(geometry, source)
  return { width: planned.outputWidth, height: planned.outputHeight }
}

async function prepareSuccessOutput(input: {
  output: ExportOutputResult
  outputLocation: FullResWorkerOutputLocation | null
  metadata: unknown
  width: number
  height: number
}): Promise<FullResWorkerOutputResult> {
  if (input.output.kind === 'file-backed') {
    // A file-backed result is only addressable inside the reserved location.
    if (!input.outputLocation) {
      throw new Error('FULL_RES_EXPORT_OUTPUT_LOCATION_INVALID')
    }
    return {
      kind: 'file-backed',
      storage: 'opfs',
      tabDirectory: input.outputLocation.tabDirectory,
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
    // The delivered JPEG, after metadata injection, is what the manifest
    // must identify.
    sha256: await sha256OfBlob(blobWithMetadata),
  })
}

function respond(response: FullResExportWorkerResponse) {
  self.postMessage(response)
}

// A worker runs one export; a cancel aborts the export it is running.
let runningExport: AbortController | null = null

async function handleStart(message: FullResExportWorkerStartMessage) {
  const controller = new AbortController()
  runningExport = controller
  const memoryProfile = message.executionPlan.runtimeMemoryProfile
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
  let unclaimedOpfsOutput: OpfsOutputWritable | null = null
  const takeOpenedOpfsOutput = () => {
    const writable = unclaimedOpfsOutput
    unclaimedOpfsOutput = null
    return writable
  }
  const discardUnclaimedOpfsOutput = async () => {
    const writable = takeOpenedOpfsOutput()
    if (!writable) return
    try {
      await writable.abort()
    } catch {
      // Preserve the export outcome.
    }
  }

  try {
    const outputLocation = resolveOutputLocation(message)
    // Opening the OPFS output before any decode work lets an unusable sink be
    // re-planned up front instead of failing part way through the file.
    if (outputLocation) {
      unclaimedOpfsOutput = await openOpfsOutput(outputLocation)
    }
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
      const exportMetadata = toJpegExportMetadata(session.probe)
      const capability = await session.probeExportCapability(controller.signal)
      const jpegSink = outputLocation
        ? createOpfsJpegRowSink({
            location: outputLocation,
            filename: message.filename,
            metadata: exportMetadata,
            takeOpenedWritable: takeOpenedOpfsOutput,
          })
        : undefined
      const output = await runFullResolutionJpegExport({
        capability,
        graph: message.graph,
        ...(message.geometry ? { geometry: message.geometry } : {}),
        preferredRows: message.executionPlan.preferredRows,
        concurrency: message.executionPlan.concurrency,
        quality: message.quality,
        jpegSink,
        signal: controller.signal,
        readProcessedWindow: session.readProcessedWindow,
        // A resource failure goes back to the page, which plans a fresh
        // worker for the retry.
        retryPolicy: 'surface-resource-failure',
        onProgress(progress) {
          respond({ kind: 'progress', progress })
        },
      })

      await discardUnclaimedOpfsOutput()
      const delivered = deliveredFrameSize(message.geometry, capability)
      const result = await prepareSuccessOutput({
        output,
        outputLocation,
        metadata: exportMetadata,
        width: delivered.width,
        height: delivered.height,
      })
      disposeSession()
      disposeRuntime()
      respond({ kind: 'success', result })
    } finally {
      disposeSession()
    }
  } catch (error) {
    await discardUnclaimedOpfsOutput()
    const nextRows = getErrorNextRows(error)
    respond({
      kind: 'error',
      message: toErrorMessage(error),
      ...(nextRows === undefined ? {} : { nextRows }),
    })
  } finally {
    disposeRuntime()
  }
}

self.onmessage = (event: MessageEvent<FullResExportWorkerRequest>) => {
  const message = event.data

  if (message.kind === 'cancel') {
    runningExport?.abort()
    return
  }

  void handleStart(message)
}

export {}
