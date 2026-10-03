# WebGPU replaces WebGL for the interactive preview

Date: 2026-10-03

## Decision

The interactive `/raw` preview has exactly one GPU executor: WebGPU (WGSL).
The WebGL2 renderer and every GLSL shader are deleted. When WebGPU is not
available, or the GPU preview fails at runtime, the preview falls back to the
existing CPU preview worker. There is no WebGL tier.

```
before: webgpu -> webgl2 -> cpu      (WGSL + GLSL + TS: three color executors)
after:  webgpu -> cpu                (WGSL + TS: two color executors)
```

## Why two executors remain, and why that is the right number

The color math runs in two places, on purpose:

| Executor | Language | Used by | Requirement |
|---|---|---|---|
| CPU row-band processor | TypeScript (`@lumaforge/luma-color-runtime`) | browser full-resolution export, `lmfg` CLI, CPU preview, histogram reference | authoritative, deterministic, runs in Node and workers without a GPU, bounded memory at 100 MP |
| GPU preview | WGSL | interactive preview, compare layers, HQ preview snapshot | 60 fps slider feedback |

The CLI never used WebGL. Both the browser export worker and `lmfg` call
`runFullResolutionJpegExport` in `@lumaforge/render-engine`, which runs the TS
row-band processor. Render manifests seal output hashes and `lmfg render replay`
re-verifies them byte for byte; GPU arithmetic is not bit-reproducible across
vendors and drivers, so the authoritative executor stays on the CPU. Moving
export to the GPU would therefore not remove the TS executor, it would add a
third. The WebGL tier was the only executor that existed purely for
compatibility, and it is the one this change deletes.

## Device coverage and the cost being accepted

As of 2026-10, WebGPU ships by default in Chrome/Edge desktop, Chrome Android
12+ on ARM/Qualcomm/Intel (Imagination on Android 16+), Safari 26 on macOS, iOS,
iPadOS and visionOS, and Firefox on Windows and macOS. It is still missing on
Chrome Android with Samsung Xclipse GPUs, Firefox on Linux and Android, Chrome
on Linux outside Intel Gen12+ and recent NVIDIA, and iOS releases before 26.
Those users move from a hardware WebGL preview to the CPU preview. The CPU
preview is the same executor as export, so its colors are the most faithful;
the cost is interaction latency, live dual-layer compare, and the histogram
(the CPU banner already says so). This trade was accepted explicitly on
2026-10-03 in favor of maintaining one GPU implementation.

## Module boundary

- `src/lib/webgpu/` is the only GPU preview module.
  - `raw-processing-pipeline.ts`: `RawProcessingPipeline`, the stable facade the
    app consumes. Construction is synchronous; `initialize()` resolves the
    backend, lazy-loads the WebGPU executor, and reports device loss to the
    backend store. It never constructs any other renderer.
  - `pipeline.ts`: `WebGPUProcessingPipeline`, the executor.
  - `contract.ts`: renderer-neutral types and helpers (`RawUploadInput`,
    `PipelineStats`, `ExportRenderStats`, `RenderOptions`,
    `PipelineTelemetrySnapshot`, `PreviewGpuCapabilities`, ...).
  - `lut-profile.ts`: LUT contract to shader-uniform resolution.
  - `export-plan.ts`: HQ preview snapshot planning (tiles, crop, errors).
- `src/lib/gl/` no longer exists.
- `src/lib/preview/gpu-backend.ts` resolves `PreviewBackend = 'webgpu' | 'cpu'`.
  CPU reasons are `webgpu-unavailable` (no API, adapter, device, or the probe
  timed out), `gpu-preview-failed` (initialization or device loss after
  selection), and `forced` (`?forcePreview=cpu` on dev/localhost builds).
  `?forcePreview=webgpu|webgl2` is removed: there is nothing to choose between.
- `@lumaforge/luma-color-runtime` drops the `./glsl` entry, `glsl.ts`, and
  `saturation-glsl.ts`. `mat3ToGLSL` becomes `mat3ToColumnMajor`. This is a
  breaking package change and bumps the package to `0.2.0`.
- Vocabulary follows the executor, not the API:
  - compare ladder `dual-webgl -> jpeg-fallback -> processed-only` becomes
    `dual-gpu -> jpeg-fallback -> processed-only`;
  - `OriginalWebglLayer` becomes `OriginalGpuLayer`;
  - GPU budget facts `webgl2` / `dualWebglAllowed` become `webgpu` /
    `dualGpuAllowed` in both the app and `render-engine` policy;
  - the `lmfg capabilities` browser-tier entry `webgl2-preview` becomes
    `webgpu-preview` (still reported as not shipped).

## Observable interface

- Users with WebGPU see no behavior change relative to the WebGL baseline:
  same controls, same compare ladder outcome, same histogram, same HQ preview
  snapshot, same export bytes.
- Users without WebGPU get the CPU preview with the existing banner. There is
  no new UI.
- `canvas[data-render-backend]` is `webgpu` whenever the GPU preview is active.

## Consistency contract and test strategy

1. **Migration evidence (one-time, before deletion).** The branch harness
   `scripts/webgpu/validate.mjs` compared WebGPU against WebGL on 300 synthetic
   scenarios (presets, tone, color balance, saturation, selective color, four
   LUT roles, 22 transfer curves, compare, snapshots). Result on 2026-10-03,
   Chromium 147 SwiftShader: 300/300 pass, visible max error 1/255, processed
   float max error 0.003.
2. **Standing parity (after deletion).** The harness reference becomes the
   authoritative TS executor: for each scenario, the WebGPU processed output is
   compared with `renderCpuPreviewFrame` driven by `resolveExportColorGraph`
   for the same params. This is the contract that matters to users, preview
   agrees with export, and it replaces "WGSL agrees with GLSL".
3. **Unit tests.** WebGPU unit tests stay; WebGL unit tests are deleted with
   their implementation; contract/planning tests move with their modules.
4. **Browser specs.** The primary Chromium project runs with software WebGPU;
   WebKit (no WebGPU in the Playwright build) covers the CPU fallback;
   `?forcePreview=cpu` stays covered.
5. **Before/after QA.** Every `/raw` feature is exercised on the WebGL baseline
   (`main` at c667ff65) and on this branch with a real RAW file: preview
   pixels per feature scenario must agree within the parity tolerance, and
   full-resolution export bytes must be identical. Results are recorded in
   `docs/audits/2026-10-03-webgpu-migration-qa.md`.

## Complexity budget

- Net code must shrink: the WebGL executor, its context helpers, and its GLSL
  are deleted (roughly 5k lines including tests).
- No new runtime dependencies. No WebGPU compute export path. No change to the
  CPU executor or the export pipeline.

## Out of scope

- GPU-accelerated export or CLI rendering.
- HDR canvas output (a separate WebGPU-only capability that this change makes
  possible later).
- Changes to the CPU preview performance profile.
