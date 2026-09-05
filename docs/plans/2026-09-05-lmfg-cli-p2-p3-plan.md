# lmfg CLI P2 + P3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take the `lmfg` CLI from "correct and reproducible" to "fast at scale and usable from an agent host": parallel sweeps, streaming full-resolution export validated on 60 to 100 MP files, candidate evaluation helpers, an MCP server, and a cross-platform CI matrix.

**Architecture:** Every P2/P3 item stays inside the existing boundaries: pure domain logic in `packages/lmfg-cli/src/services/*`, thin commander adapters in `src/commands/*`, schemas in `src/schemas/*`, and the JSON/NDJSON envelope in `src/protocol/*`. Parallel candidate rendering uses `node:worker_threads` with one WASM JPEG runtime per worker and a `SharedArrayBuffer` for the decoded frame; the streaming export sink lives in `@lumaforge/render-engine` next to the existing Node row sink. The MCP server is a separate thin package (`packages/lmfg-mcp`) that maps CLI commands to tools and invokes the CLI in-process, so the CLI keeps zero MCP dependencies. Tier 1 (browser bridge) stays deferred: the CPU path is the authoritative export and the CLI preview is closer to the export than the app's WebGL preview.

**Tech Stack:** TypeScript, commander 15, zod 4, `node:worker_threads`, `@modelcontextprotocol/sdk`, Vitest, GitHub Actions matrix.

---

## Scope recap (from the post-release recommendations)

- **P2-1 sweep concurrency** — worker threads, one WASM instance set per worker; 64 candidates from ~25 s toward ~7 s.
- **P2-2 large-file validation** — run the 133 MB GFX100RF RAF and the 82 MB Sony ARW through desktop and low-memory profiles, record time and peak RSS, and stop holding the whole JPEG in memory during export (streaming sink).
- **P2-3 Tier 1 browser bridge** — explicitly deprioritized; no work, documented as deferred.
- **P3-1 MCP server** — thin wrapper over the schema registry and commands.
- **P3-2 candidate evaluation** — baseline deltas and objective-based ranking on top of `metrics`.
- **P3-3 cross-platform CI** — macOS and Windows in the `cli` job; verify file URIs, atomic rename, path joins.

## Acceptance criteria (Definition of Done)

1. `render sweep`/`render candidate` accept `--concurrency <n|auto>`; with `n > 1` every candidate's `preview.jpg` SHA-256 and manifest fingerprint are byte-identical to the `--concurrency 1` run (e2e proves it on the public DNG fixture); the manifest `policy.concurrency` records the pool size actually used; worker failures and `--timeout` cancellation surface as spec exit codes (7 / 9) with no orphaned worker threads.
2. A 64-candidate sweep on the public DNG fixture on this machine runs at least 2.5x faster with `--concurrency auto` than with `--concurrency 1` (numbers recorded in the execution notes).
3. `render export` streams JPEG chunks to the target file as they are encoded (EXIF inserted and SHA-256 computed in-stream); peak RSS of the CLI process for a 102 MP RAF export is reported and lower than before the change; results include `resource.max_rss_bytes`.
4. Large-fixture validation (`LMFG_LARGE_FIXTURES=1`) covers the RAF and the ARW for both memory profiles: export succeeds, `manifest verify` passes, and `render replay` reproduces the export; timings and peak RSS are recorded in `docs/audits/2026-09-05-lmfg-large-file-validation.md`.
5. `metrics compare --iteration --baseline` returns per-candidate deltas for every scalar metric and `metrics rank --iteration --objective` returns a deterministic ordering with per-term contributions; both have schemas in the registry and unit tests for the scoring math.
6. `packages/lmfg-mcp` exposes every CLI command as an MCP tool over stdio (`lmfg-mcp` bin), tool input schemas come from the same zod schemas as the CLI, tool results carry the CLI envelope as structured content, failures map to `isError: true` with the CLI error code, and an integration test drives `initialize` → `tools/list` → `tools/call` through a real stdio child process.
7. `build.yml` runs the `cli` job on `ubuntu-latest`, `macos-latest`, and `windows-latest` (fixture cache keyed per OS, `shell: bash`), and a Windows path audit of `workspace/*`, `runtime/*`, and the e2e harness has been done with fixes for anything that assumes POSIX separators.
8. Docs: CLI README (concurrency, streaming export, metrics compare/rank, MCP), CHANGELOG `Unreleased`, spec status line, this plan's execution notes; a fresh-context review pass has no unresolved high or medium findings.
9. Verification is green with fresh evidence: `pnpm lint:check`, `pnpm --filter @lumaforge/render-engine typecheck && test && build`, `pnpm --filter @lumaforge/lmfg-cli typecheck`, `LMFG_REQUIRE_FIXTURE=1 pnpm test:cli`, `pnpm --filter @lumaforge/lmfg-mcp typecheck && test`, `pnpm test:runtime`, `pnpm test:run`, `pnpm cli:build`, `LUMAFORGE_NATIVE_RUNTIME_MODE=prebuilt pnpm build`, `npm pack --dry-run` for `render-engine`, `lmfg-cli`, and `lmfg-mcp`.

---

## File map

- Modify: `packages/lmfg-cli/vite.config.ts` (second entry `candidate-worker`)
- Create: `packages/lmfg-cli/src/workers/candidate-worker.ts` (worker entry), `src/services/candidate-pool.ts` (pool + inline fallback, shared frame), `src/services/candidate-pool.test.ts`
- Modify: `src/services/iteration.ts` (use the pool; record concurrency; `resource`), `src/commands/render.ts` (`--concurrency`, `--params-json`, `--plan-json`), `src/schemas/results.ts` (`resource`, compare/rank results), `src/schemas/registry.ts`
- Create: `packages/render-engine/src/export/jpeg/node-file-row-sink.ts` (+ test) — streaming file sink with in-stream EXIF insertion and SHA-256
- Modify: `packages/lmfg-cli/src/services/export.ts` (streaming sink, `resource`), `src/services/replay.ts` (same sink for export replays)
- Create: `packages/lmfg-cli/src/services/evaluation.ts` (+ test), `src/commands/metrics.ts` (compare, rank), `src/schemas/evaluation.ts`
- Create: `packages/lmfg-cli/benchmarks/large-file-validation.mjs`, `docs/audits/2026-09-05-lmfg-large-file-validation.md`
- Create: `packages/lmfg-mcp/` (package.json, tsconfig, vite config, `src/index.ts`, `src/server.ts`, `src/tools.ts`, `src/tools.test.ts`, `src/e2e/mcp.e2e.test.ts`, `bin/lmfg-mcp.mjs`, README)
- Modify: `.github/workflows/build.yml` (cli matrix), root `package.json` scripts (`cli:build`, `test:cli`, mcp), `pnpm-workspace.yaml` unchanged (`packages/*`)
- Docs: `packages/lmfg-cli/README.md`, `packages/lmfg-cli/CHANGELOG.md`, `docs/specs/2026-06-23-lmfg-cli-tier0-1-design.md`, this plan

---

## Tasks

### Task K — sweep concurrency (P2-1)
- [x] K1 `candidate-pool.ts`: `renderCandidatesParallel({ frame, params, quality, concurrency, workerScript, signal })` yields `CandidateOutput { index, width, height, jpeg, sha256, metrics, tile }` in completion order. The frame is copied once into a `SharedArrayBuffer`; each worker receives `{ frame: { buffer, width, height }, tileSize }` at start and per-task `{ index, graph, quality }` (graph structured-cloned, LUT tables included). Workers compute render + encode + metrics + tile downsample and post back with transfer lists. Errors carry the candidate index; the first error aborts the pool (`terminate()` every worker) and rejects. Inline fallback when `concurrency === 1` or the worker script is missing (`policy.concurrency` then records 1).
- [x] K2 `workers/candidate-worker.ts`: one `createLumaJpegRuntimeForNode()` per worker; message loop; deterministic code path identical to `candidateRender` (uses `renderCpuPreviewFrame`, `encodePreviewFrameToJpeg`, `computeImageMetrics`, `downsampleRgba`).
- [x] K3 `vite.config.ts` second entry; `resolveCandidateWorkerScript()` in `runtime/versions.ts` returns `dist/candidate-worker.js` under `LMFG_PACKAGE_DIR` or `null`.
- [x] K4 `render sweep|candidate --concurrency <n|auto>` (default `auto` = `min(availableParallelism() - 1, 8, candidates)`, floor 1; `low-memory` profile defaults to 1). `iteration.ts` uses the pool; `policy.concurrency` = pool size; `timings_ms.render_ms` unchanged in meaning; result gains `resource: { max_rss_bytes }`.
- [x] K5 Tests: unit (pool with a fake worker script that echoes; ordering, abort, error propagation, inline fallback); e2e sweep `--concurrency 1` vs `--concurrency 3` byte-identical `sha256` per candidate and identical `manifest.color_graph.fingerprint`; timing table in execution notes.

### Task L — streaming export + large-file validation (P2-2)
- [x] L1 `node-file-row-sink.ts`: `createNodeFileJpegRowSink({ runtime, path, metadata, width, height })` builds the encoder with `finishMode: 'chunks'`; buffers the first 64 KiB, computes `planJpegMetadataInjection`, then writes `head + segment + rest` straight to a temp file (`<path>.<pid>.tmp`), hashing in-stream; `close()` renames and returns `{ kind: 'file', path, byteLength, sha256 }` (new `FileOutputResult` kind, additive). Abort removes the temp file. Tests with a fake chunk encoder: bytes on disk equal `preserveJpegMetadataBytes(inMemory)` and sha matches.
- [x] L2 `services/export.ts`: use the file sink (target = the final export path); `assertJpegBytes` becomes `assertJpegFile` (SOI at 0, EOI at end via `fs.open` reads); result `jpeg` bytes are no longer returned; commands write the manifest from `sha256`/`byteLength`; `replay.ts` export path uses the same sink and compares sha. `resource.max_rss_bytes` from `process.resourceUsage().maxRSS * 1024`.
- [x] L3 `benchmarks/large-file-validation.mjs` (fixture-gated by `LMFG_LARGE_FIXTURES=1`, paths from `LUMAFORGE_100MP_RAF` / `LUMAFORGE_SONY_ARW` with the `/workspaces/LumaForge/test-images` defaults): for each fixture × profile: `session init`, `render export`, `manifest verify`, `render replay`; prints a Markdown table with wall time and peak RSS that is pasted into `docs/audits/2026-09-05-lmfg-large-file-validation.md`. Package script `validate:large`.
- [x] L4 Record before/after peak RSS for the RAF export in the execution notes.

### Task M — candidate evaluation (P3-2)
- [x] M1 `services/evaluation.ts`: `flattenMetrics(metrics)` → `Record<'luma.mean' | ... , number>`; `compareMetrics(baseline, candidate)` → `{ [key]: { baseline, value, delta } }`; `scoreCandidate(flat, objective)` where objective terms are `{ target?: number; min?: number; max?: number; weight?: number }` per key: penalty = weight × |value − target| (target) or weight × max(0, min − value, value − max) (range); lower is better; `rankCandidates(list, objective)` returns sorted `[{ candidate_id, score, terms }]` with stable tie-break by candidate id.
- [x] M2 Commands `metrics compare --iteration <id> [--baseline <candidate-id>]` (default baseline: first candidate) and `metrics rank --iteration <id> --objective <file|json>`; schemas `lmfg.metrics.compare.v1`, `lmfg.metrics.rank.v1`, `lmfg.objective.v1` in the registry; README.
- [x] M3 Tests: unit for flatten/compare/score/rank (including tie-break and validation errors → exit 2); e2e on the sweep iteration.

### Task N — MCP server (P3-1)
- [x] N1 `packages/lmfg-mcp`: depends on `@lumaforge/lmfg-cli` (workspace) and `@modelcontextprotocol/sdk`; bin `lmfg-mcp` (stdio). `tools.ts` declares one tool per CLI command with a zod input schema (session/workspace/params/plan fields typed, `params`/`plan` accept inline objects) and an argv builder; `server.ts` registers tools, runs `runCli(argv, io)` in-process capturing stdout, parses the envelope, returns `{ content: [{ type: 'text', text }], structuredContent: envelope, isError: !envelope.ok }`. Inline `params`/`plan` objects are passed to the CLI through the new `--params-json` / `--plan-json` options.
- [x] N2 Tests: unit (argv builders, envelope mapping), e2e (spawn `bin/lmfg-mcp.mjs`, JSON-RPC over stdio: `initialize`, `tools/list` contains every tool with an `inputSchema`, `tools/call lmfg_version` ok, `tools/call lmfg_session_status` without a session → `isError: true` with code `args.invalid`).
- [x] N3 Root scripts: `cli:build` builds `lmfg-mcp` too; `test:cli` runs both packages; `publish.yml` package list gains `@lumaforge/lmfg-mcp`; README for the package plus a section in the CLI README.

### Task O — cross-platform CI (P3-3)
- [x] O1 `build.yml` `cli` job: `strategy.matrix.os: [ubuntu-latest, macos-latest, windows-latest]`, `fail-fast: false`, `defaults.run.shell: bash`; cache keys already include `runner.os`; keep the smoke step.
- [x] O2 Windows audit: `workspace/paths.ts` (`join`/`resolve` only, no string concatenation with `/`), `atomic-fs.ts` (rename over existing target: retry once on `EPERM`), `iteration-store.ts`, e2e harness (spawn `process.execPath` with the `.mjs` bin; no `/tmp` assumptions), `source-loader.ts`. Fix findings; add a unit test for the rename retry.

### Task P — docs, review, verification
- [x] P1 README/CHANGELOG/spec status; execution notes with timing and RSS tables.
- [x] P2 Fresh-context review subagent over `git diff 9d27cfff..HEAD` with the same checklist as the P0/P1 pass plus: worker lifecycle, shared-memory safety, streaming sink atomicity, MCP error mapping, CI matrix syntax. Fix high/medium findings; re-run the verification set.

---

## Execution notes

### Review findings (fresh-context pass over `9d27cfff..HEAD`) and outcomes

| # | Severity | Finding | Outcome |
|---|---|---|---|
| 1 | high | The streaming writer renamed the temp file before validating it and removed the final path on failure, so a failed export could delete a pre-existing export | Fixed: `finish()` validates the temp file and returns `commit()` / `discard()`; the final path is untouched until commit; tests cover a failed stream next to an existing file and discard. |
| 2 | medium | `lmfg-mcp` never exited on stdin EOF (exit 13, unsettled top-level await) | Fixed: stdin `end` closes the server and `server.server.onclose` resolves the run; e2e spawns the bin with a closed stdin and asserts exit 0. |
| 3 | medium | The JPEG landed at the export path before manifest verification, so the "nothing was written" refusal was false | Fixed: `render export` and export replays verify the manifest first, then `commit()` the JPEG, then write the manifest; refusal discards the temp file. |
| 4 | low | Descriptor input-range normalization changed fingerprints without a version bump | No change: descriptor v2 has never been published (introduced after 0.1.0), so the normalization is part of v2's definition; noted here. |
| 5 | low | Dry-run reported a concurrency the real run could not use without the built worker | Fixed: dry-run applies the same worker-script fallback. |
| 6 | low | Pool ignored `messageerror` | Fixed: `messageerror` fails the run. |
| 7 | low | `ObjectiveSchema` looser than `validateObjective`; `localeCompare` tie-break | Fixed: schema refinements mirror the validator; tie-break uses code-point order. |
| 8 | low | Docs: temp-file name, EOI-before-rename claim, script path, MCP `workspace` claim, dead `assertJpegBytes` | Fixed in README, MCP README, this plan; dead code removed. |
| 9 | low | Test gaps | Added: worker crash before ready, failed export keeps an existing file, every MCP tool's argv, MCP exit on stdin close, a meaningful rank assertion. |

### Measurements

| Scenario | Before | After |
|---|---|---|
| 64-candidate sweep, public DNG, quick preview (render_ms / total) | 35.9 s / 36.3 s (serial) | 5.85 s / 6.2 s (`--concurrency auto` = 8 workers), 6.1x, all 64 `sha256` identical |
| 102 MP RAF export, desktop (seconds / peak RSS) | 81.1 s / 1217 MB | 81.8 s / 1204 MB, identical output sha |
| 102 MP RAF export, low-memory | 81.2 s / 1234 MB | 81.7 s / 1184 MB |

Large-fixture validation (RAF 102 MP and ARW 61 MP, both profiles: export,
verify, replay) is recorded in
`docs/audits/2026-09-05-lmfg-large-file-validation.md`; every replay
reproduced the export byte for byte.

### Deviations from the plan (all intentional)

- L1: the streaming writer lives in the CLI
  (`packages/lmfg-cli/src/services/jpeg-file-writer.ts`, `jpeg-file-sink.ts`)
  rather than in `@lumaforge/render-engine`, because the engine's `export`
  entry is bundled into the browser app and must stay free of `node:fs`. The
  engine contributes the pure pieces (`planJpegMetadataInjection`,
  `createStreamingSha256`). No `FileOutputResult` kind was added to the
  engine's output union; the sink hands the engine an empty bytes result and
  exposes the streamed file identity through `result()`.
- K3: the built worker (`dist/candidate-worker.js`) is resolved from the CLI
  package root; when it is missing (source checkouts before `pnpm cli:build`)
  the pool falls back to the inline path and records `concurrency: 1`.
- N1: the MCP server is a separate package (`packages/lmfg-mcp`) on
  `@modelcontextprotocol/sdk` 1.30 so the CLI keeps zero MCP dependencies;
  inline `--params-json` / `--plan-json` / `--contract-json` options were
  added to the CLI so hosts never need temp files.
- O2 Windows audit: the CLI builds every path with `node:path` (`join`,
  `resolve`) and `pathToFileURL`; the e2e harness runs the CLI in-process and
  the packaged-bin test spawns `process.execPath`, so nothing assumes a POSIX
  shell. `resolve('/', <absolute session path>)` in `runtime/source-loader.ts`
  is correct on Windows because absolute paths win in `resolve`. The one
  Windows-specific behaviour, transient `EPERM`/`EBUSY` on `rename`, is now
  retried (`renameWithRetry`, three attempts) for atomic writes and the
  streaming export. macOS and Windows results will only be known after the
  matrix runs in CI (push is the user's action).
- P2-3: Tier 1 (browser bridge) is deliberately not started; the CPU path is
  the authoritative export and the CLI preview is closer to it than the app's
  WebGL preview.
- RSS finding: the streaming sink saves only the JPEG-sized allocations
  (tens of MB) because peak memory for 60 to 100 MP files is dominated by the
  native decode; a materially smaller footprint needs row-band decoding in
  `@lumaforge/luma-raw-runtime`, which is outside this plan.
