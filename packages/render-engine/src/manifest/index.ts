// `@lumaforge/render-engine/manifest` subpath entry.

export {
  canonicalizeJson,
  computeManifestSha256,
  sealRenderManifest,
  verifyManifestSha256,
} from './canonicalize'
export {
  COLOR_GRAPH_DESCRIPTOR_VERSION,
  type ColorGraphDescriptor,
  colorGraphIdentity,
  type ColorGraphLutProfileDescriptor,
  describeColorGraph,
  describeLutProfile,
  fingerprintColorGraph,
} from './color-graph-descriptor'
export {
  createRenderManifest,
  type CreateRenderManifestInput,
} from './create-render-manifest'
export {
  checkRecordedExportGeometry,
  type RecordedDimensions,
  type RecordedExportFrame,
  type RecordedGeometryCheck,
  type RecordedGeometryRefusal,
} from './export-geometry'
export { type LutIdentityFailure, lutIdentityFromProfile } from './lut-identity'
export {
  parseRenderManifest,
  type ParseRenderManifestResult,
  type RenderManifestIssue,
} from './parse-render-manifest'
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
} from './render-manifest'
export {
  type ManifestRenderParamsInput,
  projectManifestRenderParams,
  type RecordedRawRenderExposure,
} from './render-params'
export {
  sourceContentIdFromBytes,
  type SourceContentIdResult,
} from './source-content-id'
export {
  createStreamingSha256,
  sha256Hex,
  type StreamingSha256,
} from './streaming-sha256'
