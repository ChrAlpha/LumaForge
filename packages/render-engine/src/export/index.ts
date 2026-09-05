// `@lumaforge/render-engine/export` subpath entry.
//
// P3a (this phase) ships the pure-logic primitives the export engine uses.
// The orchestrator function itself (`runFullResolutionJpegExport`) moves at
// P3b once the wasm-row-sink + row-writer adapter seams are refactored to
// the spec's `OutputSink` interface.

export { TypedBufferPool } from './buffer-pool'
export {
  normalizeExportConcurrency,
  runOrderedConcurrent,
} from './pipeline-concurrency'
export {
  type LinearProPhotoTile,
  type ProcessedRgb16Rows,
  processedWindowToLinearProPhotoTile,
  processedWindowToRgb16Rows,
} from './processed-window-transform'
export {
  expandRectWithHalo,
  type ExportStrip,
  MAX_EXPORT_STRIP_ROWS,
  normalizePreferredStripRows,
  planExportStrips,
  reduceStripRows,
} from './strip-scheduler'

// P3b: full-res export engine + JPEG row writer/sink + perf metrics
export {
  FullResExportResourceFailure,
  type FullResolutionExportProgress,
  runFullResolutionJpegExport,
  type RunFullResolutionJpegExportInput,
} from './full-res-export'
export {
  JPEG_HEADER_SCAN_BYTES,
  type JpegExportMetadata,
  type JpegMetadataInjectionPlan,
  planJpegMetadataInjection,
  preserveJpegMetadata,
  preserveJpegMetadataBytes,
  type PreserveJpegMetadataBytesInput,
  type PreserveJpegMetadataInput,
  sha256OfJpegWithMetadata,
} from './jpeg/jpeg-metadata'
export {
  type BytesJpegEncoder,
  type BytesJpegRuntime,
  createNodeJpegRowSink,
} from './jpeg/node-row-sink'
export {
  type BlobOutputResult,
  type BytesOutputResult,
  createBlobOutputResult,
  createBytesOutputResult,
  type ExportOutputResult,
  type FileBackedOutputResult,
} from './jpeg/output-result'
export {
  createJpegRowWriter,
  type JpegRowSink,
  type JpegRowSinkSession,
  type JpegRowWriter,
} from './jpeg/row-writer'
export {
  createWasmJpegRowSink,
  isWasmJpegRuntimeAvailable,
  JPEG_RUNTIME_UNAVAILABLE_MESSAGE,
} from './jpeg/wasm-row-sink'
export {
  createExportMetricCollector,
  type ExportPerfMetric,
  formatExportMetricJsonl,
  nowMs,
} from './perf/export-metrics'
