# Changelog

All notable changes to `@lumaforge/luma-raw-runtime` are documented here. The
format follows Keep a Changelog; versions follow semver. Releases up to 0.1.1
predate this file.

## Unreleased

### Breaking

- `LumaRawDecodeSession.beginProcessedWindowExport` and
  `endProcessedWindowExport`, and the `beginProcessedWindowExportFromSession`
  and `endProcessedWindowExportFromSession` worker requests, are removed. No
  native build bound them, so the worker answered begin without native work
  and end did nothing; read processed windows from the session directly.
- The raw-mosaic window path is removed: `LumaRawDecodeSession.readRawWindow`,
  the `readRawWindowFromSession` worker request, the `LumaRawWindow` type,
  the `'raw-mosaic-window'` member of `LumaRawFullResInputStrategy`, and
  `LumaRawExportWindowFacts.rawMosaic`. Full-resolution export reads only
  LibRaw processed windows, and nothing read a raw mosaic window.
- The one-shot file decodes are removed: `LumaRawRuntime` and
  `LumaRawNodeRuntime` keep only `init`, `openSession`, and `dispose`
  (`probe`, `extractEmbeddedPreview`, `decodeQuick`, and `decodeBoundedHq`
  are gone), and the `probe`, `extractEmbeddedPreview`, `decodeQuick`, and
  `decodeBoundedHq` worker requests with them. Open a session and run the
  stage on it. `LumaRawWorkerFilePayload.sessionId` is removed, and
  `LumaRawFrame.sessionId` and `LumaEmbeddedPreview.sessionId` are required.
- The package entry no longer exports `LumaRawWorkerClient` or
  `normalizeRawRuntimeError`; `createLumaRawRuntime` and `LumaRawRuntimeError`
  stay.
- `LumaRawExportUnsupportedReason` keeps only the reasons the native wrapper
  or the adapter reports. `libraw-open-failed`, `libraw-unpack-failed`,
  `libraw-cropbox-window-unavailable`, `libraw-cropbox-not-repeatable`,
  `orientation-transform-unimplemented`, `unsupported-cfa-pattern`,
  `degenerate-camera-to-output-color`, `raw-window-unavailable-after-unpack`,
  `jpeg-runtime-unavailable`, `compressed-raw-window-unavailable`, and
  `raw-window-unavailable` are removed, and a native capability naming one
  drops it like any other unknown reason.
- `LumaRawExportCapability` drops `cfa` (read `sensor.cfa`), `levels` (read
  `blackLevel` and `whiteLevel`), and `diagnostics`;
  `LumaRawExportSensorFacts` drops `colorCount` and `phaseIsWindowLocal`. The
  `LumaRawExportDiagnostics` and `LumaRawExportLevelFacts` types are removed.
- `LumaRawRuntimeInfo` drops `simd`, `pthreads`, `memoryTier`, and
  `workerPoolSize`, and the `LumaRawMemoryTier` type is removed.
  `LumaRawTimings` drops `transferToWorker`, `process`, `makeMemImage`,
  `outputCopy`, and `transfer`, which no stage wrote.
- Worker requests carry the memory profile only on `init` and `openSession`
  (`LumaRawWorkerFilePayload.memoryProfile`); the session and `cancel`
  payloads drop `memoryProfile`. The worker builds its one core from the
  profile the first of those requests names, so a custom `workerFactory`
  serves one profile per worker.

## 0.2.0 - 2026-10-12

This release removes public exports and changes error codes and capability
facts, which a 0.x package releases as a minor version. 0.1.2 was never
published. Runtime info and render manifests report the version in
`package.json`.

Requires `@lumaforge/luma-native-artifacts` 0.0.5, which carries the rebuilt
RAW artifacts. Publish order: `@lumaforge/luma-native-artifacts` 0.0.5, then
`@lumaforge/luma-color-runtime` 0.2.1, `@lumaforge/luma-jpeg-runtime` 0.2.0
and `@lumaforge/luma-raw-runtime` 0.2.0, then `@lumaforge/render-engine`
0.2.0, then `@lumaforge/lmfg-cli` 0.2.0, then `@lumaforge/lmfg-mcp` 0.1.0.
`@lumaforge/render-engine` 0.2.0 and `@lumaforge/lmfg-cli` 0.2.0 depend on
this exact version.

### Breaking

- `analyzeRawDynamicRange` and its result type `RawDynamicRangeInfo` are
  removed from the package entry. Nothing in LumaForge called them, and their
  SDR/HDR `recommendation` drove neither preview nor export. Code that
  imported them must drop the import; there is no replacement.
- `LumaRawErrorCode` gains `RAW_WINDOW_READ_FAILED` and
  `RAW_CALIBRATION_FAILED`. Code that switches exhaustively over the union
  needs a case for each.
- Worker request failures without a runtime error code are classified by the
  request that failed instead of always reporting `RAW_OPEN_FAILED`.
  Thumbnail extraction reports `RAW_THUMBNAIL_UNAVAILABLE`, quick decodes
  `RAW_QUICK_DECODE_FAILED`, bounded HQ decodes `RAW_HQ_DECODE_FAILED`, export
  capability probes `RAW_METADATA_FAILED`, processed-window export begin/end
  and raw or processed window reads `RAW_WINDOW_READ_FAILED`, calibration
  `RAW_CALIBRATION_FAILED`, and `init`, `cancel`, and `closeSession`
  `RAW_RUNTIME_UNAVAILABLE`. Source opens and file probes still report
  `RAW_OPEN_FAILED`. Errors that already carry a code (cancellation, memory
  limit, protocol, unsupported format, runtime unavailable) keep it. Code that
  matched `RAW_OPEN_FAILED` for these operations must match the new codes.
- A calibration request whose `cameraCalibration` is not a profile with
  `xyzToCamera` as a `Float32Array` of 9 finite values, and an optional
  `toneCurveLut` as a `Float32Array` of at least 4096 finite entries, is
  refused with `RAW_WORKER_PROTOCOL_ERROR` before any session lookup or
  native work. A calibration the native module fails to apply reports
  `RAW_CALIBRATION_FAILED`. `applyCalibration` itself stays.
- Export capability facts are read exactly as the native wrapper records
  them, with nothing defaulted, renamed or inferred.
  `LumaRawExportCapability.orientation` is only a `LumaRawExportOrientation`
  record: a bare orientation number says nothing about whether processed
  windows apply the rotation, so it leaves the capability without
  orientation and unsupported (`unsupported-orientation`).
  `LumaRawExportCapability.color` is only `LumaRawExportColorFacts`: it is
  present only when the native facts record `workingSpace:
'linear-prophoto-rgb'`, `librawOutputColor: 'prophoto'`, `gamma: 'linear'`,
  both `cameraWhiteBalanceAppliedByRuntime` and
  `cameraMatrixAppliedByRuntime` as booleans, a positive four-value
  `whiteBalance` and a usable 3x3 `cameraToWorkingRgb`; otherwise the
  capability reports `missing-color-transform`. The `cameraWhiteBalance` and
  `prophoto-linear` spellings and the defaults for an absent gamma or output
  color are gone, and an applied flag is no longer inferred from a usable
  tuple: a flag recorded as `false` adds `missing-camera-white-balance` or
  `missing-camera-to-output-color`. The bundled native artifacts record every
  fact, so their capabilities are unchanged; a native module that records
  fewer facts now gets an unsupported export capability. Metadata, decoded
  frame and EXIF orientation numbers are unchanged.

### Changed

- LibRaw's adaptive white point (`adjust_maximum`) is disabled for every
  decode: processed export windows and preview decodes alike. LibRaw used to
  lower the white level to the decoded region's own peak whenever that peak
  sat between 75% and 100% of it, so the white level depended on which part of
  the frame was decoded. It no longer does.
- Preview and export output can change. A preview frame whose decoded peak sat
  between 75% and 100% of the white level rendered brighter before, and so did
  every export window whose own peak sat in that range, which can happen even
  when the frame's overall peak lies outside it. Frames and windows whose peak
  lay outside that range are not affected by this change.
- The fixed export policy check behind the export and processed-window
  capabilities also requires the adaptive white point to be off.
- Both native memory profiles (`desktop` and `low-memory`) are rebuilt, and
  their native build ids change. Toolchain and sources are unchanged (emsdk
  5.0.6, LibRaw 0.22.1, Little CMS 2.18).
- Manifests recorded on 0.1.1 or earlier name that runtime version and native
  build and reproduce only there: `lmfg render replay` (lmfg-cli 0.2.0)
  refuses them on this version before decoding.
- `native:fetch` retries downloads with mirrors and time limits. Little CMS is
  fetched from its GitHub release, with the SourceForge archive as a mirror
  (same archive SHA-256).

### Fixed

- Full-resolution exports no longer brighten strips independently. Each
  processed window the exporter reads (a strip, or a tile when geometry is
  applied) was normalized to its own peak, so neighboring strips could
  differ in brightness by up to log2(1/0.75), about 0.42 EV, and show bands.
- Runtime info reports the package version; it reported `0.1.0` before.

### Added

- `native:check-window-normalization` reads the public DNG fixture as 256-row,
  512-row, and full-height processed windows with the exporter's 2px halo, top
  down and then bottom up in a fresh session, for each memory profile, and
  requires byte-identical RGB16 rows.
