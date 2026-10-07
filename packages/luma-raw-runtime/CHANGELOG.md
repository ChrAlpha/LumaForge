# Changelog

All notable changes to `@lumaforge/luma-raw-runtime` are documented here. The
format follows Keep a Changelog; versions follow semver. Releases before 0.1.2
predate this file.

## 0.1.2 - Unreleased

Requires `@lumaforge/luma-native-artifacts` 0.0.4, which carries the rebuilt
RAW artifacts; publish that package before this one.

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
  build and reproduce only there: `lmfg render replay` (lmfg-cli 0.1.1)
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
- Worker request failures without a runtime error code are classified by the
  request that failed instead of always reporting `RAW_OPEN_FAILED`. Thumbnail
  extraction reports `RAW_THUMBNAIL_UNAVAILABLE`, quick decodes
  `RAW_QUICK_DECODE_FAILED`, bounded HQ decodes `RAW_HQ_DECODE_FAILED`, export
  capability probes `RAW_METADATA_FAILED`, processed-window export begin/end
  and raw or processed window reads `RAW_WINDOW_READ_FAILED`, calibration
  `RAW_WORKER_PROTOCOL_ERROR`, and `init`, `cancel`, and `closeSession`
  `RAW_RUNTIME_UNAVAILABLE`. Source opens and file probes still report
  `RAW_OPEN_FAILED`. Errors that already carry a code (cancellation, memory
  limit, protocol, unsupported format) keep it.

### Added

- `RAW_WINDOW_READ_FAILED` joins `LumaRawErrorCode`. Code that switches
  exhaustively over the union needs a case for it.
- `native:check-window-normalization` reads the public DNG fixture as 256-row,
  512-row, and full-height processed windows with the exporter's 2px halo, top
  down and then bottom up in a fresh session, for each memory profile, and
  requires byte-identical RGB16 rows.

### Deprecated

- `analyzeRawDynamicRange` and its result type `RawDynamicRangeInfo` are
  deprecated. They stay exported from the package entry, and existing calls
  return the same results. Nothing in LumaForge calls them, and their SDR/HDR
  `recommendation` drives neither preview nor export. They may be removed in a
  future major version.
