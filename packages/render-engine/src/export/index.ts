// `@lumaforge/render-engine/export` subpath entry.

export {
  assessProcessedExport,
  type ProcessedExportAssessment,
  type ProcessedExportRefusal,
} from './exportability'
export {
  applyGeometryMatte,
  EXPORT_GEOMETRY_MATTE,
  type ExportGeometry,
  type GeometryResampleTarget,
  type GeometrySourceWindow,
  type GeometryTile,
  INVALID_EXPORT_GEOMETRY,
  planExportGeometry,
  planGeometryTiles,
  type PlannedExportGeometry,
  resampleGeometryTile,
} from './geometry/export-geometry'
export { normalizeExportConcurrency } from './pipeline-concurrency'
export {
  type ProcessedWindowExportLifecycleInput,
  runProcessedWindowExportLifecycle,
} from './processed-window-export'
export {
  type ProcessedRgb16Rows,
  processedWindowToRgb16Rows,
} from './processed-window-transform'
export { normalizePreferredStripRows } from './strip-scheduler'

// Full-res export engine + JPEG row writer/sink + perf metrics
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
  type BlobOutputResult,
  type BytesOutputResult,
  createBlobOutputResult,
  createBytesOutputResult,
  type ExportOutputResult,
  type FileBackedOutputResult,
  materializeOutputBlob,
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
export type { ExportPerfMetric } from './perf/export-metrics'
