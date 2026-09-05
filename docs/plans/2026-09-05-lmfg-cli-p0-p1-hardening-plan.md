# lmfg CLI P0 + P1 Hardening Plan (post 0.1.0 release)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the P0 release-hygiene items and the P1 functional gaps identified after the `@lumaforge/lmfg-cli@0.1.0` release (everything except DCP camera calibration), with tests, and iterate review → fix until the acceptance criteria below hold.

**Architecture:** Same package boundaries as the Tier 0 plan. New CLI capabilities live in `packages/lmfg-cli/src/services/*` with thin command adapters; manifest construction and the color-graph descriptor move down into `@lumaforge/render-engine/manifest` so the browser app and the CLI produce identical, cross-verifiable manifests. CI gains fixture caching and a mirror-aware fetch path so the `cli` job no longer depends on `raw.pixls.us` being online.

**Tech Stack:** TypeScript/ESM, Vitest, commander, zod 4, GitHub Actions, Node ≥ 20 (`fetch`, `AbortSignal.timeout`).

**Source of items:** the post-release recommendation list (P0 items 1–4, P1 items 6–8). DCP calibration (P1 item 5) is explicitly out of scope.

---

## Acceptance criteria (Definition of Done)

1. Verification is green with fresh evidence: `pnpm --filter @lumaforge/lmfg-cli typecheck`, `LMFG_REQUIRE_FIXTURE=1 pnpm test:cli`, `pnpm --filter @lumaforge/render-engine typecheck && test && build`, `pnpm test:runtime`, `pnpm lint:check`, `pnpm test:run`, `pnpm cli:build`, `LUMAFORGE_NATIVE_RUNTIME_MODE=prebuilt pnpm build`, and `npm pack --dry-run` for `render-engine` and `lmfg-cli`.
2. CI: `build.yml` parses; the `cli` job restores the DNG fixture from `actions/cache` keyed by the fixture lock and fails loudly (not silently skips) when the fixture is unavailable; the `native` job is not triggered by pure version bumps of `packages/luma-native-artifacts/`, and native source fetches have a mirror + retries; the `runtime` job covers `render-engine`.
3. Release traces: annotated git tags for the six published versions exist locally (pushing is the user's action), `packages/lmfg-cli/CHANGELOG.md` exists, and `.github/workflows/publish.yml` publishes with npm provenance from CI.
4. `lmfg.params.v1` accepts `selective_color`; it flows to the color graph, the manifest, and `lmfg schema show`.
5. `lmfg lut fetch --url --sha256` downloads into the workspace LUT cache with a network gate (exit 5), size/timeout limits and hash verification (exit 6), and returns an inspect + contract summary.
6. `lmfg render replay --manifest` re-renders a preview/candidate/export manifest from its recorded params, LUT contract, and exposure, refuses on fingerprint/source/LUT mismatch, and reports `reproduced` by comparing output SHA-256. The e2e suite proves a real export replays byte-identically.
7. The browser app attaches a sealed `RenderManifest` to a completed full-resolution export and offers "download manifest" on desktop and mobile; the manifest verifies with `lmfg manifest verify`.
8. A fresh-context review pass (subagent) over the full diff has no unresolved high or medium findings; each finding is fixed or explicitly deferred with a reason in this document's execution notes.

---

## File map

| Area | Files |
|---|---|
| Task A render-engine hygiene | `packages/render-engine/src/export/jpeg/jpeg-metadata.test.ts`, `.github/workflows/build.yml` (runtime job + paths) |
| Task B fixture resilience | `packages/luma-raw-runtime/fixtures/scripts/fetch-public-fixtures.mjs` (+ new `download.mjs`, `download.test.mjs`), `fixture-registry.mjs` (+test: `mirrors`), `public.lock.json` (mirror slot), `.github/workflows/build.yml` (cache + `LMFG_REQUIRE_FIXTURE`), `packages/lmfg-cli/src/test-support/fixture-gate.ts` (+test), `src/e2e/fixture.ts`, fixture-gated service tests |
| Task C native hardening | `packages/luma-raw-runtime/native/scripts/fetch-sources.mjs`, `packages/luma-jpeg-runtime/native/scripts/fetch-sources.mjs` (+ `download.mjs` helper + test), `native/sources.lock.json` (lcms2 primary → GitHub release, mirror → sourceforge), `.github/workflows/build.yml` (native paths + diagnostics step + artifacts package tests in `cli` job) |
| Task D release traces | git tags, `packages/lmfg-cli/CHANGELOG.md`, `.github/workflows/publish.yml`, `packages/lmfg-cli/README.md`, `AGENTS.md` |
| Task E selective_color | `packages/render-engine/src/manifest/render-manifest.ts` (+test), `packages/lmfg-cli/src/schemas/params.ts` (+test), `services/color-graph.ts` (+test), `README.md` |
| Task F lut fetch | `packages/lmfg-cli/src/services/lut-fetch.ts` (+test), `commands/lut.ts`, `schemas/results.ts`, `schemas/registry.ts`, `workspace/paths.ts`, `src/e2e/cli.e2e.test.ts`, `README.md` |
| Task G render replay | `packages/render-engine/src/manifest/render-manifest.ts` (`PolicyChoice.max_pixels`), `packages/lmfg-cli/src/services/replay.ts` (+test), `services/color-graph.ts` (`manifestToRenderParams`), `commands/render.ts`, `protocol/errors.ts` (`replay.mismatch`), `schemas/results.ts`, `schemas/registry.ts`, `workspace/paths.ts`, e2e, `README.md` |
| Task H shared manifest + app | `packages/render-engine/src/manifest/color-graph-descriptor.ts` (+test), `create-render-manifest.ts` (+test), `manifest/index.ts`, `src/index.ts`; CLI `services/color-graph.ts`, `services/manifest.ts`; app: `scripts/build/runtime-environment.mjs` (+test), `vite.config.ts`, `src/lib/export/export-manifest.ts` (+test), `src/modules/raw-processor/model/export-result.ts`, `model/session.ts` (LUT sha256), `services/look/orchestrate-lut-load.ts`, `services/export/orchestrate-full-res-export.ts`, `services/export/export-result-actions.ts` (+test), `hooks/stages/export/useExportResultActions.ts`, `useRawExportStage.ts`, `buildRawWorkflowReturn.ts`, `useRawWorkflow.types.ts`, `components/RawWorkflowContext.tsx`, `RawWorkflowToolProvider.tsx`, `components/tools/ExportTool.tsx`, `components/mobile/MobileExportPanel.tsx`, `src/locales/{en,zh-CN}.json`, `tests/browser/*.spec.ts` |
| Task I docs | `packages/lmfg-cli/README.md`, `AGENTS.md`, this plan (execution notes), spec status |
| Task J review | review subagent report → fixes |

---

## Tasks

### Task A — render-engine hygiene (P0-4)
- [x] A1 Fix `jpeg-metadata.test.ts` BlobPart typing (`new Blob([new Uint8Array(jpeg)])`); `pnpm --filter @lumaforge/render-engine typecheck` exit 0.
- [x] A2 `build.yml`: add `packages/render-engine/` to `runtime_paths`; add steps "Typecheck render engine", "Test render engine", "Build render engine" to the `runtime` job (after runtime package builds, since its tsconfig maps to sibling `dist` d.ts).
- [x] A3 Commit `fix(render-engine): repair Blob typing in jpeg metadata test and gate render-engine in CI`.

### Task B — fixture resilience (P0-1)
- [x] B1 New `packages/luma-raw-runtime/fixtures/scripts/download.mjs`: `downloadToFile({ urls, destination, timeoutMs, attempts, backoffMs, fetchImpl, log })` — tries each URL in order, each up to `attempts` times with exponential backoff, streams to a temp file, renames on success, throws an aggregated error listing every attempt. Test with `node:http` server: success on first URL; 500 then 200 (retry); first URL 404 then mirror succeeds; all fail → error lists attempts; timeout honoured.
- [x] B2 `fixture-registry.mjs`: accept optional `mirrors: string[]` per fixture (validated like `url`); test.
- [x] B3 `fetch-public-fixtures.mjs`: build the URL list as `[env LUMAFORGE_FIXTURE_MIRROR + '/' + file (if set), fixture.url, ...fixture.mirrors]`; env `LUMAFORGE_FIXTURE_ATTEMPTS` (default 3) and `LUMAFORGE_FIXTURE_TIMEOUT_MS` (default 120000); log each attempt.
- [x] B4 `packages/lmfg-cli/src/test-support/fixture-gate.ts`: `resolveFixtureGate()` → `{ ready, reason, required }` reading `LMFG_REQUIRE_FIXTURE`; `describeWithFixture` uses it and **throws at import** when required and not ready. Service tests switch to the shared gate. Test: `required && !ready` throws with the reason.
- [x] B5 `build.yml` `cli` job: `actions/cache@v4` on `packages/luma-raw-runtime/fixtures/.cache/public` with key `${{ runner.os }}-raw-fixtures-${{ hashFiles('packages/luma-raw-runtime/fixtures/public.lock.json') }}`; fetch step keeps running (no-op on cache hit because the script verifies the hash); `LMFG_REQUIRE_FIXTURE: 1` on the "Test lmfg CLI" step. Same cache block in the `native` job before its fixture step.
- [x] B6 Verify: `pnpm --filter @lumaforge/luma-raw-runtime test` green; `LMFG_REQUIRE_FIXTURE=1 pnpm test:cli` green; `LMFG_REQUIRE_FIXTURE=1 LMFG_FIXTURE_PATH=/nonexistent pnpm test:cli` fails loudly (manual check, documented). Commit.

### Task C — native job hardening (P0-2)
- [x] C1 Reproduce locally with the pinned emsdk (`build:native` + `native:verify`) and record the outcome. If it passes locally the CI failure is environment-specific; the hardening below still lands and the user is asked for the job log.
- [x] C2 `native/sources.lock.json` (raw): lcms2 primary URL → `https://github.com/mm2/Little-CMS/releases/download/lcms2.18/lcms2-2.18.tar.gz` (verified sha256 `ee67be…4347`), `mirrors: ["https://downloads.sourceforge.net/project/lcms/lcms/2.18/lcms2-2.18.tar.gz"]`. Both `fetch-sources.mjs` (raw, jpeg) gain a shared-shape `download.mjs` (copied per package; the scripts ship in the published package) with retries + mirrors; lock validation accepts `mirrors`. Tests under `native/scripts/*.test.mjs`; raw `test` script adds `native/scripts`.
- [x] C3 `build.yml`: `native_paths` drops `packages/luma-native-artifacts/`; the `cli` job runs `pnpm --filter @lumaforge/luma-native-artifacts test`; the `native` job gains a "Native build diagnostics" step (`emcc --version`, `node --version`, `node native/scripts/fetch-sources.mjs` for both runtimes) before the build steps so failures are attributable.
- [x] C4 Verify + commit.

### Task D — release traces (P0-3)
- [x] D1 Annotated tags at `a892d9d2`: `@lumaforge/luma-native-artifacts@0.0.3`, `@lumaforge/luma-color-runtime@0.1.1`, `@lumaforge/luma-jpeg-runtime@0.1.1`, `@lumaforge/luma-raw-runtime@0.1.1`, `@lumaforge/render-engine@0.1.0`, `@lumaforge/lmfg-cli@0.1.0`.
- [x] D2 `packages/lmfg-cli/CHANGELOG.md` (Keep a Changelog style): `0.1.0` (2026-09-05) + `Unreleased` populated as tasks land.
- [x] D3 `.github/workflows/publish.yml`: `workflow_dispatch` inputs `packages` (comma list; default `@lumaforge/luma-color-runtime,@lumaforge/luma-jpeg-runtime,@lumaforge/luma-raw-runtime,@lumaforge/render-engine,@lumaforge/lmfg-cli`), `dist_tag` (default `latest`), `dry_run` (default `true`); permissions `id-token: write`, `contents: read`; steps: checkout, Node with `registry-url`, pnpm, install, prebuilt native prepare, `pnpm cli:build`, `pnpm test:runtime`, `LMFG_REQUIRE_FIXTURE=1 pnpm test:cli` (after fixture cache/fetch), then per package `pnpm --filter <pkg> publish --access public --no-git-checks --provenance --tag <dist_tag>` (adds `--dry-run` when requested) with `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}`. README "Releasing" documents the flow and that `luma-native-artifacts` stays a manual publish until the native job builds in CI.
- [x] D4 Verify YAML with prettier; commit.

### Task E — `selective_color` params (P1-6)
- [x] E1 render-engine `RenderParams.selective_color?: Readonly<Record<string, SelectiveColorBandShift>>` with `SelectiveColorBandShift = { hue: number; saturation: number; lightness: number }`; test seals/verifies.
- [x] E2 CLI schema: `BandShiftSchema = strictObject({ hue?, saturation?, lightness? })` each `slider(-100,100)`; `SelectiveColorSchema = strictObject({ red?, orange?, yellow?, green?, aqua?, blue?, purple?, magenta? })`; `selective_color: SelectiveColorSchema.nullable().default(null)`; override accepts it. Tests: valid, unknown band rejected, out of range rejected.
- [x] E3 `buildColorGraph` passes `selectiveColor` (missing fields → 0); `toManifestRenderParams` emits the normalized full record when present; `manifestToRenderParams` (Task G) reads it back. Tests: graph `user-selective-color` step bands reflect input; fingerprint differs from neutral; manifest round trip.
- [x] E4 README params example; e2e: preview with `selective_color` renders and verifies. Commit.

### Task F — `lut fetch` (P1-7)
- [x] F1 `services/lut-fetch.ts`: `fetchLutFile(input: { url; expectedSha256; destination; allowNetwork; maxBytes?; timeoutMs?; fetchImpl? })` → `{ path, sha256, byte_size, url, cached }`. Rules: destination exists with matching sha → `cached: true` without network; `!allowNetwork` → `network.not_allowed`; non-http(s) URL → `args.invalid`; `!response.ok` → `fetch.failed` (details status, retryable for 5xx/429); content-length or streamed size > max → `fetch.failed`; abort/timeout → `fetch.failed` (retryable); sha mismatch → `hash.mismatch` (temp removed); atomic write. Tests with a local `node:http` server for every rule.
- [x] F2 Command `lut fetch --url <url> --sha256 <hex> [--out <file>] [--allow-network]`; env `LMFG_ALLOW_NETWORK=1` also enables; default destination `<workspace>/luts/<sha256>.cube` (`workspacePaths.lutCacheFile`). Result `lmfg.lut.fetch.v1` = fetch facts + `inspect` (LutInspectResult) + `contract` (LutContractInferResult). Dry-run returns destination + cached.
- [x] F3 e2e: local http server in the e2e file serves `display.cube`; `lut fetch` without `--allow-network` → 5; with flag → 0 and file lands in cache; wrong sha → 6; then `render preview` with `lut.path` = cached path works. README. Commit.

### Task G — `render replay` (P1-8a)
- [x] G1 render-engine `PolicyChoice.max_pixels?: number` (additive). CLI records it for preview/candidate policies.
- [x] G2 `services/color-graph.ts`: `manifestToRenderParams(manifest.render_params): RenderParams` (inverse of `toManifestRenderParams`; `raw_render_exposure` set to the recorded EV) + `exposureFromManifest` reuse. Round-trip test.
- [x] G3 `services/lut.ts`: `contractInputFromIdentity(lut: LutLocalFileIdentity): LutContractInput` (role from `output_contract.role`, input gamut/transfer/range, output gamut/transfer/range). Test.
- [x] G4 `services/replay.ts`: `prepareReplay({ manifest, source, lutPath?, workspaceRoot, cwd })` → resolves LUT (explicit path or `<workspace>/luts/<sha256>.cube`; sha must equal `manifest.lut.sha256` else `hash.mismatch`), params, exposure `{ ev, multiplier, source }` from the manifest, builds the graph and asserts `fingerprint === manifest.color_graph.fingerprint` else `replay.mismatch` (exit 8, details expected/actual). `runReplay(...)` renders by kind (export: `runFullResolutionExport` with recorded quality/row_slice; preview/candidate: `renderPreview` with `max_pixels ?? width*height`), checks dimensions, compares sha256 → `reproduced`. Writes `<session>/replays/<sha12>/output.jpg` + `manifest.json` (parent = replayed manifest sha256). Unit tests for prepare (fingerprint mismatch path via a doctored manifest); fixture-gated test for a byte-identical export replay.
- [x] G5 Command `render replay --manifest <file> (--session <id> | --source <raw>) [--lut <file>] [--name <name>]`; `replay.mismatch` error code → exit 8; result schema `lmfg.render.replay.v1`; NDJSON events (`started`, `export.progress`, `artifact.ready`). e2e: replay the export manifest → reproduced; replay candidate manifest → reproduced; source mismatch → 6. README. Commit.

### Task H — shared manifest builder + app manifest (P1-8b)
- [x] H1 Engine: `manifest/color-graph-descriptor.ts` (`describeColorGraph`, `fingerprintColorGraph`, `colorGraphIdentity`) and `manifest/create-render-manifest.ts` (`createRenderManifest`) moved from the CLI with their tests; exported from `@lumaforge/render-engine/manifest` and root. CLI imports them (delete duplicates), CLI tests stay green.
- [x] H2 App build-time environment: `scripts/build/runtime-environment.mjs` (`resolveRuntimeEnvironment({ rootDir })` reading package versions + provenance for both variants; test) wired into `vite.config.ts` `define` as `APP_RENDER_ENVIRONMENT` (JSON with `desktop`/`low-memory` variants).
- [x] H3 LUT sha256 retained: `orchestrate-lut-load.ts` hashes the `.cube` bytes (`sha256Hex`) for uploads; catalog LUTs carry the entry sha256; `StyleAsset.lutAsset.sha256?: string` + `catalogEntry?` (id/version) additive; existing tests updated.
- [x] H4 `src/lib/export/export-manifest.ts`: `buildFullResExportManifest({ graph, params, rawRenderExposure, source: { file, sha256, width, height }, lut: LutIdentity | null, output: { sha256, width, height, quality, filename }, policy, environment })` → sealed manifest via engine `createRenderManifest`. Unit tests (sealed, verifies, fields mapped).
- [x] H5 Orchestrator: after completion compute `sourceContentIdFromFile(activeSourceFile)`, materialize the output blob and hash it, build the manifest, attach `manifest` to `ExportResult` (model additive) and store on the session. Failure to build a manifest must not fail the export: log via `emitExportDebugEvent` and leave `manifest` undefined.
- [x] H6 Action `downloadExportManifest(result)` (JSON sidecar `<basename>.manifest.json`), hook → workflow → context (`onDownloadExportManifest`) → desktop `ExportTool` button (`raw.export.downloadManifest`) and mobile `MobileExportPanel` action (grid adjusted per anti-slop guardrails). i18n en + zh-CN. Unit tests for the action and component rendering (button shown only when `result.manifest` exists).
- [x] H7 Browser validation: extend an existing chromium export spec to click the manifest action, capture the download, and assert `verifyManifestSha256` passes and `output.sha256` equals the downloaded JPEG's SHA-256. Commit.

### Task I — docs
- [x] I1 README (lmfg-cli): `lut fetch`, `render replay`, `selective_color`, `LMFG_ALLOW_NETWORK`, replay semantics, exit-code table update; AGENTS.md verification line for `LMFG_REQUIRE_FIXTURE`; CHANGELOG `Unreleased`; execution notes in this plan; spec status line.

### Task J — review → fix iterations
- [ ] J1 Fresh-context review subagent over `git diff a892d9d2..HEAD` with a checklist (fail-closed paths, error/exit code mapping, atomicity, schema/registry consistency, CI YAML, docs accuracy). Record findings in execution notes.
- [ ] J2 Fix every high/medium finding; re-run the full verification set; repeat J1 once more if any fix touched behavior.

---

## Execution notes

### Deviations from the plan (all intentional)

- H2: the build-time define is `APP_RENDER_ENVIRONMENTS` (plural, keyed by
  `desktop` / `low-memory`) and the resolver is
  `scripts/build/runtime-environment.mjs` `resolveRenderEnvironments`; it is
  also wired into `vitest.config.ts` so app tests see the same shape.
- H3: uploaded and online `.cube` files are hashed at load time
  (`sourceContentIdFromBytes`) and the hash is retained on
  `StyleAsset.lutAsset.sha256`; no `catalogEntry` field was added because the
  browser manifest records online LUTs as `local-file` identities (filename +
  sha256 + contracts), which is what `render replay` consumes.
- H4/H5: the app builder lives in
  `src/modules/raw-processor/services/export/export-manifest.ts` and
  `attach-export-manifest.ts`. The output hash is **not** computed by
  re-reading the export output: file-backed (OPFS) output must never be
  reopened outside a user action (`useRawWorkflow` "does not open file-backed
  export output until a result action runs"), so the worker records the hash
  when it publishes the finalized bytes (`createOpfsOutputWritable().close()`
  returns `{ byteLength, sha256 }`, the blob path hashes the metadata-injected
  JPEG) and the manifest builder refuses to seal a file-backed result whose
  hash was not recorded. The first browser run caught exactly this gap
  (Chromium desktop uses the OPFS sink): the success message dropped the
  hash, `export-manifest-failed` fired, and no Manifest button appeared. The
  second run caught the next layer: file-backed output stays metadata-free on
  disk and the app injects EXIF on delivery, so the hash of the published
  file did not identify the downloaded JPEG. The worker now hashes the
  delivered layout (`planJpegMetadataInjection` +
  `sha256OfJpegWithMetadata`, shared with `preserveJpegMetadata*`) and ships
  the exact metadata it hashed with (`deliveryMetadata`) so delivery injects
  the same bytes.
- G4: replay artifacts are written under
  `<session>/replays/<first 12 hex of the manifest sha256>/` (or
  `--name <basename>`), as planned; the review caught an earlier note here
  that claimed a timestamped directory.
- C1: the native build reproduced locally with the pinned emsdk 5.0.6
  (`build:native` + `native:verify` pass; wasm hash differs from the published
  artifacts as expected for a different toolchain host). The CI failure is
  therefore environment-specific; the job now prints diagnostics and fetches
  lcms2 from the GitHub release mirror with retries. If the next CI run still
  fails, the job log is needed.
- B6: with `LMFG_REQUIRE_FIXTURE=1 LMFG_FIXTURE_PATH=/nonexistent` the
  fixture-gated CLI specs fail at import with the gate reason instead of
  skipping (manual check recorded below).
