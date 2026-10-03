# WebGPU replaces WebGL: implementation and QA plan

Spec: `docs/specs/2026-10-03-webgpu-replaces-webgl-design.md`

Branch: `feat/webgpu-migration` (WebGPU-first renderer with a WebGL fallback,
39 commits on `main` at c667ff65). Each unit below is one commit and is
verified before the next starts.

## Baseline evidence (recorded before any change)

- `pnpm lint:check` pass; `pnpm test:app` 222 files / 1966 tests pass;
  `tsc --noEmit` pass (branch head e9ccf140).
- `node scripts/webgpu/validate.mjs --iterations 5`: 300/300 WebGPU vs WebGL
  scenarios pass, visible max 1/255, processed float max 0.003.

## Units

1. **Contract extraction.** Move renderer-neutral types and helpers out of
   `src/lib/gl/webgl-pipeline.ts` and `src/lib/gl/context.ts` into
   `src/lib/webgpu/contract.ts` and `src/lib/webgpu/lut-profile.ts`. WebGPU
   modules stop importing from `src/lib/gl`. No behavior change.
   Verify: focused vitest on `src/lib/webgpu`, `src/lib/gl`, tsc.
2. **Backend ladder `webgpu -> cpu`.** `gpu-backend.ts` stops probing WebGL;
   CPU reasons become `webgpu-unavailable | gpu-preview-failed | forced`;
   `forcePreview` accepts only `cpu`. The facade never constructs a WebGL
   renderer. Capability gate, CPU banner, and i18n key follow.
   Verify: focused vitest on preview, capability gate, raw-processor hooks.
3. **Delete WebGL.** Remove `webgl-pipeline.ts`, `context.ts`, `shaders.ts`
   and their tests; move the facade to `src/lib/webgpu/raw-processing-pipeline.ts`
   and HQ snapshot planning to `src/lib/webgpu/export-plan.ts`; update imports.
   Verify: `pnpm test:app`, tsc, lint.
4. **Color runtime drops GLSL.** Remove `glsl.ts`, `saturation-glsl.ts`, the
   `./glsl` export; rename `mat3ToGLSL` to `mat3ToColumnMajor`; bump to 0.2.0.
   Verify: package typecheck, test, build; `pnpm test:runtime`.
5. **Vocabulary.** `dual-webgl` to `dual-gpu`, `OriginalWebglLayer` to
   `OriginalGpuLayer` (and its CSS class), GPU budget facts in app and
   `render-engine`, export resource kinds, `lmfg` capability name.
   Verify: `pnpm test:app`, render-engine tests, `pnpm cli:build`, CLI
   typecheck and `LMFG_REQUIRE_FIXTURE=1 pnpm test:cli`.
6. **Parity against the authoritative executor.** `scripts/webgpu/validate.mjs`
   compares WebGPU output with `renderCpuPreviewFrame` instead of WebGL.
   Add a `pnpm test:webgpu` script.
   Verify: the harness passes on SwiftShader.
7. **Browser projects.** Primary Chromium project runs with software WebGPU;
   the separate `chromium-webgpu` project folds into it; WebKit covers the
   CPU fallback. Helpers drop `forcePreview=webgpu`.
   Verify: `pnpm test:browser` on Chromium and WebKit.
8. **Docs.** AGENTS.md, README, DESIGN.md describe the single GPU executor
   and the new compare ladder.

## QA: traverse every `/raw` feature, before vs after

Baseline: `.worktrees/feat/transform-demo` (clean checkout of c667ff65, WebGL).
Candidate: this branch after unit 8 (WebGPU, CPU fallback).

1. Automated suites on both: unit, runtime, CLI, browser.
2. Real-RAW consistency script on both, same RAW, same viewport: ingest
   stages, every Adjust/Tone/Color/HSL control, built-in looks and strength,
   a scene LUT with a log input contract, compare modes and split,
   histogram, Transform (auto, rotate, crop), HQ preview snapshot,
   full-resolution export. Compare preview captures per scenario within the
   parity tolerance; full-resolution export bytes must be identical.
3. Exploratory pass with a real browser on desktop and 393 px mobile, GPU and
   `?forcePreview=cpu`: every tool, sheet, dock mode, scrub HUD, reset, file
   replacement, and console errors.
4. Record evidence in `docs/audits/2026-10-03-webgpu-migration-qa.md`.

## Follow-ups that landed during execution

- Holding the preview to the export executor exposed two preview-vs-export
  mismatches that the WebGL preview shared: partial-strength display-domain
  LUT blending (up to 35/255) and display looks with a declared wide output
  gamut (up to 153/255). Both were fixed on the GPU side.
- An independent review led to: auxiliary GPU pipelines no longer flipping the
  whole app to CPU, device-loss replay to late subscribers, removal of the
  render option and synchronous readback that only threw, a WGSL matrix sync
  test, WebGL goldens for paths without an export oracle, and a CI job.
- Browser QA in CPU mode surfaced a pre-existing RAW worker lifetime bug: the
  decode bridge's 10 s idle timer killed open sessions, disabling
  full-resolution and HQ preview export for large RAWs on slow machines in
  both preview modes. Fixed by leasing the worker to open sessions.

