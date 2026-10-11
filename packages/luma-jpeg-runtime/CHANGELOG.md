# Changelog

All notable changes to `@lumaforge/luma-jpeg-runtime` are documented here.
The format follows Keep a Changelog; versions follow semver. Releases up to
0.1.1 predate this file.

## 0.2.0 - Unreleased

Proposed version. The Node encoder's `abort()` changes its return type, a
break that a 0.x package releases as a minor version. `package.json` still
reads 0.1.1, the published release; set it to 0.2.0 before publishing.

Requires `@lumaforge/luma-native-artifacts` 0.0.4; its JPEG artifacts are
byte-identical to 0.0.3. Publish that package first, and this one before
`@lumaforge/render-engine` 0.2.0 and `@lumaforge/lmfg-cli` 0.2.0, which
depend on this exact version.

### Breaking

- `LumaJpegNodeEncoder.abort()` (`@lumaforge/luma-jpeg-runtime/node`) now
  returns `Promise<void>`. It resolves once the encoder is released, or at
  once when the encoder was never created or has already finished or been
  aborted, and rejects when the native abort fails; it no longer runs in the
  background or swallows the failure. Callers must await it or handle the
  rejection. The browser `LumaJpegEncoder.abort()` from the package entry is
  unchanged and still returns `void`.

### Changed

- The encoder worker treats an abort of an encoder that already finished,
  failed or was aborted as a successful no-op (`{ aborted: true }`) instead of
  answering with a `JPEG_RUNTIME_FINISHED` or `JPEG_RUNTIME_ABORTED` error, so
  an abort after a write failure no longer reports a second, false failure. A
  native abort that throws still leaves the encoder released.
- `native:fetch` retries source downloads with mirrors and time limits.
