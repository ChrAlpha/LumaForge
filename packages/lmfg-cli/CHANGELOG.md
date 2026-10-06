# Changelog

All notable changes to `@lumaforge/lmfg-cli` are documented here. The format
follows Keep a Changelog; versions follow semver.

## 0.1.1 - Unreleased

Requires `@lumaforge/luma-raw-runtime` 0.1.2 and
`@lumaforge/luma-native-artifacts` 0.0.4; publish those packages first.

### Added

- `render candidate|sweep --concurrency <n|auto>` renders candidates on
  worker threads (one JPEG runtime per worker, shared decoded frame) with
  byte-identical outputs; results and manifests record the pool size and
  results report `resource.max_rss_bytes`.
- `render export` streams the JPEG to disk (EXIF and SHA-256 computed
  in-stream) instead of holding it in memory.
- `metrics compare` (baseline deltas) and `metrics rank` (objective-based
  ranking, `lmfg.objective.v1`).
- Inline JSON options `--params-json`, `--plan-json`, `--contract-json`.
- `@lumaforge/lmfg-mcp`: MCP stdio server exposing every command as a tool.
- `lut fetch --url --sha256` downloads a `.cube` into the workspace LUT cache
  behind an explicit network gate (`--allow-network` or
  `LMFG_ALLOW_NETWORK=1`, exit 5 otherwise) with size and timeout limits and
  SHA-256 verification (exit 6 on mismatch or transport failure). URLs must be
  https (plain http only for loopback hosts) and redirects are followed only
  to allowed transports.
- `render replay --manifest` re-renders a preview, candidate, or export
  manifest from its recorded params, LUT contract, and exposure, refuses on
  fingerprint, source, or LUT mismatch, and reports whether the output
  SHA-256 was reproduced (exit 8 when it was not). It also refuses
  (`replay.mismatch`, exit 8) before decoding when the manifest's
  `luma_raw_runtime` version or native `build_id`/`variant` is missing,
  `unknown`, or differs from this install: a manifest replays only on the
  runtime build that rendered it, so manifests recorded with 0.1.0
  (luma-raw-runtime 0.1.1) are refused. `--name` must be a plain directory
  name and existing replays are not overwritten without `--yes`.
  Manifests written by the browser app (which may record `unknown` LUT
  ranges) replay with the effective ranges recorded in the color-graph
  descriptor.
- `selective_color` in `lmfg.params.v1` (per-band hue, saturation, and
  lightness shifts) flows through the color graph and into manifests.
- Preview and candidate manifests record `policy.max_pixels` so replays decode
  at the same budget.

### Changed

- RAW decodes run on `@lumaforge/luma-raw-runtime` 0.1.2, which disables
  LibRaw's adaptive white point for every decode. Preview, candidate, and
  export output can change for frames, and for export windows, whose decoded
  peak sat between 75% and 100% of the white level: those rendered brighter
  before, and export strips no longer brighten independently. Manifests now
  record the new runtime version and native build id.
- Automatic raw-render exposure (`raw_render_exposure: "auto"`) is measured
  on the standard 2.5 MP quick frame for `render preview`, `candidate`, and
  `sweep`, the frame `render export` and `inspect` already used, so one
  source gets one auto EV whatever `--max-pixels` or candidate. Before, it
  was measured on the rendered frame: small quick and bounded-HQ previews of
  non-DNG files could differ from the export EV (up to 0.16 EV observed on a
  Sony ARW). Those renders now decode the standard quick frame once more on
  the same RAW session (about 0.25 to 1 s on 24 to 45 MP files, reported as
  `timings_ms.exposure_ms`); renders at the standard quick size reuse their
  frame. An explicit EV (zero included), a DNG baseline exposure, and the
  exposure recorded in a replayed or exported candidate manifest still win
  without the extra decode, and manifests record the EV actually used.
- Fixture-gated tests fail instead of skipping when `LMFG_REQUIRE_FIXTURE=1`
  is set; `LMFG_FIXTURE_PATH` overrides the RAW fixture location.
- Manifest construction and the color-graph descriptor now come from
  `@lumaforge/render-engine/manifest`, shared with the browser app, which
  now seals the same `RenderManifest` for its full-resolution exports.
- `render_params` is written through the render-engine projection the
  browser app uses, and `lmfg.params.v1` takes its field ranges from
  `@lumaforge/luma-color-runtime`. Replay still reads recorded values through
  the strict params schema, so a value outside it is refused rather than
  clamped. The params schema, its
  defaults (look `intensity` 1, `raw_render_exposure` `auto`), patch merging,
  and the recorded raw-render exposure are unchanged. One encoding changes:
  a `selective_color` that shifts nothing (for example every band at zero) is
  now omitted from `render_params` instead of being recorded as eight neutral
  bands, so for those params `manifest_sha256` differs from manifests written
  by earlier development builds of this release, while the color-graph
  fingerprint and the rendered output do not. Manifests that record the
  neutral bands still verify as written and replay with no HSL.
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
