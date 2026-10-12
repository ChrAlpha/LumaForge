# Changelog

All notable changes to `@lumaforge/luma-jpeg-runtime` are documented here.
The format follows Keep a Changelog; versions follow semver. Releases up to
0.1.1 predate this file.

## 0.2.0 - 2026-10-12

The Node encoder's `abort()` changes its return type, a break that a 0.x
package releases as a minor version.

Requires `@lumaforge/luma-native-artifacts` 0.0.5; its JPEG artifacts are
byte-identical to 0.0.3. Publish order: `@lumaforge/luma-native-artifacts`
0.0.5, then `@lumaforge/luma-color-runtime` 0.2.1,
`@lumaforge/luma-jpeg-runtime` 0.2.0 and `@lumaforge/luma-raw-runtime` 0.2.0,
then `@lumaforge/render-engine` 0.2.0, then `@lumaforge/lmfg-cli` 0.2.0, then
`@lumaforge/lmfg-mcp` 0.1.0. `@lumaforge/render-engine` 0.2.0 and
`@lumaforge/lmfg-cli` 0.2.0 depend on this exact version.

### Breaking

- `LumaJpegNodeEncoder.abort()` (`@lumaforge/luma-jpeg-runtime/node`) now
  returns `Promise<void>`. It resolves once the encoder is released, or at
  once when the encoder was never created or has already finished or been
  aborted, and rejects when the native abort fails; it no longer runs in the
  background or swallows the failure. A call made while an abort is in
  flight settles with that abort, so it neither resolves before the encoder
  is released nor misses the failure. Callers must await it or handle the
  rejection. The browser `LumaJpegEncoder.abort()` from the package entry is
  unchanged and still returns `void`.

### Changed

- The encoder worker treats an abort of an encoder that already finished,
  failed or was aborted as a successful no-op (`{ aborted: true }`) instead of
  answering with a `JPEG_RUNTIME_FINISHED` or `JPEG_RUNTIME_ABORTED` error, so
  an abort after a write failure no longer reports a second, false failure. A
  native abort that throws still leaves the encoder released.
- `native:fetch` retries source downloads with mirrors and time limits.
