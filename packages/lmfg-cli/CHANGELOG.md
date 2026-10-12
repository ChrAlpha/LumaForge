# Changelog

All notable changes to `@lumaforge/lmfg-cli` are documented here. The format
follows Keep a Changelog; versions follow semver.

## 0.2.0 - 2026-10-12

This release changes the manifest, error, and `capabilities` protocol of
commands 0.1.0 shipped, which a 0.x package releases as a minor version. 0.1.1
was never published.

Requires `@lumaforge/luma-color-runtime` 0.2.1, `@lumaforge/luma-jpeg-runtime`
0.2.0, `@lumaforge/luma-raw-runtime` 0.2.0, `@lumaforge/render-engine` 0.2.0
and `@lumaforge/luma-native-artifacts` 0.0.5; the `workspace:*` dependency
ranges publish as those exact versions. Publish order:
`@lumaforge/luma-native-artifacts` 0.0.5, then `@lumaforge/luma-color-runtime`
0.2.1, `@lumaforge/luma-jpeg-runtime` 0.2.0 and `@lumaforge/luma-raw-runtime`
0.2.0, then `@lumaforge/render-engine` 0.2.0, then `@lumaforge/lmfg-cli`
0.2.0, then `@lumaforge/lmfg-mcp` 0.1.0.

### Breaking

- `manifest verify`, `manifest show`, and `render export --candidate` read a
  manifest through the render-engine `parseRenderManifest`, after checking
  `manifest_sha256` over the whole file, and refuse with `manifest.invalid`
  (exit 1) a correctly sealed manifest that the current writers would not
  produce, instead of reaching a render. That covers malformed content (a
  string or `null` where a number belongs, a fractional or zero dimension, a
  string row slice, decode budget or quality, an unknown policy kind or
  native variant, an incomplete LUT identity, a singular geometry matrix)
  and every executable field an earlier writer recorded differently or left
  out: a color-graph descriptor whose `descriptor_version` is not 2, whose
  steps are not the plain or LUT export sequence with exactly their recorded
  fields, or that does not hash to its fingerprint; an incomplete
  `tone_curve`, `color_balance` (`temperature`, `tint`), or `saturation`; a
  missing `intensity`, `raw_render_exposure_ev`, or
  `raw_render_exposure_source`; a `temp_k`; a partial `selective_color`.
  Nothing is completed with CLI defaults. Issues name the field path
  (`render_params.exposure_ev: must be a finite number, ...`). Every manifest
  0.1.0 wrote records descriptor version 1, so 0.1.0 manifests no longer
  verify or show, and candidates of iterations 0.1.0 rendered can no longer
  be exported; render them again with this version. Manifests this version
  writes and the full-resolution export manifests the browser app writes
  verify, and so do manifests that record explicit all-neutral
  `selective_color` bands. `render replay` and `metrics rank` read manifests
  the same way.
- `manifest verify` also checks that a manifest's recorded geometry and
  output dimensions describe an export the engine can produce, and fails
  with `manifest.invalid` (exit 1), the result in the error details, when
  they do not: `valid` is true only when the manifest is structurally valid
  and its geometry is not unexecutable. A preview or candidate that records a
  geometry, a geometry that does not plan from the recorded source frame to
  its recorded output, and an export whose recorded output is not the frame
  its source or geometry delivers used to verify. The result gains
  `structural_valid` (the seal and the full v1 structure),
  `geometry_executable` (null when the manifest is not structurally valid, or
  is a preview or candidate without a geometry), and `geometry_refusal`
  (`non-export-geometry`, `unplannable-geometry`,
  `geometry-output-mismatch`, or `output-mismatch`, set exactly when
  `geometry_executable` is false). `manifest show` checks only the seal and
  structure.
- RAW failures report the operation that failed. An export window read, or
  the begin or end of a processed-window export, that fails without a more
  specific runtime code is now `render.failed` (exit 7, retryable) with
  `details.runtime_code` `RAW_WINDOW_READ_FAILED`; quick and bounded-HQ
  decode failures are `render.failed` too. Before, all of these reported
  `RAW_OPEN_FAILED` as `source.unsupported` (exit 3). `RAW_CALIBRATION_FAILED`
  maps to `render.failed`. The envelope, exit, and retryability of every other
  runtime code are unchanged, and a code this CLI does not know, including a
  name the object prototype carries such as `constructor`, maps to
  `internal` (exit 10) with the code kept in `details.runtime_code`.
- Errors whose cleanup also failed keep the first failure's `code`, message,
  `retryable`, and exit code, and list each unfinished cleanup step under
  `details.cleanup_failures` as `{ step, code, errno? }` (steps:
  `abort_jpeg_encoder`, `dispose_jpeg_runtime`, `close_temp_file`,
  `remove_temp_file`, `end_processed_window_export`; at most 8, with the rest
  counted in `details.cleanup_failures_omitted`). Error messages are not
  copied, because they can carry local paths. A listed `remove_temp_file`
  means a `.tmp` file may remain. Before, a failed temp-file removal could
  replace an export's write, close, or validation failure; a processed-window
  end failure after a render failure was dropped; and export discards that
  failed were swallowed. A failed abort of the Node JPEG encoder is now
  observable as `abort_jpeg_encoder`. A failed rename while publishing an
  export now removes the temp file. When the engine retried an export
  attempt whose cleanup failed and the export then succeeded,
  `lmfg.render.export.v1` reports that attempt's failures under its own
  optional `cleanup_failures` and `cleanup_failures_omitted`.
- `render replay` was added after the published 0.1.0, and two of its
  results changed before this release. The result's `fingerprint_match` is
  always `true`: it was `null` for a manifest that recorded another
  color-graph descriptor version, which replay now refuses with
  `manifest.invalid` (see the first entry), and a fingerprint the replay
  does not reproduce still fails with `replay.mismatch` (stage
  `color-graph`). An output that does not reproduce the manifest still fails
  with `replay.mismatch`, but the replay's JPEG and manifest are no longer
  written and kept for inspection: nothing is published, and the error
  details carry `published: false` and no `output` or `manifest_uri`. The
  entry is for code built against the repository's CLI in that window;
  Added describes the full contract.
- `capabilities` names the (unshipped) browser tier's preview support
  `webgpu-preview` instead of `webgl2-preview`.

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
- `@lumaforge/lmfg-mcp`: MCP stdio server exposing every command as a tool
  (see its own changelog).
- `lut fetch --url --sha256` downloads a `.cube` into the workspace LUT cache
  behind an explicit network gate (`--allow-network` or
  `LMFG_ALLOW_NETWORK=1`, exit 5 otherwise) with size and timeout limits and
  SHA-256 verification (exit 6 on mismatch or transport failure). URLs must be
  https (plain http only for loopback hosts) and redirects are followed only
  to allowed transports.
- `render replay --manifest` re-renders a preview, candidate, or export
  manifest from its recorded params, LUT contract, and exposure, and reports
  whether the output SHA-256 was reproduced. Every replay rebuilds the color
  graph from the recorded params and refuses (`replay.mismatch`, exit 8,
  stage `color-graph`) a fingerprint it does not reproduce, so the result's
  `fingerprint_match` is always `true`; it also refuses on a source or LUT
  mismatch. It refuses (`replay.mismatch`, exit 8) before decoding when the
  manifest's `luma_raw_runtime` version or native `build_id`/`variant` is
  missing, `unknown`, or differs from this install: a manifest replays only
  on the runtime build that rendered it, so manifests recorded with 0.1.0
  (luma-raw-runtime 0.1.1) are refused. `--name` must be a plain directory
  name and existing replays are not overwritten without `--yes`. Manifests
  written by the browser app (which may record `unknown` LUT ranges) replay
  with the effective ranges recorded in the color-graph descriptor.
- `render replay` publishes nothing when the replay does not reproduce the
  manifest. The delivered frame and the SHA-256 are checked before anything
  is written, for preview, candidate, and export replays alike: a mismatch
  discards the provisional export, leaves any existing JPEG and manifest at
  the replay path byte for byte, and fails with `replay.mismatch` (exit 8).
  The error details carry `stage`, `expected_sha256`, `actual_sha256`, the
  expected and actual dimensions, and `published: false` (and
  `cleanup_failures` when the provisional file could not be removed), and no
  `output` or `manifest_uri` for artifacts that were not delivered. A
  successful replay always reports `reproduced: true`, and reports an
  engine-retried attempt's failed cleanup under `cleanup_failures` as
  `render export` does.
- `render replay` reproduces browser export manifests that record a Transform
  geometry (`render_params.geometry`). The geometry runs through the
  render-engine export planner and executor the app uses. Before decoding,
  replay refuses a geometry that folds the frame or retains too little of it
  (`args.invalid`, exit 2), and refuses (`replay.mismatch`, exit 8) when the
  recorded source frame does not plan to the recorded geometry output, or the
  recorded output dimensions are not that frame (for an export without a
  geometry, the decoded source frame). The probed decode must match the
  recorded source frame before any window is read. The replay manifest
  records the geometry it applied. Preview and candidate manifests that
  record a geometry are refused. The CLI has no geometry authoring.
- `selective_color` in `lmfg.params.v1` (per-band hue, saturation, and
  lightness shifts) flows through the color graph and into manifests.
- Preview and candidate manifests record `policy.max_pixels` so replays decode
  at the same budget.
- The package entry exports the `.lmfg/` workspace contract:
  `resolveWorkspaceRoot`, `DEFAULT_WORKSPACE_DIRNAME`, `workspacePaths`,
  `toFileUri`, the portable path-segment rule (`isPortablePathSegment`,
  `assertPortablePathSegment`), and the record schemas and types for
  `session.json` (`SessionRecordSchema`), iteration `plan.json`
  (`IterationRecordSchema`), and contact-sheet maps (`ContactSheetMapSchema`).

### Changed

- RAW decodes run on `@lumaforge/luma-raw-runtime` 0.2.0, which disables
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
- `session status`, `compare sheet`, and the `metrics` commands read
  iteration `plan.json` through `IterationRecordSchema`, and contact-sheet
  maps are checked against `ContactSheetMapSchema` before they are written. A
  malformed plan (missing or empty candidates, an identifier that is not a
  single portable path segment, params outside `lmfg.params.v1`) now fails
  with `schema.invalid` instead of being used as read. Plans written by 0.1.0
  still read: their params predate `selective_color`, which reads as `null`.
- Stored candidate records are validated when they are read. `tile.json`
  must be `lmfg.tile.v1` in `rgba8` with positive integer dimensions and a
  `byte_length` of width x height x 4 that `tile.rgba` actually holds;
  `metrics.json` must match `lmfg.metrics.v1`; `params.json` must match
  `lmfg.params.v1` (a wrongly typed, `null`, out-of-range, or unknown field
  is refused, not defaulted or clamped); and the candidate `manifest.json`
  that `metrics rank` reads is held to `parseRenderManifest` and its
  `manifest_sha256` (`manifest.invalid`). A malformed tile, metrics, or
  params record now fails with `schema.invalid` (exit 2) before it is used:
  `metrics compute`, `compare`, and `rank` no longer return or compare a
  malformed `metrics.json` and no longer read a truncated or oversized tile.
  A missing `metrics.json` is still recomputed from the tile, and a missing
  tile or manifest is still `candidate.not_found`.
- A stored workspace record that fails validation (an iteration plan,
  including the plans `session status` reads, or a candidate record) is
  reported as that file rather than as invalid input: the message names the
  file and each offending field, and `details` adds `record_path` beside
  `issues`. `session status` still fails on a corrupt plan instead of
  listing the other iterations.
- Native source and fixture downloads retry with mirrors and time limits, and
  the CLI CI job caches the RAW fixture instead of skipping when the upstream
  host is unreachable.
- `inspect` reports `export_capability.supported` as the render-engine
  processed-export assessment that `render export` applies, so it no longer
  advertises a source the export refuses. Before, it echoed the runtime's
  `supported` flag, which stayed `true` for a source with missing or
  non-runtime-applied color facts, invalid dimensions, or no processed
  windows. `reasons` keeps the runtime's reasons first and adds each
  assessment refusal (for example `color-facts-missing`,
  `invalid-dimensions`, `processed-windows-unavailable`) the runtime did not
  already name. The result shape, `strategy`, and the measured `width` and
  `height` are unchanged.

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
