# Changelog

All notable changes to `@lumaforge/lmfg-cli` are documented here. The format
follows Keep a Changelog; versions follow semver.

## Unreleased

### Added

- `lut fetch --url --sha256` downloads a `.cube` into the workspace LUT cache
  behind an explicit network gate (`--allow-network` or
  `LMFG_ALLOW_NETWORK=1`, exit 5 otherwise) with size and timeout limits and
  SHA-256 verification (exit 6 on mismatch or transport failure). URLs must be
  https (plain http only for loopback hosts) and redirects are followed only
  to allowed transports.
- `render replay --manifest` re-renders a preview, candidate, or export
  manifest from its recorded params, LUT contract, and exposure, refuses on
  fingerprint, source, or LUT mismatch, and reports whether the output
  SHA-256 was reproduced (exit 8 when it was not). `--name` must be a plain
  directory name and existing replays are not overwritten without `--yes`.
  Manifests written by the browser app (which may record `unknown` LUT
  ranges) replay with the effective ranges recorded in the color-graph
  descriptor.
- `selective_color` in `lmfg.params.v1` (per-band hue, saturation, and
  lightness shifts) flows through the color graph and into manifests.
- Preview and candidate manifests record `policy.max_pixels` so replays decode
  at the same budget.

### Changed

- Fixture-gated tests fail instead of skipping when `LMFG_REQUIRE_FIXTURE=1`
  is set; `LMFG_FIXTURE_PATH` overrides the RAW fixture location.
- Manifest construction and the color-graph descriptor now come from
  `@lumaforge/render-engine/manifest`, shared with the browser app, which
  now seals the same `RenderManifest` for its full-resolution exports.
- Native source and fixture downloads retry with mirrors and time limits, and
  the CLI CI job caches the RAW fixture instead of skipping when the upstream
  host is unreachable.

## 0.1.0 - 2026-09-05

### Added

- Initial release of the cpu-wasm tier: `version`, `capabilities`,
  `schema list/show`, `session init/status/list`, `inspect`, `lut inspect`,
  `lut contract infer/validate`, `render preview/candidate/sweep/export`,
  `compare sheet`, `metrics compute`, `manifest verify/show`.
- JSON envelope protocol with NDJSON event streaming (`--emit ndjson`),
  stable error codes, and spec exit codes.
- `.lmfg/` session workspace with atomic writes and sealed `RenderManifest`
  chains from preview to full-resolution export.
