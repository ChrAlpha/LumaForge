# WebGPU replaces WebGL: QA and consistency audit

Date: 2026-10-03
Spec: `docs/specs/2026-10-03-webgpu-replaces-webgl-design.md`
Branch: `feat/webgpu-migration`
Baseline: `main` at c667ff65 (WebGL2 preview)
Pre-removal checkpoint: e9ccf140 (WebGPU-first with a WebGL fallback)

All browser evidence below was produced in the devcontainer with Chromium 147
and WebKit 26.4 from Playwright 1.59. The only GPU available there is
SwiftShader (software Vulkan for WebGPU, ANGLE SwiftShader for WebGL), so no
claim here is about hardware GPU performance or driver behavior. Artifacts live
under `/workspaces/LumaForge/qa-runs/webgpu-migration/` on the dev host.

## 1. Synthetic color consistency

### 1.1 WebGPU against WebGL, before the WebGL deletion

`scripts/webgpu/validate.mjs` at e9ccf140, which rendered every scenario through
both renderers:

| Check | Result |
|---|---|
| Scenarios | 300 / 300 pass |
| Visible canvas, max error | 1 / 255 |
| Processed float output, max error | 0.003 |

Coverage: neutral, all eight built-in styles, tone, color balance, saturation
and vibrance, selective color (HSL), original and compare views, four LUT
roles, a non-unit LUT domain, input and output for all 22 transfer curves, full
and resized HQ snapshots, tiled snapshot, clear and re-upload, edit bursts, and
readback cancellation, on both the display-sRGB float input and the linear
ProPhoto RAW input.

### 1.2 WebGPU against the export executor, after the deletion

The harness reference is now `renderCpuPreviewFrame(resolveExportColorGraph(…))`,
the TS row-band executor behind full-resolution export, `lmfg`, and the CPU
preview. Paths export does not cover (built-in styles, the display-sRGB preview
input) are held to WebGL output frozen from e9ccf140
(`scripts/webgpu/goldens.json`, 34 frames).

| Check | Result |
|---|---|
| Checks | 271 / 271 pass |
| WebGPU vs export executor, max error | 1 / 255 |
| WebGPU vs frozen WebGL, max error (34 frames) | 1 / 255 |
| Scenarios with no oracle (listed, not counted as passes) | 49 float-input transfer and partial-strength LUT variants |

### 1.3 Preview-versus-export mismatches found and fixed

Holding the preview to the export executor exposed two mismatches that the
WebGL preview had as well, so they are not migration regressions. Both were
fixed on the GPU side; export output is unchanged.

| Mismatch | Before (WebGL and WebGPU) | After |
|---|---|---|
| Display-look, combined, and technical LUTs below full strength: the preview clamped the base to white before blending, export does not | up to 35 / 255 in bright highlights | ≤ 1 / 255 |
| Display-look LUT declaring a Display P3 or Rec.2020 output gamut: the preview ignored it, export converts it to sRGB | up to 110 (P3) and 153 (Rec.2020) / 255 | ≤ 1 / 255 |

## 2. Automated suites

All rows ran on the branch head, `cd9d9678`.

| Command | Result |
|---|---|
| `pnpm lint:check` | pass |
| `pnpm exec tsc --noEmit` | pass |
| `pnpm test:app` | 217 files, 1876 tests pass |
| `pnpm test:runtime` | color runtime 270, RAW runtime 177 (3 skipped), JPEG runtime 55, app adapters 251: all pass |
| `pnpm --filter @lumaforge/render-engine test` | 195 pass |
| `pnpm cli:build`, `pnpm --filter @lumaforge/lmfg-cli typecheck` | pass |
| `LMFG_REQUIRE_FIXTURE=1 pnpm test:cli` | 197 CLI + 33 MCP tests pass |
| `LUMAFORGE_NATIVE_RUNTIME_MODE=prebuilt pnpm build` | pass |
| `pnpm test:webgpu` | 271 / 271 checks pass, 49 scenarios listed as uncovered (section 1.2) |
| `pnpm exec playwright test` (`chromium-desktop` with software WebGPU, `webkit-ios-safe` on the CPU preview) | 90 tests: 57 passed, 32 skipped, 1 failed. WebKit: 0 failed |

The one failure is `raw-export-lifecycle-resources` on Chromium, at its
exposure slider drag; it fails the same way on `main` (section 5). The skips
are GPU-stage specs on WebKit, which has no WebGPU here, and specs written for
one project only.

## 3. Real-RAW before/after traversal

`scripts/webgpu/qa/raw-consistency.mjs` drives the built `/raw` through the real
UI with a Nikon Z f NEF (`zf-6885.NEF`, 4900×3264), then compares a capture of
`main` (WebGL2) against a capture of this branch (WebGPU). Both captures ran in
the same Chromium 147 with the same SwiftShader flags, served by
`vite preview` from prebuilt native assets.

### 3.1 Desktop, 1440×900

| | WebGL baseline (`main`) | WebGPU candidate |
|---|---|---|
| Scenarios | 58 / 58 ok | 58 / 58 ok |
| Console / page errors | 0 / 0 | 0 / 0 |
| Renderer evidence | `webgl2` contexts, 474 GL draws, 0 GPU submits, compare `dual-webgl` | `webgpu` contexts on a SwiftShader adapter, 0 GL draws, 247 queue submits, compare `dual-gpu` |
| Wall time | about 38 min | about 15 min |

Scenarios: ingest, neutral; exposure, contrast, highlights, shadows, whites,
blacks, combined tone; temperature, tint, saturation, vibrance in both
directions; two HSL band groups; compare split at 27/50/80/100 % and
zoom-and-pan; each of the 11 catalog looks, and off/light/strong strength on
one of them;
an illegal-range LUT file (rejected) and a legal one (loaded); four LUT input
contracts (S-Log3, N-Log, LogC3, display sRGB); Transform grid, the four
Upright modes, rotate +3° with crop on and off; HQ preview and
full-resolution exports (neutral, combined edit, rotated); RAW replacement;
session reset.

| Comparison | Result |
|---|---|
| Preview, stage and histogram captures | 123 images: 41 identical, max error 1 / 255, no pixel above 2 / 255 |
| Full-resolution JPEG exports (neutral, combined, Transform) | 3 / 3 byte-identical |
| HQ preview JPEG exports (GPU snapshot, then JPEG) | bytes differ; decoded max 13 / 255, mean ≤ 0.018, ≤ 0.15 % of pixels above 2 |
| DOM state | identical apart from the renamed compare mode (`dual-webgl` → `dual-gpu`) and original-layer class |

The HQ preview JPEG is the only GPU-produced export. The snapshot pixels that
feed it agree within 1 / 255 (section 1.2 and the preview captures above), so
the JPEG differences are consistent with the encoder amplifying sub-level input
differences into whole 8×8 blocks. That is an interpretation, not a separate
measurement.

### 3.2 Mobile, 393×852 touch

Same traversal through the mobile dock and list panels (63 scenarios,
including the press-to-peek original).

| | WebGL baseline | WebGPU candidate |
|---|---|---|
| Scenarios | 63 / 63 ok | 63 / 63 ok |
| Console / page errors | 0 / 0 | 0 / 0 |

| Comparison | Result |
|---|---|
| Preview, stage and histogram captures | 82 images: 80 within 1 / 255; 2 explained below |
| Full-resolution JPEG exports | 3 / 3 byte-identical (same hashes as desktop) |
| HQ preview JPEG exports | same small JPEG-level differences as desktop |

The two exceptions are capture state, not color:

- `neutral` full-stage screenshot: the photo sits 45 px higher on the
  baseline because a dock panel was selected at capture time there and not in
  the candidate (`dom.mobile.dockSelected` differs). The photo-only capture of
  the same scenario is within 1 / 255.
- `lut-file-legal-33-loaded` preview (max 127, mean 4.25): the stage was one
  row shorter at that moment (262 instead of 263 rows) and the two captures
  resampled it differently. The smooth sky is identical, differences sit on
  tree and grass texture, and after a 9×9 box blur the mean difference is
  0.66. Running the scenario again in isolation reproduced the same
  geometry-only difference.

### 3.3 CPU preview (`?forcePreview=cpu`), desktop

| | `main`, forced CPU | branch, CPU |
|---|---|---|
| Scenarios | 50 / 50 ok (post-export scenarios skipped: section 4) | 54 / 54 ok |
| Console / page errors | 0 / 0 | 0 / 0 |
| Preview and histogram captures | 73 common images, all within 1 / 255 | |
| First full export (neutral) | `d63fa950…` | `ee4bfe4c…` (render exposure measured from the smaller CPU preview, section 4) |

The only state differences are whether the dismissible CPU banner was showing
at capture time.

## 4. CPU fallback

Without WebGL, every browser that lacks WebGPU runs the CPU preview, so that
path was exercised directly: the Playwright WebKit build (no WebGPU) and
`?forcePreview=cpu` in Chromium. Three defects surfaced. All exist on `main`,
where forced CPU preview reproduces them, but before this change only
browsers without WebGL reached them.

| Defect | Effect | Fix |
|---|---|---|
| The RAW decode bridge's 10 s idle timer terminated the RAW worker while an open session was still using it directly (quick decode, export probe, bounded HQ) | On large or slow loads (the 100 MP GFX100RF RAF, or a busy machine) full-resolution export stayed disabled with "RAW runtime worker was disposed." and the bounded HQ preview never arrived, in GPU and CPU preview alike | Open sessions lease the worker until disposed (`b6a33c01`) |
| After a full-resolution export released the preview, the CPU stage showed "CPU preview unavailable" with every control disabled; only the GPU stage offered Restore preview | CPU-preview users had to reload the RAW to keep editing after any export | The CPU path uses the shared export-ready handoff while the preview is released (`688c8a75`) |
| The CPU preview notice was a third child of the two-row `.raw-lab` grid | Desktop: the notice sat in a zero-height row under the stage and never showed. Mobile: it took the stage's row, so the loaded photo got 482 of 852 px, and on the empty state the shell overflowed the viewport by 76 px (the intermittent WebKit `raw-viewport-scroll` failure) | Desktop renders the notice in the header's row; mobile renders it in the chrome below the topbar; only the active surface mounts it (`cd9d9678`, new browser spec in `raw-viewport-scroll`) |

Observed after the fixes:

- WebKit project: 0 failed in the full run (section 2). This includes the
  100 MP RAF export preflight, which previously could not reach an enabled
  export, and the new CPU notice layout spec.
- Chromium `?forcePreview=cpu`, 100 MP RAF: export enabled about 12.5 s after
  load and completed at 11662×8746.
- Chromium `?forcePreview=cpu`, Nikon Z f NEF: export, Restore preview, edit,
  export again, three times in a row, with no errors.

Two differences from the baseline are expected and explained:

- **Preview size.** The CPU preview budget caps the bounded HQ preview at the
  quick-preview size (1937×1290 for the Nikon Z f NEF). `main` with forced CPU
  preview showed 4900×3264 only because its GPU budget still probed WebGL
  while forced to CPU; a `main` browser that genuinely lacked WebGL already
  used the smaller budget.
- **First export after load in CPU mode.** The automatic render exposure is
  measured from the decoded preview, so the smaller CPU preview measured
  1.6012 EV where the GPU path measured 1.5980 EV, and the first neutral
  export's bytes differ (`ee4bfe4c…` against `d63fa950…`). Manifests record
  the exposure, so replay is unaffected. See open items.

## 5. Open items

- **Export bytes depend on the preview tier.** The automatic render exposure
  comes from the decoded preview's statistics, so the same RAW and edits can
  export with a slightly different exposure on a CPU-preview device than on a
  WebGPU device (0.003 EV in the case above). This predates the migration. A
  resolution-independent exposure source would remove it; that is a product
  decision.
- **Hardware GPUs.** All browser evidence here used SwiftShader. Before
  release, run `pnpm test:webgpu --hardware` and a short manual pass on at
  least one Apple GPU (Safari 26) and one Windows GPU (Chrome).
- **WebKit with WebGPU.** Safari 26 has WebGPU but the Playwright WebKit build
  does not, so the mobile GPU stage was verified only in Chromium with touch
  emulation (`raw-adjust-interaction` mobile stage spec and the mobile
  traversal).
- **CI job.** The `webgpu` job in `.github/workflows/build.yml` has not run on
  GitHub yet; it needs one green run after push.
- **Pre-existing test failure.** `raw-export-lifecycle-resources` fails at its
  slider drag on `main` as well; it is unrelated to the renderer.
