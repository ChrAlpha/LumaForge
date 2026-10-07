import { createHash } from 'node:crypto'

import type { ExportColorGraphDescriptor } from '@lumaforge/luma-color-runtime'
import { createLumaJpegRuntimeForNode } from '@lumaforge/luma-jpeg-runtime/node'
import type {
  LumaRawExportCapability,
  LumaRawProcessedWindow,
  LumaRawProcessedWindowRequest,
} from '@lumaforge/luma-raw-runtime'
import type {
  ExportGeometry,
  JpegExportMetadata,
  JpegRowSink,
  ProcessedWindowExportLifecycleInput,
} from '@lumaforge/render-engine/export'
import {
  createBytesOutputResult,
  preserveJpegMetadataBytes,
  runFullResolutionJpegExport,
  runProcessedWindowExportLifecycle,
} from '@lumaforge/render-engine/export'

type Dimensions = { width: number; height: number }

/** SOF markers a baseline, extended or progressive encoder may write. */
const SOF_MARKERS = new Set([0xC0, 0xC1, 0xC2])

/**
 * The frame size the JPEG's SOF header declares, read from the bytes rather
 * than from whatever the producer reports about them.
 */
export function jpegFrameDimensions(jpeg: Uint8Array): Dimensions {
  if (jpeg[0] !== 0xFF || jpeg[1] !== 0xD8) throw new Error('not a JPEG')
  let offset = 2
  while (offset + 4 <= jpeg.byteLength && jpeg[offset] === 0xFF) {
    const marker = jpeg[offset + 1]!
    if (marker === 0xDA) break
    if (SOF_MARKERS.has(marker)) {
      return {
        height: (jpeg[offset + 5]! << 8) | jpeg[offset + 6]!,
        width: (jpeg[offset + 7]! << 8) | jpeg[offset + 8]!,
      }
    }
    offset += ((jpeg[offset + 2]! << 8) | jpeg[offset + 3]!) + 2
  }
  throw new Error('no SOF segment before the first scan')
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** A processed-window capability for a synthetic `frame` the engine admits. */
export function syntheticExportCapability(
  frame: Dimensions,
): LumaRawExportCapability {
  return {
    supported: true,
    strategy: 'libraw-processed-window',
    ...frame,
    rawWidth: frame.width,
    rawHeight: frame.height,
    visibleCrop: { x: 0, y: 0, ...frame },
    cfa: { pattern: 'rggb', xPhase: 0, yPhase: 0 },
    blackLevel: 0,
    whiteLevel: 255,
    orientation: { code: 1, supported: true },
    color: {
      workingSpace: 'linear-prophoto-rgb',
      librawOutputColor: 'prophoto',
      gamma: 'linear',
      cameraWhiteBalanceAppliedByRuntime: true,
      cameraMatrixAppliedByRuntime: true,
    },
    sensor: {
      layout: 'bayer',
      colorCount: 3,
      cfa: { pattern: 'rggb', xPhase: 0, yPhase: 0 },
      phaseIsWindowLocal: false,
    },
    windows: { librawProcessed: true, rawMosaic: false },
    diagnostics: {
      hasRawImage: true,
      hasColor3Image: false,
      hasColor4Image: false,
      hasXTransTable: false,
    },
    reasons: [],
  }
}

/**
 * A processed window of a synthetic `frame` with no mirror or rotational
 * symmetry: red ramps left to right, green ramps top to bottom, and blue
 * marks a block in the top-left corner. A horizontal or vertical mirror, a
 * half turn, or a shifted crop of this frame changes the pixels even where
 * it keeps the frame size.
 */
export function asymmetricProcessedWindow(
  request: LumaRawProcessedWindowRequest,
  frame: Dimensions,
): LumaRawProcessedWindow {
  const { x, y, width, height } = request.outputRect
  const data = new Uint16Array(width * height * 3)
  for (let row = 0; row < height; row += 1) {
    const sourceY = y + row
    for (let column = 0; column < width; column += 1) {
      const sourceX = x + column
      const at = (row * width + column) * 3
      data[at] = Math.round((sourceX / frame.width) * 60000)
      data[at + 1] = Math.round((sourceY / frame.height) * 60000)
      data[at + 2] =
        sourceX < frame.width / 4 && sourceY < frame.height / 3 ? 60000 : 4000
    }
  }
  return {
    rect: request.outputRect,
    workingSpace: 'linear-prophoto-rgb',
    data,
    width,
    height,
    stride: width * 3,
    normalized: false,
    orientationApplied: true,
    colorApplied: true,
    warnings: [],
  }
}

/** Encodes the executor's rows in memory with a JPEG runtime of its own. */
function createInMemoryJpegSink(): JpegRowSink {
  return {
    createSession({ width, height, quality }) {
      const runtime = createLumaJpegRuntimeForNode()
      const encoder = runtime.then((created) =>
        created.createEncoder({ width, height, quality }),
      )
      const dispose = () =>
        runtime.then((created) => created.dispose()).catch(() => undefined)
      return {
        async writeRows(rows, rowCount) {
          await (await encoder).writeRows(rows, rowCount)
        },
        async close() {
          try {
            const bytes = await (await encoder).finish()
            return createBytesOutputResult({ filename: 'reference.jpg', bytes })
          } finally {
            await dispose()
          }
        },
        async abort() {
          ;(await encoder.catch(() => null))?.abort()
          await dispose()
        },
      }
    },
  }
}

export type EngineExportReferenceInput = {
  capability: LumaRawExportCapability
  graph: ExportColorGraphDescriptor
  readProcessedWindow: (
    request: LumaRawProcessedWindowRequest,
  ) => Promise<LumaRawProcessedWindow>
  /** Encoder quality in 0..1. */
  quality: number
  preferredRows: number
  /** Literal geometry handed straight to the executor; absent exports the decoded frame. */
  geometry?: ExportGeometry
  /** EXIF source inserted with the engine's own metadata helper. */
  metadata?: JpegExportMetadata | null
  /** A real RAW session's processed-window export bracket. */
  lifecycle?: Pick<
    ProcessedWindowExportLifecycleInput<unknown>,
    'beginProcessedWindowExport' | 'endProcessedWindowExport'
  >
}

export type EngineExportReference = {
  bytes: Uint8Array
  sha256: string
  /** Frame size read from the reference's SOF header. */
  frame: Dimensions
}

/**
 * The bytes the engine executor itself delivers for these inputs:
 * `runFullResolutionJpegExport` runs with the literal geometry and an
 * in-memory encoder, and the engine's metadata helper inserts the EXIF. No
 * lmfg export adapter, file sink, or replay manifest mapping takes part, so
 * a reference made here cannot inherit a defect from them. It says what the
 * engine and this JPEG runtime deliver in Node; it is not evidence that the
 * browser's encoder or metadata writer produce the same bytes.
 */
export async function renderEngineExportReference(
  input: EngineExportReferenceInput,
): Promise<EngineExportReference> {
  const runExport = () =>
    runFullResolutionJpegExport({
      capability: input.capability,
      graph: input.graph,
      readProcessedWindow: input.readProcessedWindow,
      quality: input.quality,
      preferredRows: input.preferredRows,
      concurrency: 1,
      ...(input.geometry ? { geometry: input.geometry } : {}),
      jpegSink: createInMemoryJpegSink(),
    })
  const output = input.lifecycle
    ? await runProcessedWindowExportLifecycle({
        beginProcessedWindowExport: input.lifecycle.beginProcessedWindowExport,
        endProcessedWindowExport: input.lifecycle.endProcessedWindowExport,
        runExport,
      })
    : await runExport()
  if (output.kind !== 'bytes')
    throw new Error(`unexpected ${output.kind} output`)
  const encoded = jpegFrameDimensions(output.bytes)
  const bytes = preserveJpegMetadataBytes({
    jpeg: output.bytes,
    metadata: input.metadata,
    ...encoded,
  })
  return { bytes, sha256: sha256Hex(bytes), frame: jpegFrameDimensions(bytes) }
}
