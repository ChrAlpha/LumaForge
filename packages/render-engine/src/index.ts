// `@lumaforge/render-engine` top-level public surface.
//
// P2 of the render-engine extraction spec ships the skeleton: types +
// manifest utilities. Engine entry points (preview render, candidate
// render, export render) arrive in P3+.

// Context (the injection surface — see spec §5)
export type {
  CheckpointStore,
  LumaRenderContext,
  ManifestStore,
  OutputSink,
  OutputSinkHandle,
  OutputSinkMeta,
  OutputSinkResult,
  ProfileCache,
  ProfileFetcher,
  ProfileFetchOptions,
  RenderEvent,
} from './context/runtime-context'

// Manifest (types + canonicalize + hashes — spec §6, §6.6, §6.7, §7)
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
export type {
  ExportCheckpointManifest,
  ExportInProgress,
  JpegResumeState,
  OutputIntent,
  ResumeFingerprint,
  SourceReacquisitionMode,
} from './manifest/export-checkpoint'
export {
  type LutIdentityFailure,
  lutIdentityFromProfile,
} from './manifest/lut-identity'
export type {
  CalibrationIdentity,
  ColorBalanceParams,
  ColorGraphIdentity,
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
  sourceContentIdFromBytes,
  sourceContentIdFromFile,
  type SourceContentIdResult,
} from './manifest/source-content-id'
export {
  createStreamingSha256,
  sha256Hex,
  type StreamingSha256,
} from './manifest/streaming-sha256'

// Policy (input types — spec §4 policy/)
export type { CapabilityVector } from './policy/capability-input'
export { NODE_DEFAULT_CAPABILITY } from './policy/capability-input'
export type { ExportFidelity } from './policy/export-fidelity'
export type { RenderBudget } from './policy/render-budget'

// Export (pure-logic primitives migrated at P3a — spec §8)
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
