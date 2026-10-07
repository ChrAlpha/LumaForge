// `@lumaforge/render-engine` top-level public surface.

// Manifest (types + canonicalize + hashes)
export {
  canonicalizeJson,
  computeManifestSha256,
  sealRenderManifest,
  verifyManifestSha256,
} from './manifest/canonicalize'
export {
  COLOR_GRAPH_DESCRIPTOR_VERSION,
  type ColorGraphDescriptor,
  colorGraphIdentity,
  type ColorGraphLutProfileDescriptor,
  describeColorGraph,
  describeLutProfile,
  fingerprintColorGraph,
} from './manifest/color-graph-descriptor'
export {
  createRenderManifest,
  type CreateRenderManifestInput,
} from './manifest/create-render-manifest'
export {
  type LutIdentityFailure,
  lutIdentityFromProfile,
} from './manifest/lut-identity'
export type {
  CalibrationIdentity,
  ColorBalanceParams,
  ColorGraphIdentity,
  GeometryParams,
  LutCatalogIdentity,
  LutColorContract,
  LutIdentity,
  LutLocalFileIdentity,
  NativeArtifactEnvironment,
  OutputIdentity,
  PolicyChoice,
  RawRenderExposureSource,
  RenderEnvironment,
  RenderIdentity,
  RenderManifest,
  RenderManifestKind,
  RenderParams,
  RenderPolicyKind,
  SaturationParams,
  SelectiveColorBandShift,
  SourceRawIdentity,
  ToneCurveParams,
} from './manifest/render-manifest'
export {
  invertManifestRenderParams,
  type ManifestRenderParamsInput,
  type ManifestRenderParamsIntent,
  projectManifestRenderParams,
  type RecordedRawRenderExposure,
} from './manifest/render-params'
export {
  sourceContentIdFromBytes,
  sourceContentIdFromFile,
  type SourceContentIdResult,
} from './manifest/source-content-id'
export {
  createStreamingSha256,
  sha256Hex,
  type StreamingSha256,
} from './manifest/streaming-sha256'

// Policy (input types)
export type { CapabilityVector } from './policy/capability-input'

// Export (pure-logic primitives)
export { TypedBufferPool } from './export/buffer-pool'
export {
  normalizeExportConcurrency,
  runOrderedConcurrent,
} from './export/pipeline-concurrency'
export {
  type LinearProPhotoTile,
  type ProcessedRgb16Rows,
  processedWindowToLinearProPhotoTile,
  processedWindowToRgb16Rows,
} from './export/processed-window-transform'
export {
  expandRectWithHalo,
  type ExportStrip,
  MAX_EXPORT_STRIP_ROWS,
  normalizePreferredStripRows,
  planExportStrips,
  reduceStripRows,
} from './export/strip-scheduler'
