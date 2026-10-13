# Changelog

All notable changes to `@lumaforge/render-engine` are documented here. The
format follows Keep a Changelog; versions follow semver. Release 0.1.0
predates this file.

## Unreleased

### Breaking

- Removed `TypedBufferPool`, `processedWindowToLinearProPhotoTile`,
  `LinearProPhotoTile`, `runOrderedConcurrent`, `planExportStrips`,
  `reduceStripRows`, `expandRectWithHalo`, `MAX_EXPORT_STRIP_ROWS` and
  `ExportStrip` from `@lumaforge/render-engine` and
  `@lumaforge/render-engine/export`, and `processedWindowToSourceWindow`,
  `preimageRect`, `createExportMetricCollector`, `formatExportMetricJsonl` and
  `nowMs` from `@lumaforge/render-engine/export`. They were internal steps of
  the full-resolution export, which no consumer called; export metrics still
  reach `onMetric` as `ExportPerfMetric` records.
- Removed `invertManifestRenderParams` and `ManifestRenderParamsIntent`
  from `@lumaforge/render-engine` and `@lumaforge/render-engine/manifest`. No
  production reader used them; a replaying reader maps a parsed manifest's
  `render_params` onto its own params schema (as `lmfg` does).
- Removed `candidateRender` and its `CandidateParams`, `CandidateResult`,
  `CandidateRenderOptions` and `CandidateRenderSource` types from
  `@lumaforge/render-engine/preview`. Render a candidate with
  `renderCpuPreviewFrame` and encode it with `encodePreviewFrameToJpeg`, as
  `lmfg` does for each one.
- `decideBoundedHqPreview` is no longer exported from
  `@lumaforge/render-engine/preview`; `createProgressivePreviewPlan` returns
  its decision as `boundedHq`.
- `RawRenderExposureSource` is no longer exported from
  `@lumaforge/render-engine` or `@lumaforge/render-engine/manifest`; import it
  from `@lumaforge/luma-color-runtime`, which defines it.
- `@lumaforge/render-engine/export` no longer re-exports `applyMatrix`,
  `invertMatrix`, `isMatrix3` and `Matrix3`; import them from
  `@lumaforge/render-engine/geometry`.

### Changed

- `createStreamingSha256` and `sha256Hex` hash about three times faster: the
  compression runs on 32-bit integer words over whole blocks at a time and
  allocates nothing per block (Node 24, a 64 MiB buffer fed in 64 KiB chunks:
  73 MB/s before, about 250 MB/s after). Digests are unchanged.

## 0.2.0 - 2026-10-12

This release removes and changes public exports, which a 0.x package releases
as a minor version.

Requires `@lumaforge/luma-color-runtime` 0.2.1, `@lumaforge/luma-jpeg-runtime`
0.2.0 and `@lumaforge/luma-raw-runtime` 0.2.0 as peers; the `workspace:*` peer
ranges publish as those exact versions. Publish order:
`@lumaforge/luma-native-artifacts` 0.0.5, then `@lumaforge/luma-color-runtime`
0.2.1, `@lumaforge/luma-jpeg-runtime` 0.2.0 and `@lumaforge/luma-raw-runtime`
0.2.0, then `@lumaforge/render-engine` 0.2.0, then `@lumaforge/lmfg-cli`
0.2.0, then `@lumaforge/lmfg-mcp` 0.1.0.

### Breaking

- Removed `LumaRenderContext` and the types it was built from:
  `CheckpointStore`, `ManifestStore`, `OutputSink`, `OutputSinkHandle`,
  `OutputSinkMeta`, `OutputSinkResult`, `ProfileCache`, `ProfileFetcher`,
  `ProfileFetchOptions` and `RenderEvent` (root entry). No engine function
  accepted the context; pass explicit inputs instead:
  `runFullResolutionJpegExport` takes `capability`, `jpegSink` (a
  `JpegRowSink`, e.g. `createWasmJpegRowSink`), `signal` and `onProgress`,
  and the policy functions take a `CapabilityVector`. Export sinks return
  `ExportOutputResult` from `@lumaforge/render-engine/export`.
- Removed `ExportCheckpointManifest` and the types it was built from:
  `ExportInProgress`, `JpegResumeState`, `OutputIntent`, `ResumeFingerprint`
  and `SourceReacquisitionMode` (root and `./manifest` entries). No engine
  function read or wrote the export journal; an interrupted export reruns
  from the start. `RenderIdentity` stays as the identity block of
  `RenderManifest`.
- Removed `RenderBudget`, `ExportFidelity` and `NODE_DEFAULT_CAPABILITY` from
  `@lumaforge/render-engine` and `@lumaforge/render-engine/policy`. No engine
  function took any of them. Use `PerformancePreference` instead of
  `ExportFidelity`; it accepts the same values (`'safe'`, `'balanced'`,
  `'max'`), and `normalizeExportConcurrency` now declares its second
  parameter as `PerformancePreference` with unchanged results. The engine has
  no default capability vector: pass a `CapabilityVector` that describes the
  actual host to `deriveExportPolicy`, `deriveInteractivePolicy` and
  `deriveRuntimeResourceBudget`. Export concurrency and row slicing still
  come from `deriveExportPolicy`, and `candidateRender` still takes its own
  `maxConcurrent`.
- Removed `sourceContentIdFromFile` from `@lumaforge/render-engine` and
  `@lumaforge/render-engine/manifest`. It read the whole Blob into memory
  before hashing. Call `sourceContentIdFromBytes` when the bytes are already
  in memory, or feed a Blob's chunks to `createStreamingSha256`. Never derive
  source identity from `{name, size, lastModified}`; a manifest's
  `source_raw.sha256` is still the SHA-256 of the full source file.
- Removed `createNodeJpegRowSink` and its `BytesJpegRuntime` and
  `BytesJpegEncoder` types from `@lumaforge/render-engine/export`. Nothing
  replaces this in-memory whole-output sink: implement `JpegRowSink` over a
  streaming encoder, or omit `jpegSink` so `runFullResolutionJpegExport` uses
  `createWasmJpegRowSink`.
- Removed `readVerifiedManifestRenderParams` and its types
  `VerifiedManifestRenderParamsFailure` and
  `VerifiedManifestRenderParamsResult` from `@lumaforge/render-engine` and
  `@lumaforge/render-engine/manifest`. It checked only `manifest_sha256` and
  that `render_params` was an object, so a correctly sealed manifest with
  malformed params or sections was accepted. Pass an untrusted manifest
  through `parseRenderManifest` (`@lumaforge/render-engine/manifest`) instead.
  On `{ ok: true, manifest }`, call
  `invertManifestRenderParams(parsed.manifest.render_params)` for the intent
  the old `{ ok: true, intent }` carried; `invertManifestRenderParams` is a
  typed projection and validates nothing on its own. On `{ ok: false }`,
  handle `issues` (each with its field path) where the old result had a
  single `reason` (`'manifest-sha256-mismatch'` or
  `'render-params-missing'`). These three exports were added after the
  published 0.1.0 and retired before this release, so no published version
  had them; the entry is for code built against the repository's package
  entries in that window.
- `RenderParams` (root and `./manifest` entries) records every executable
  field: `tone_curve`, `color_balance`, `saturation`, `intensity`,
  `raw_render_exposure_ev` and `raw_render_exposure_source` are required, and
  so is every field of `ToneCurveParams`, `ColorBalanceParams` (`temperature`,
  `tint`) and `SaturationParams`. `ColorBalanceParams.temp_k` is removed; no
  writer recorded it. Code that builds `render_params` by hand must pass
  complete sections; `projectManifestRenderParams` writes them.
  `invertManifestRenderParams` reads every field as recorded and no longer
  fills a missing section, strength or exposure; only an omitted
  `selective_color` reads as neutral.
- `LutColorContract.range` (the manifest LUT identity) can be `'unknown'`,
  which the browser app records for a range the user left unspecified;
  readers treat it as unverified. Code that switches exhaustively over
  `'full' | 'legal'` needs a case for it.
- `resolvePreviewColorPlan` (`@lumaforge/render-engine/preview`) takes a
  complete `ColorGraphIntent`: an `intent` without `selectiveColor` no longer
  type-checks, and the plan no longer reads missing HSL as neutral bands.
  Pass partial input through `normalizeColorGraphIntent` from
  `@lumaforge/luma-color-runtime` first. The function was added after the
  published 0.1.0 with an HSL-optional intent, so no published version had
  that signature; the entry is for code built against the repository's
  package entries in that window.
- The preview GPU policy types are named after the WebGPU executor: in
  `PreviewGpuCapabilitySnapshot`, `webgl2` is now `webgpu` and
  `maxRenderbufferSize` is removed; in `PreviewGpuBudget`, `dualWebglAllowed`
  is now `dualGpuAllowed`. There is no WebGL preview tier.

### Added

- `assessProcessedExport` in `@lumaforge/render-engine/export`: a pure check
  of whether a probed `LumaRawExportCapability` can feed the processed-window
  export, returning every typed `ProcessedExportRefusal` (unsupported source,
  invalid dimensions, wrong strategy, no processed windows, missing color
  facts, non-linear-ProPhoto working space, white balance or camera matrix
  not applied by the runtime). `runFullResolutionJpegExport` uses it as its
  source gate, which now also refuses non-positive or non-integer dimensions
  and missing window or color facts with `FULL_RES_EXPORT_UNSUPPORTED_SOURCE`
  before any window read. `lmfg` export applies it before the export begins.
- `runProcessedWindowExportLifecycle` in `@lumaforge/render-engine/export`:
  brackets one processed-window export with the session's optional
  `beginProcessedWindowExport`/`endProcessedWindowExport` hooks. End runs only
  after a successful begin and without the stage signal; an end failure
  rejects an otherwise successful export but never replaces the export's own
  failure. The `/raw` export worker and `lmfg` export both use it.
- Full-resolution export geometry in `@lumaforge/render-engine/export`:
  `runFullResolutionJpegExport` takes an optional `geometry`
  (`ExportGeometry`), planned and resampled at full resolution before the
  color graph, with the matte painted in output space afterwards; a geometry
  the planner refuses fails the export closed. The planner and executor are
  exported as `planExportGeometry`, `planGeometryTiles`, `preimageRect`,
  `resampleGeometryTile`, `applyGeometryMatte`,
  `processedWindowToSourceWindow`, `EXPORT_GEOMETRY_MATTE`,
  `INVALID_EXPORT_GEOMETRY` and their types (`PlannedExportGeometry`,
  `GeometryTile`, `GeometrySourceWindow`, `GeometryResampleTarget`).
  Manifests record an applied geometry as `RenderParams.geometry`
  (`GeometryParams`).
- `@lumaforge/render-engine/geometry` subpath: the pure 3x3 projective
  kernel the export geometry stage runs (`applyMatrix`, `invertMatrix`,
  `isMatrix3`, `Matrix3`, `Point`). It re-exports the same functions as
  `@lumaforge/render-engine/export` and imports no RAW, JPEG or color runtime
  and no browser object, so loading it initializes no renderer. The export
  subpath keeps its matrix exports.
- Manifest construction in `@lumaforge/render-engine` and
  `@lumaforge/render-engine/manifest`, shared by `lmfg` and the browser app:
  `createRenderManifest` (`CreateRenderManifestInput`), the versioned
  color-graph descriptor (`describeColorGraph`, `fingerprintColorGraph`,
  `colorGraphIdentity`, `COLOR_GRAPH_DESCRIPTOR_VERSION`,
  `ColorGraphDescriptor`, `ColorGraphLutProfileDescriptor`) and LUT identity
  (`describeLutProfile`, `lutIdentityFromProfile`, `LutIdentityFailure`).
  `RenderParams` gains an optional `selective_color`
  (`SelectiveColorBandShift` per band) and `PolicyChoice` an optional
  `max_pixels`, the decode budget of a preview or candidate render.
- `resolvePreviewColorPlan` in `@lumaforge/render-engine/preview`: what a
  preview executor (`'webgpu'` or `'cpu'`) draws for the selected look. Its
  `intent` is a complete `ColorGraphIntent`, HSL included; an intent without
  `selectiveColor` does not type-check. It reports the selection and the
  drawn look separately, with a typed reason when they differ, and the TS
  graph that reproduces the draw. A custom LUT draws only when export would
  run it; otherwise the look is dropped and the user adjustments and RAW
  render exposure stay. WebGPU keeps a builtin preset, for which no TS graph
  or histogram stands in; the CPU draws the adjusted graph without it. Export
  is unchanged and still refuses both.
- Manifest render parameter projection in `@lumaforge/render-engine` and
  `@lumaforge/render-engine/manifest`. `projectManifestRenderParams` records
  user color intent the way the color graph reads it (non-finite values
  neutral, values clamped), the look strength, the RAW render exposure and an
  applied geometry. It records selective color as all eight bands and omits
  it when it shifts nothing; a writer that switches to it from sealing an
  explicit all-neutral record gets a different `manifest_sha256` for the
  same render. `invertManifestRenderParams` reads `render_params` back; it
  validates nothing, so a manifest read from outside goes through
  `parseRenderManifest` first. New types: `ManifestRenderParamsInput`,
  `ManifestRenderParamsIntent` and `RecordedRawRenderExposure`.
- `parseRenderManifest` in `@lumaforge/render-engine/manifest`: verifies
  `manifest_sha256` over the complete parsed object, unknown fields
  included, then checks the `RenderManifest` v1 structure without coercing
  anything: discriminants, lowercase hex SHA-256 fields, finite numbers
  (strings and `null` are refused), positive integer dimensions, policy row
  slice, concurrency and decode budget, JPEG quality as an integer
  percentage, the environment and native variant, LUT and calibration
  identities, and an invertible geometry matrix. Everything a replay executes
  must be recorded the way the current writers record it: a color-graph
  descriptor of `COLOR_GRAPH_DESCRIPTOR_VERSION` (2) with the plain or LUT
  export step sequence, each step holding exactly its recorded fields, and a
  fingerprint that hashes it; complete `tone_curve`, `color_balance` and
  `saturation` sections; `intensity`; and `raw_render_exposure_ev` with its
  source. `selective_color` is omitted or all eight bands with all three
  axes. A record an earlier writer sealed without one of these, including
  every manifest `lmfg` 0.1.0 wrote (descriptor version 1), is refused, not
  completed. Unknown fields outside the executable sections are left alone.
  It returns the input object typed, or every issue with its field path.
  User color value ranges are left to the reader's own params schema. New
  types: `ParseRenderManifestResult` and `RenderManifestIssue`.
- `checkRecordedExportGeometry` in `@lumaforge/render-engine/manifest`:
  whether a structurally valid manifest records an export the engine can
  produce. The recorded geometry must plan from the recorded source frame to
  its recorded output, and the recorded output must be that frame (the
  source frame when there is no geometry); a preview or candidate that
  records a geometry is refused. It returns a typed `RecordedGeometryRefusal`
  (`RecordedGeometryCheck`, `RecordedExportFrame`, `RecordedDimensions`).
  `lmfg render replay`, `lmfg manifest verify` and `lmfg-mcp`'s export detail
  tool use it.
- Export output results in `@lumaforge/render-engine/export` can carry the
  SHA-256 of the delivered bytes. `BlobOutputResult`, `BytesOutputResult`
  and `FileBackedOutputResult` gain an optional `sha256`, and
  `FileBackedOutputResult` gains an optional `deliveryMetadata`: the JPEG
  metadata delivery must inject so the recorded hash stays true.
  `createBlobOutputResult` accepts an optional `sha256`. New
  `materializeOutputBlob` returns the delivered Blob for any output kind,
  opening a file-backed output at handoff without cleaning it up. Existing
  fields and constructors are unchanged. `planJpegMetadataInjection`,
  `sha256OfJpegWithMetadata` and `JPEG_HEADER_SCAN_BYTES` compute the
  delivered bytes' SHA-256 from the JPEG's leading segments without a second
  copy of the file.
- `BOUNDED_HQ_PREVIEW_LOW_MEMORY_MAX_PIXELS` (8 000 000) in
  `@lumaforge/render-engine/preview`, beside `QUICK_PREVIEW_MAX_PIXELS` and
  `BOUNDED_HQ_PREVIEW_MAX_PIXELS`. The engine owns these caps; the browser
  app imports them instead of defining its own.

### Changed

- `PreviewJpegEncoder.abort` may return `Promise<void>`, as the Node JPEG
  encoder of `@lumaforge/luma-jpeg-runtime` 0.2.0 does.
  `encodePreviewFrameToJpeg` awaits it and still rejects with the original
  failure.
- `CpuPreviewClient.onFrame` passes the request a frame answers as a second
  argument: the render that was in flight, not one still queued behind it.
  Existing one-argument handlers keep working.

### Fixed

- `computeManifestSha256` and `verifyManifestSha256` hash an own top-level
  `__proto__` field, as `JSON.parse` creates for a `"__proto__"` key, like
  any other field. Before, the copy that drops `manifest_sha256` turned it
  into a prototype, so the hash skipped it and a `__proto__` added after
  sealing still verified. Hashes of manifests without that key are
  unchanged.
