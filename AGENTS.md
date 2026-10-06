# AGENTS.md

Guidance for AI/code agents working in this repository. This file is the
current project map after multiple RAW workflow, UI, runtime, planning, and
verification refactors. Keep changes aligned with this app, not generic Vite or
image-editor assumptions.

## Non-Negotiables

- Use `pnpm` only.
- Do not read, write, or commit `.env` files, secrets, credentials, or private
  tokens.
- Do not edit generated files such as `src/generated-routes.ts`. Change routes
  by adding or renaming files under `src/pages/`.
- Use the `~/` alias for imports from `src`.
- Stay inside the shared app runtime patterns: do not recreate the QueryClient,
  Jotai store, router plumbing, or provider stack outside the existing
  providers.
- Do not use `window.location` or other ad hoc navigation paths when existing
  router utilities cover the case.
- For animation, use `m` from `motion/react` inside the existing `LazyMotion`
  setup in `src/providers/root-providers.tsx`. Prefer presets in
  `src/lib/spring.ts`.
- Do not describe or reintroduce the RAW runtime as `libraw-wasm`. The current
  runtime boundary is `@lumaforge/luma-raw-runtime`.
- Do not add catalogs, batch workflows, accounts, cloud upload requirements,
  local daemons, native helper apps, or broad desktop-editor panels unless the
  user explicitly asks for that product shift.
- Keep commits prompt, focused, and minimal. Do not add AI co-authorship
  metadata.

## Product Boundary

- LumaForge is a browser-local RAW photo lab for a narrow workflow:
  `single RAW file -> preview -> look or LUT -> compare -> JPEG export`.
- Preview may optimize for responsiveness through embedded, quick, bounded HQ,
  WebGPU, or CPU-degraded stages.
- Export is the authoritative full-resolution path. If the runtime cannot prove
  the declared pipeline can be reproduced, fail closed instead of exporting a
  degraded or preview-only result.
- HQ preview export is a fallback or compromise, not the primary promise.
- Color and LUT work is contract work. Preserve input gamut, transfer/log curve,
  LUT intent, scene-referred working assumptions, and output handling.
- The editing controls are a bounded set the export path reproduces: tone,
  temperature/tint and saturation/vibrance, eight HSL bands, and Transform.
  Transform is in scope as upright modes plus manual vertical/horizontal
  perspective, rotate, aspect, scale, and offset, with constrained crop (on by
  default). Lens correction is out of scope.

## Current Architecture

- `src/pages/(main)/raw.tsx` is the `/raw` route entry. Route files drive
  `src/generated-routes.ts`; never edit the generated file directly.
- `src/pages/(main)/index.sync.tsx` is the thin `/` route entry. The landing
  itself lives in `src/modules/landing`: `LandingPage`, section components,
  the `PhotoCompare` slider and its sweep hook,
  `src/modules/landing/content.ts` (typed key lists and the real
  supported-format count), module CSS, and colocated tests.
- `src/pages/(main)/transform-demo.tsx` still ships the noindex
  `/transform-demo` route on top of `src/modules/transform-demo`, which `/raw`
  Transform also depends on (see Retained And Scheduled Slices).
- `src/providers/root-providers.tsx` owns `LazyMotion`, React Query, Jotai,
  i18n, error boundary, router stability, settings sync, context menu, and
  toasts. Preserve provider order unless a concrete bug requires changing it.
- `src/modules/raw-processor/RawProcessorView.tsx` is a thin composition layer.
  Keep orchestration in hooks/controllers and domain logic in services.
- `src/modules/raw-processor/hooks/useRawProcessorViewController.ts` bridges
  route/runtime state, hidden file pickers, runtime readiness, reset
  confirmation, CPU preview state, and workflow actions for the view.
- `src/modules/raw-processor/hooks/useRawWorkflow.ts` and
  `src/modules/raw-processor/hooks/stages/` are the workflow state machine
  boundary. Stage hooks are grouped by `ingest`, `preview`, `look`, `compare`,
  and `export`. Transform is not a stage folder:
  `src/modules/raw-processor/hooks/useRawTransformFeature.ts` owns Transform
  tool state and the preview overlay, and
  `src/modules/raw-processor/hooks/useRawPreviewTransform.ts` commits the
  geometry that export reproduces.
- `src/modules/raw-processor/services/` contains scriptable domain behavior:
  `ingest`, `preview`, `look`, `compare`, and `export`. Prefer adding tested
  logic here before growing React components.
- `src/modules/raw-processor/model/` defines session/workflow/export result
  shapes. Keep model changes small and contract-like.
- `src/modules/raw-processor/state/` contains Jotai atoms for workflow and tool
  state. Prefer these over introducing a second state model.
- `src/modules/raw-processor/components/RawWorkflowToolProvider.tsx` is the
  context bridge from workflow state/actions to tool surfaces.
- `src/modules/raw-processor/components/RawToolSurface.tsx` switches desktop vs
  mobile surfaces by viewport. Respect that split.
- `src/modules/raw-processor/components/tools/` is the desktop command rail:
  Adjust (Tone, Color, and HSL sections), Transform, Compare, Export, File
  Facts, Histogram, the LUT contract tool under
  `src/modules/raw-processor/components/tools/lut/`, and shared tool chrome.
- `src/modules/raw-processor/components/mobile/` is the mobile photo-first
  shell: topbar with the Export action, a dock of tools (Look, Adjust,
  Transform) over a deck, the compare lens on the stage, the Look deck (LUT
  strip, Strength row, inline LUT contract), the LUT sources sheet, the export
  panel, Adjust list panels (Tone, Color, HSL), the Transform list panel, the
  More menu, and the scrub HUD.
  `src/modules/raw-processor/components/mobile/mobile-stage-layout.ts` fits the
  photo first and sizes the deck from what is left.
- `src/modules/raw-processor/raw-lab.css`,
  `src/modules/raw-processor/raw-lab.surface.css`, and
  `src/modules/raw-processor/raw-lab.effects.css` hold `/raw` surface and
  effect CSS that cannot reasonably live as Tailwind utilities.
- `src/lib/webgpu` is the only GPU preview executor (WGSL).
  `src/lib/webgpu/raw-processing-pipeline.ts` is the facade the app consumes;
  `src/lib/webgpu/contract.ts` holds renderer-neutral types. There is no WebGL
  tier: without WebGPU, or after a GPU failure, the preview falls back to the
  CPU preview worker (`webgpu -> cpu`). Do not reintroduce WebGL or GLSL.
- `src/lib/preview` holds the preview backend probe
  (`src/lib/preview/gpu-backend.ts`: WebGPU or CPU, and why) and the preview
  capability decision (`src/lib/preview/raw-preview-capability.ts`). The CPU
  preview worker is not here: it lives in
  `packages/render-engine/src/preview/worker-bridge`, and
  `src/modules/raw-processor/hooks/useCpuPreview.ts` drives it.
- `src/lib/export` adapts the engine's full-resolution export to the browser:
  the export worker shell (`src/lib/export/full-res-export.worker.ts`), its
  client, OPFS and blob output sinks, the checkpoint store, source
  fingerprints, the large-resource registry, and execution-plan selection
  (`src/lib/export/execution-profile.ts`). The export algorithm and its
  fail-closed gates live in `packages/render-engine/src/export`.
- `src/lib/workers` holds the idle-terminating worker bridges for RAW decode
  and export.
- `src/lib/raw` adapts the app to `@lumaforge/luma-raw-runtime`.
- `src/lib/runtime` detects browser facts: the capability vector, export
  storage (OPFS) resources, and preview GPU facts, plus the per-source preview
  GPU budget derived from them (`src/lib/runtime/preview-gpu-budget.ts`).
  Export and interactive policy decisions live in
  `packages/render-engine/src/policy`.
- `src/lib/lut` wraps the `@lumaforge/luma-color-runtime` `.cube` parser
  (including an off-main-thread parse worker) and persists LUT contract
  choices in the browser. `src/lib/profiles` parses and fetches online LUT
  catalogs and source URLs, maps catalog LUT contracts, and holds the dormant
  DCP calibration catalog.
- `packages/luma-color-runtime` is pure TypeScript color math: tone,
  temperature/tint color balance, LUT contracts, transfer/gamut transforms,
  graph resolution, row-band processing, and WGSL helpers
  (`@lumaforge/luma-color-runtime/wgsl`). The TS row-band processor is the
  authoritative executor for export, `lmfg`, and the CPU preview; the WGSL
  preview must agree with it (`pnpm test:webgpu`).
- `packages/render-engine` (`@lumaforge/render-engine`) is the headless engine
  shared by `/raw` and `lmfg`. It takes capability facts as input and never
  detects them. It owns:
  - `packages/render-engine/src/export`: the authoritative full-resolution
    JPEG export (`runFullResolutionJpegExport` and its fail-closed gates),
    strip scheduling, JPEG row writers, sinks and metadata, and export
    geometry.
  - `packages/render-engine/src/preview`: the CPU preview renderer, the
    quick/bounded-HQ preview plan, candidates and contact sheets, and the CPU
    preview worker bridge and protocol.
  - `packages/render-engine/src/policy`: export and interactive policy
    decisions and resource budgets.
  - `packages/render-engine/src/manifest`: `RenderManifest` types,
    canonical-JSON `manifest_sha256`, source and LUT identity, and the color
    graph descriptor.
- `packages/luma-raw-runtime` is the browser RAW metadata/decode/runtime
  boundary, including worker protocol, native artifacts, processed-window facts,
  HDR analysis, fixtures, benchmarks, and native verification.
- `packages/luma-jpeg-runtime` is the bounded row-oriented JPEG encoder runtime.
- `packages/luma-native-artifacts` packages prebuilt WASM/worker assets for RAW
  and JPEG runtimes.
- `packages/lmfg-cli` is the `lmfg` agent-facing CLI (cpu-wasm tier). It
  composes `@lumaforge/render-engine` and the Node entries of the RAW/JPEG
  runtimes; `packages/lmfg-cli/src/services/` holds the domain logic (LUT
  contracts, color graph descriptors, preview, iterations, fail-closed export,
  manifests), `packages/lmfg-cli/src/commands/` are thin protocol adapters, and
  `packages/lmfg-cli/src/protocol/` owns the JSON/NDJSON envelope and spec exit
  codes. The browser bridge tier is not shipped; keep `capabilities` honest
  about it. The CLI params have no geometry, so it cannot apply Transform.
- `packages/lmfg-mcp` is the `lmfg-mcp` stdio MCP server. The tools declared in
  `packages/lmfg-mcp/src/tools.ts` map one-to-one to `lmfg` commands: each runs
  the CLI in-process and returns its envelope unchanged. Two tools are
  MCP-native, with their own result schemas and error codes and no CLI
  command: `lmfg_image_read` (`packages/lmfg-mcp/src/image.ts`: view a session
  preview, candidate, or contact sheet) and `lmfg_export_detail`
  (`packages/lmfg-mcp/src/export-detail-tool.ts`: a verified 1:1 PNG region of
  a full-resolution `lmfg` export). `pnpm cli:build` builds it and
  `pnpm test:cli` runs its tests.

## Canonical Owners

Put code where its contract already lives and import it from there instead of
mirroring it. Packages never import from `src/`; the app imports shared types
from the packages.

- Color intent, tone/color/HSL math, LUT parsing and contract resolution, the
  export color graph, and the row-band executor: `packages/luma-color-runtime`.
- Full-resolution export, export geometry planning and resampling, CPU preview
  rendering and the preview plan, policy and resource budgets, and render
  manifests: `packages/render-engine`.
- RAW decode, metadata, processed windows, and the RAW worker protocol:
  `packages/luma-raw-runtime`.
- Browser fact detection: `src/lib/runtime` and `src/lib/preview`. Browser
  storage, transport, and worker shells: `src/lib/export` and `src/lib/workers`.
- Agent protocol (commands, envelopes, exit codes, workspace layout):
  `packages/lmfg-cli`; `packages/lmfg-mcp` adapts it.

Known duplication. These copies exist today. Do not extend them; remove one
only by finishing the move it belongs to:

- `packages/render-engine/src/policy/capability-input.ts`,
  `packages/render-engine/src/policy/export-runtime-resources.ts`, and
  `packages/render-engine/src/policy/preview-gpu-budget.ts` mirror the type
  shapes declared again in `src/lib/runtime`.
- The quick and bounded-HQ preview pixel caps are defined in both
  `packages/render-engine/src/preview/preview-plan.ts` and
  `src/lib/raw/decoder.ts`.
- `src/lib/export/output-sink.ts` redefines the output-result types of
  `packages/render-engine/src/export/jpeg/output-result.ts` and has diverged
  from them (delivered hash and metadata fields).
- `src/lib/export/checkpoint-store.ts` owns the checkpoint manifest the app
  uses; `packages/render-engine/src/manifest/export-checkpoint.ts` exports an
  unused type with the same name. `LumaRenderContext`
  (`packages/render-engine/src/context/runtime-context.ts`) is exported, but no
  engine function, app code, or CLI code consumes it.
- `src/lib/lut/profile-resolution.ts` keeps an app fork of the LUT profile
  resolver next to `packages/luma-color-runtime/src/lut-profile-resolution.ts`.
- `packages/render-engine/src/export/geometry/matrix.ts` mirrors
  `src/modules/transform-demo/geometry/matrix.ts`.
  `src/lib/export/full-res-export-geometry-bounds.test.ts` runs app-composed
  Transform matrices through the engine's geometry planner.
- The app (`src/modules/raw-processor/services/export/export-manifest.ts`) and
  the CLI (`packages/lmfg-cli/src/services/manifest.ts`) each project their own
  parameters into `RenderManifest`. Intent keys, defaults, and the manifest
  projection are not yet one shared definition.
- `lmfg_image_read` and `lmfg_export_detail` read the CLI workspace layout by
  convention instead of through `packages/lmfg-cli/src/workspace/paths.ts`.

Close the extraction:

- When you move code to its canonical owner, finish the move in the same
  change: switch every consumer to the owner's export and delete the old copy.
  Do not leave type-only mirrors, "keep these in step" comments, or app-side
  forwarding shims behind.
- The one exception is the exported API of the published packages
  (`@lumaforge/render-engine`, `@lumaforge/luma-raw-runtime`,
  `@lumaforge/luma-color-runtime`, `@lumaforge/luma-jpeg-runtime`). Never
  remove or rename an exported symbol: mark it `@deprecated`, keep it compiling
  (a forwarding export is fine), move internal consumers off it, and record the
  deprecation in that package's CHANGELOG.

## Retained And Scheduled Slices

These are owner decisions. They override cleanup advice that says otherwise.

- Transform: `/raw` Transform is built on `src/modules/transform-demo`.
  `src/modules/raw-processor/hooks/useRawTransformFeature.ts` wraps
  `src/modules/transform-demo/useTransformDemo.ts`, the preview overlay renders
  through its `TransformCanvas` and worker, and the Transform types and upright
  geometry come from that module. Treat it as production code. Its useful
  code, tests, and fixtures move to a production home later; only then are the
  `/transform-demo` route and the demo module deleted.
- DCP calibration: the app slice (stage hook, service, and atoms) is
  removed, and the workflow applies no camera calibration. The remaining
  `src/lib/profiles/calibration-catalog.ts` and
  `src/lib/profiles/dcp-params.ts` are scheduled for deletion; do not extend
  them. The runtime side stays:
  `applyCalibration` in `@lumaforge/luma-raw-runtime`, `solveDcpInterpolation`
  in `@lumaforge/luma-color-runtime`, the manifest's null `calibration` slot,
  and the exported HDR analysis (`analyzeRawDynamicRange`).
- Built-in style presets are retained: keep `styleKind: 'builtin'`,
  `builtinPreset`, their WGSL branches and uniforms in `src/lib/webgpu`, and
  their goldens in `scripts/webgpu/goldens.json`. No UI entry point selects a
  preset today, and full-resolution export refuses one:
  `resolveExportColorGraph` in `packages/luma-color-runtime/src/color-graph.ts`
  returns `unsupported-pipeline` for `styleKind: 'builtin'`. Do not delete the
  plumbing and do not restore a preset picker without a request. Product docs
  that still describe choosing built-in finishes are intentionally left as
  they are.
- Online LUT catalog: `src/modules/raw-processor/hooks/useOnlineLutSources.ts`
  resolves the default and saved catalog sources as soon as it mounts, so every
  `/raw` visit fetches them. Lazy activation (fetch on first catalog use) is
  approved for later; `?luts=` deep links and Share stay.
- Export crash recovery is scheduled to shrink to an interruption marker and a
  safer retry plan. Do not add source reselection or automatic re-export.

## UI And Design Boundaries

- `/raw` is a fixed cool-slate darkroom defined by `--color-lf-*` tokens in
  `src/styles/tailwind.css` `@theme`. It ignores `data-theme`.
- The landing page uses a cool-slate palette under `.lf-landing` in
  `src/modules/landing/landing.css` that is derived from the darkroom
  aesthetic.
  Landing-specific `--lf-*` tokens (surface, text, accent) are intentionally
  aligned with the app's `--color-lf-*` hue family (hue 255, low chroma) so
  the two surfaces feel like the same product.
- Read `DESIGN.md` "Theme contract" before touching tokens or theme code.
- Before adding or restyling UI, read
  `docs/specs/2026-06-30-anti-ai-slop-guardrails.md`: the standing anti-AI-slop
  checklist (register-aware reflex bans plus the preview-vs-export
  functional-slop rule).
- Follow existing UI boundaries:
  - primitives in `src/components/ui`
  - shared app components in `src/components/common`
  - domain behavior in `src/modules/<domain>`
- For UI work, start from stable primitives and the existing styling system:
  - prefer Radix-backed primitives or existing app components for interactive
    controls and overlays.
  - use Tailwind utilities, `--color-lf-*` tokens, and small component
    refinements to finish visual polish.
  - do not start by hand-rolling raw HTML or standalone vanilla CSS when an
    existing primitive, component, Tailwind utility, or theme token can cover
    the need.
- Desktop and mobile `/raw` surfaces are separate UX boundaries. If the user
  splits desktop and mobile follow-ups, preserve that boundary.
- Mobile `/raw` should stay preview-first with persistent topbar and bottom
  toolbar. Do not import desktop paper/sheet language into mobile just to signal
  "correspondence"; express parity through structure, copy, or motion.
- Shared copy with the same meaning across surfaces should use a shared i18n
  key instead of manually syncing duplicate strings.
- Use lucide icons when available. Keep touch targets explicit and stable on
  mobile.

## RAW Workflow Guardrails

- Keep preview and export responsibilities distinct. Interactive preview and
  authoritative export may share color intent, but they are not interchangeable
  executors.
- The current compare fallback ladder is
  `dual-gpu -> jpeg-fallback -> processed-only`. Do not revive old
  `dual-webgl`, `shader`, or `css-snapshot` vocabulary.
- `embedded-fallback` in
  `src/modules/raw-processor/services/compare/compare-render-mode.ts` shows the
  camera's embedded JPEG as a provisional reference while neither a dual-GPU
  original nor a JPEG snapshot is ready. It is a camera-rendered stand-in, not
  another technical-original rung of the ladder; do not present it as one.
- Compare split state is frame-anchored. Photo clipping and zoom/pan are derived
  from the committed frame split; avoid mixing photo-space and frame-space state.
- Original reference snapshots are capped and lifecycle-managed. Treat object
  URL release as part of the compare contract.
- The Adjust workflow is shared color-pipeline behavior, not a local UI-only
  tweak. Tone, color, and HSL params flow through preview, histogram, export,
  CPU preview, and mobile focus/list UI.
- Desktop Adjust lives in
  `src/modules/raw-processor/components/tools/AdjustTool.tsx` (`ToneTool`,
  `ColorTool`, `HSLTool`); mobile Adjust uses `AdjustListPanel`,
  `ToneListPanel`, `ColorListPanel`, `HSLListPanel`, `AdjustSliderRow`, and
  `ScrubValueHud`. Transform is `TransformTool` on desktop and
  `TransformListPanel` on mobile.
- The stable color insertion point for user tone and color balance is after
  raw-render exposure and before LUT input conversion.
- Transform geometry is not a color step. Export resamples the committed
  geometry at full resolution before the color graph and paints the matte in
  output space afterwards. The preview must show the same framing, and a
  geometry the engine cannot plan fails export closed.
- CPU preview/degraded mode must have a usable startup/empty-state path.
  Production validation should include `/raw?forcePreview=cpu` when touching
  degraded-preview behavior.

## Docs

- Do not commit spec, plan, audit, or execution-plan documents. Code, tests,
  commit messages, this file, `DESIGN.md`, and `PRODUCT.md` are the durable
  record. If a workflow or agent skill wants to write one (for example under
  `docs/superpowers/`), keep it out of the repository unless the user asks.
- `docs/` holds user guides plus living references
  (`docs/PERFORMANCE_RESOURCE_MANAGEMENT.md`, the anti-AI-slop guardrails).
  Update them when the behavior they describe changes.
- Write every repository path in this file in full from the repository root.
  `pnpm check:agent-paths` fails on a backticked path that does not resolve;
  CI runs it on every change, docs-only ones included.
- Code comments state the rule in place; do not point them at design
  documents or spec section numbers.
- Keep docs self-contained when the user asks for calculation or architecture
  explanations. Links are provenance, not required reading.

## Git Worktree Policy

- Default to direct work on local `main` for small coherent changes.
- If new work needs isolation, prefer repo-local worktrees under
  `.worktrees/<branch-name>` using `pnpm worktree <branch>`.
- Do not default to external worktree paths for this repo.
- When the user asks to deliver to `main` with linear history, rebase and use
  `git merge --ff-only`; avoid merge commits.
- Never revert unrelated user changes. If the worktree is dirty, inspect enough
  to avoid clobbering it.

## Verification

- Definition of Done requires fresh evidence. Report the exact commands and
  outcomes.
- Use progressive verification so UI iteration does not pay native/runtime build
  costs on every batch:
  - UI-only `/raw` or shared component edits: start with `pnpm test:ui` and a
    focused lint command, or `pnpm lint` when autofix is intended.
  - App-surface changes under `src`, `scripts`, or non-native package adapters:
    run `pnpm lint:check`, `pnpm test:app`, `pnpm native:prepare`, and
    `LUMAFORGE_NATIVE_RUNTIME_MODE=prebuilt pnpm build`.
  - Runtime contract changes under `packages/luma-*-runtime`,
    `packages/render-engine`, `src/lib/export`, `src/lib/raw`,
    `src/lib/runtime`, or `src/lib/workers`: run `pnpm test:runtime` plus
    touched package `typecheck`, `test`, and `build` commands.
    `pnpm test:runtime` does not run the render-engine tests; for engine
    changes run `pnpm cli:build:deps` (the engine tests resolve the built
    runtime packages), then `pnpm --filter @lumaforge/render-engine test`.
  - Native/runtime artifact changes under
    `packages/luma-raw-runtime/native/`, `packages/luma-jpeg-runtime/native/`,
    or `packages/luma-native-artifacts`: run relevant `build:native`,
    `native:verify`, and native smoke commands.
  - CLI or MCP changes under `packages/lmfg-cli` or `packages/lmfg-mcp`: run
    `pnpm cli:build` once, then the touched package's typecheck
    (`pnpm --filter @lumaforge/lmfg-cli typecheck`,
    `pnpm --filter @lumaforge/lmfg-mcp typecheck`) and
    `LMFG_REQUIRE_FIXTURE=1 pnpm test:cli`, which runs both packages' suites.
    The e2e suites need the public DNG fixture
    (`pnpm --filter @lumaforge/luma-raw-runtime fixtures:fetch-public`);
    without `LMFG_REQUIRE_FIXTURE=1` the fixture-gated specs skip instead of
    failing, which is only acceptable for local UI-only iteration.
  - Manifest contract changes under `packages/render-engine/src/manifest`
    affect both the CLI and the browser export manifest: run the render-engine
    tests, `pnpm test:cli`, and `src/modules/raw-processor/services/export`
    app tests together.
- Default closeout verification for broad app changes remains:
  - `pnpm lint`
  - `pnpm test:run`
  - `pnpm build`
- `pnpm test:run` is the full Vitest sweep. Do not make it the first command
  after every UI batch when `pnpm test:ui` or `pnpm test:app` gives the faster
  signal needed for the current scope.
- User-visible `/raw` behavior changes should include browser validation when
  the change affects interaction, rendering, export handoff, or mobile/WebKit
  behavior.
- Browser specs live under `tests/browser`. Use `pnpm test:browser` or a focused
  `pnpm exec playwright test <spec>` run as appropriate.
- Changes to WGSL, `src/lib/webgpu`, or the color graph must keep
  `pnpm test:webgpu` green: it holds the WebGPU preview to the TS export
  executor on synthetic scenes (Chromium SwiftShader). The `chromium-desktop`
  Playwright project runs software WebGPU; the WebKit project has no WebGPU and
  exercises the CPU preview.
- Built-app preview validation can use `pnpm serve` or
  `pnpm exec vite preview` after `pnpm build`.
- CI follows the same split (jobs in `.github/workflows/build.yml`, aggregated
  by its `build` job; every job except `quality` is path-selected):
  - `quality` runs on every change, docs-only ones included. It tests and runs
    `scripts/quality/check-agent-paths.mjs` against this file, then installs
    dependencies and runs `pnpm check:structure`
    (`scripts/quality/check-structure.mjs`): knip and madge fail any unused
    file, export, dependency, unresolved import, or import cycle that
    `scripts/quality/baseline.json` does not list. Code that resolves a
    baseline entry drops it in the same commit (`pnpm check:structure --prune`);
    the baseline never gains an entry without review.
  - `app` uses `pnpm lint:check`, `pnpm test:app`, prebuilt native assets, and
    app build checks.
  - `runtime` runs runtime package typecheck/test/build and app adapter tests,
    then typechecks, tests, and builds `packages/render-engine`.
  - `webgpu` installs Chromium and runs `pnpm test:webgpu` (WebGPU preview vs
    the TS export executor and frozen WebGL output) for `src/lib/webgpu`, the
    color runtime, render-engine preview, and `scripts/webgpu` changes.
  - `native` installs Emscripten and runs native build/verify/smoke only for
    native source paths (`packages/luma-*-runtime/native/`,
    `scripts/native-runtime/`); prebuilt artifact version bumps under
    `packages/luma-native-artifacts/` run through the `cli` job instead.
  - `cli` tests the native artifact package, builds the runtimes and render
    engine, typechecks and builds `lmfg-cli` and `lmfg-mcp`, runs both suites
    with the public fixture and `LMFG_REQUIRE_FIXTURE=1`, and dry-run packs
    render-engine, `lmfg-cli`, and `lmfg-mcp`.

## When Unsure

- Follow the current code over old agent habits.
- Follow README and DESIGN.md over generic frontend assumptions.
- Search the repo before relying on memory for names, paths, or runtime
  boundaries.
- Keep the product narrow, the color pipeline explicit, and the export path
  trustworthy.
