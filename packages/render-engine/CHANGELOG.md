# Changelog

All notable changes to `@lumaforge/render-engine` are documented here. The
format follows Keep a Changelog; versions follow semver. Release 0.1.0
predates this file.

## Unreleased

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
- `resolvePreviewColorPlan` in `@lumaforge/render-engine/preview`: what a
  preview executor (`'webgpu'` or `'cpu'`) draws for the selected look. It
  reports the selection and the drawn look separately, with a typed reason
  when they differ, and the TS graph that reproduces the draw. A custom LUT
  draws only when export would run it; otherwise the look is dropped and the
  user adjustments and RAW render exposure stay. WebGPU keeps a builtin
  preset, for which no TS graph or histogram stands in; the CPU draws the
  adjusted graph without it. Export is unchanged and still refuses both.
- Manifest render parameter projection in `@lumaforge/render-engine` and
  `@lumaforge/render-engine/manifest`. `projectManifestRenderParams` records
  user color intent the way the color graph reads it (non-finite values
  neutral, values clamped), the look strength, the RAW render exposure and an
  applied geometry. It records selective color as all eight bands and omits
  it when it shifts nothing; a writer that switches to it from sealing an
  explicit all-neutral record gets a different `manifest_sha256` for the
  same render. `invertManifestRenderParams` reads `render_params` back; missing
  sections read as neutral. `readVerifiedManifestRenderParams` verifies
  `manifest_sha256` over the form the manifest was written in before reading
  it, so manifests sealed with an explicit neutral record still verify. New
  types: `ManifestRenderParamsInput`, `ManifestRenderParamsIntent`,
  `RecordedRawRenderExposure`, `VerifiedManifestRenderParamsFailure` and
  `VerifiedManifestRenderParamsResult`.
- Export output results in `@lumaforge/render-engine/export` can carry the
  SHA-256 of the delivered bytes. `BlobOutputResult`, `BytesOutputResult`
  and `FileBackedOutputResult` gain an optional `sha256`, and
  `FileBackedOutputResult` gains an optional `deliveryMetadata`: the JPEG
  metadata delivery must inject so the recorded hash stays true.
  `createBlobOutputResult` accepts an optional `sha256`. New
  `materializeOutputBlob` returns the delivered Blob for any output kind,
  opening a file-backed output at handoff without cleaning it up. Existing
  fields and constructors are unchanged.

### Deprecated

- `ExportCheckpointManifest` and the types it is built from:
  `ExportInProgress`, `JpegResumeState`, `OutputIntent`, `ResumeFingerprint`,
  and `SourceReacquisitionMode`. No engine function reads or writes this
  journal, and an interrupted export reruns from the start. The types are
  unchanged and still exported from `@lumaforge/render-engine` and
  `@lumaforge/render-engine/manifest`.
- `sourceContentIdFromFile`. It reads the whole Blob into memory before
  hashing. Stream the Blob's chunks through `createStreamingSha256` instead,
  or call `sourceContentIdFromBytes` when the bytes are already in memory. It
  still accepts any `Blob`, caches results per Blob object, and falls back to
  the pure-JS SHA-256 when WebCrypto is unavailable.
- The checkpoint and File helper deprecations do not change source
  identity. A manifest's `source_raw.sha256` is still the SHA-256 of the full
  source file; file metadata (`{name, size, lastModified}`) and the journal's
  `resume_fingerprint` never stand in for it.
- `LumaRenderContext` and the types it is built from: `CheckpointStore`,
  `ManifestStore`, `OutputSink`, `OutputSinkHandle`, `OutputSinkMeta`,
  `OutputSinkResult`, `ProfileCache`, `ProfileFetcher`,
  `ProfileFetchOptions` and `RenderEvent`. No engine function accepts the
  context; engine calls take explicit parameters, such as the `jpegSink`,
  `signal` and `onProgress` of `runFullResolutionJpegExport`. The types are
  unchanged and still exported from `@lumaforge/render-engine`.
- `RenderBudget`. No engine function accepts or enforces it; export
  concurrency and row slicing come from `deriveExportPolicy`, and
  `candidateRender` takes its own `maxConcurrent`. Still exported from
  `@lumaforge/render-engine` and `@lumaforge/render-engine/policy`.
- `NODE_DEFAULT_CAPABILITY`. No engine function falls back to it. Pass a
  `CapabilityVector` that describes the actual host to the policy
  functions. The value is unchanged and still exported from
  `@lumaforge/render-engine` and `@lumaforge/render-engine/policy`;
  `CapabilityVector` itself stays supported.
- `ExportFidelity`. Use `PerformancePreference` from
  `@lumaforge/render-engine/policy`, which accepts the same values (`'safe'`,
  `'balanced'`, `'max'`). `normalizeExportConcurrency` now declares its
  second parameter as `PerformancePreference`; it accepts the same values and
  returns the same concurrency as before. `ExportFidelity` is unchanged and
  still exported from `@lumaforge/render-engine` and
  `@lumaforge/render-engine/policy`.
- `createNodeJpegRowSink` and its `BytesJpegRuntime` and `BytesJpegEncoder`
  input types. Nothing uses the sink, and it holds the whole encoded JPEG in
  memory. Implement `JpegRowSink` over a streaming encoder, or omit
  `jpegSink` so `runFullResolutionJpegExport` uses `createWasmJpegRowSink`.
  The function keeps its behavior and is still exported from
  `@lumaforge/render-engine/export`.
