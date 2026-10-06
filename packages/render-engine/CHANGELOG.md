# Changelog

All notable changes to `@lumaforge/render-engine` are documented here. The
format follows Keep a Changelog; versions follow semver. Release 0.1.0
predates this file.

## Unreleased

### Added

- `resolvePreviewColorPlan` in `@lumaforge/render-engine/preview`: what a
  preview executor (`'webgpu'` or `'cpu'`) draws for the selected look. It
  reports the selection and the drawn look separately, with a typed reason
  when they differ, and the TS graph that reproduces the draw. A custom LUT
  draws only when export would run it; otherwise the look is dropped and the
  user adjustments and RAW render exposure stay. WebGPU keeps a builtin
  preset, for which no TS graph or histogram stands in; the CPU draws the
  adjusted graph without it. Export is unchanged and still refuses both.

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
- Neither deprecation changes source identity. A manifest's
  `source_raw.sha256` is still the SHA-256 of the full source file; file
  metadata (`{name, size, lastModified}`) and the journal's
  `resume_fingerprint` never stand in for it.
