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
  `src/lib/spring`.
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
  WebGL, or CPU-degraded stages.
- Export is the authoritative full-resolution path. If the runtime cannot prove
  the declared pipeline can be reproduced, fail closed instead of exporting a
  degraded or preview-only result.
- HQ preview export is a fallback or compromise, not the primary promise.
- Color and LUT work is contract work. Preserve input gamut, transfer/log curve,
  LUT intent, scene-referred working assumptions, and output handling.

## Current Architecture

- `src/pages/(main)/raw.tsx` is the `/raw` route entry. Route files drive
  `src/generated-routes.ts`; never edit the generated file directly.
- `src/providers/root-providers.tsx` owns `LazyMotion`, React Query, Jotai,
  i18n, error boundary, router stability, settings sync, context menu, and
  toasts. Preserve provider order unless a concrete bug requires changing it.
- `src/modules/raw-processor/RawProcessorView.tsx` is a thin composition layer.
  Keep orchestration in hooks/controllers and domain logic in services.
- `src/modules/raw-processor/hooks/useRawProcessorViewController.ts` bridges
  route/runtime state, hidden file pickers, runtime readiness, reset
  confirmation, CPU preview state, and workflow actions for the view.
- `src/modules/raw-processor/hooks/useRawWorkflow.ts` and
  `hooks/stages/*` are the workflow state machine boundary. Stage hooks are
  grouped by `ingest`, `preview`, `look`, `compare`, and `export`.
- `src/modules/raw-processor/services/*` contains scriptable domain behavior:
  `ingest`, `preview`, `look`, `compare`, and `export`. Prefer adding tested
  logic here before growing React components.
- `src/modules/raw-processor/model/*` defines session/workflow/export result
  shapes. Keep model changes small and contract-like.
- `src/modules/raw-processor/state/*` contains Jotai atoms for workflow and tool
  state. Prefer these over introducing a second state model.
- `src/modules/raw-processor/components/RawWorkflowToolProvider.tsx` is the
  context bridge from workflow state/actions to tool surfaces.
- `src/modules/raw-processor/components/RawToolSurface.tsx` switches desktop vs
  mobile surfaces by viewport. Respect that split.
- `src/modules/raw-processor/components/tools/*` is the desktop command rail:
  Adjust, Tone, Color, Compare, Export, File Facts, Histogram, LUT contract, and
  shared tool chrome.
- `src/modules/raw-processor/components/mobile/*` is the mobile photo-first
  shell: persistent topbar, bottom mode dock, mobile LUT browser, mobile export,
  compare panel, Adjust list panels, and scrub HUD.
- `src/modules/raw-processor/raw-lab.css`,
  `raw-lab.surface.css`, and `raw-lab.effects.css` hold `/raw` surface and
  effect CSS that cannot reasonably live as Tailwind utilities.
- `src/lib/gl` is the WebGL2 interactive preview renderer.
- `src/lib/preview` is the CPU/degraded preview worker path and capability
  helpers.
- `src/lib/export` is the worker-driven full-resolution export path.
- `src/lib/raw` adapts the app to `@lumaforge/luma-raw-runtime`.
- `src/lib/runtime` owns capability and export policy decisions.
- `src/lib/lut` and `src/lib/profiles` parse LUTs and resolve profile/catalog
  contracts.
- `packages/luma-color-runtime` is pure TypeScript color math: tone,
  temperature/tint color balance, LUT contracts, transfer/gamut transforms,
  graph resolution, row-band processing, and GLSL helpers.
- `packages/luma-raw-runtime` is the browser RAW metadata/decode/runtime
  boundary, including worker protocol, native artifacts, processed-window facts,
  HDR analysis, fixtures, benchmarks, and native verification.
- `packages/luma-jpeg-runtime` is the bounded row-oriented JPEG encoder runtime.
- `packages/luma-native-artifacts` packages prebuilt WASM/worker assets for RAW
  and JPEG runtimes.
- `packages/lmfg-cli` is the `lmfg` agent-facing CLI (cpu-wasm tier). It
  composes `@lumaforge/render-engine` and the Node entries of the RAW/JPEG
  runtimes; `src/services/*` holds the domain logic (LUT contracts, color graph
  descriptors, preview, iterations, fail-closed export, manifests),
  `src/commands/*` are thin protocol adapters, and `src/protocol/*` owns the
  JSON/NDJSON envelope and spec exit codes. The browser bridge tier is not
  shipped; keep `capabilities` honest about it.

## UI And Design Boundaries

- `/raw` is a fixed cool-slate darkroom defined by `--color-lf-*` tokens in
  `src/styles/tailwind.css` `@theme`. It ignores `data-theme`.
- The landing page uses a cool-slate palette under `.lf-landing` in
  `src/pages/(main)/index.css` that is derived from the darkroom aesthetic.
  Landing-specific `--lf-*` tokens (surface, text, accent) are intentionally
  aligned with the app's `--color-lf-*` hue family (hue 255, low chroma) so
  the two surfaces feel like the same product.
- Read `DESIGN.md` "Theme contract" before touching tokens or theme code.
- Before adding or restyling UI, read
  `docs/specs/2026-06-30-anti-ai-slop-guardrails.md`: the standing anti-AI-slop
  checklist (register-aware reflex bans plus the preview-vs-export
  functional-slop rule), derived from the audit in
  `docs/audits/2026-06-30-ai-slop-audit.md`.
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
  `dual-webgl -> jpeg-fallback -> processed-only`. Do not revive old
  `shader`/`css-snapshot` vocabulary.
- Compare split state is frame-anchored. Photo clipping and zoom/pan are derived
  from the committed frame split; avoid mixing photo-space and frame-space state.
- Original reference snapshots are capped and lifecycle-managed. Treat object
  URL release as part of the compare contract.
- The Adjust workflow is shared color-pipeline behavior, not a local UI-only
  tweak. Tone/color params flow through preview, histogram, export, CPU preview,
  and mobile focus/list UI.
- Desktop Adjust lives in `components/tools/AdjustTool.tsx`; mobile Adjust uses
  `AdjustListPanel`, `ToneListPanel`, `ColorListPanel`, `AdjustSliderRow`, and
  `ScrubValueHud`.
- The stable color insertion point for user tone and color balance is after
  raw-render exposure and before LUT input conversion.
- CPU preview/degraded mode must have a usable startup/empty-state path.
  Production validation should include `/raw?forcePreview=cpu` when touching
  degraded-preview behavior.

## Spec And Planning Artifacts

- Spec-driven development artifacts live directly under `docs/`, not under
  `docs/superpowers/` or plugin-owned directories.
- Use `docs/specs/` for design/spec documents, `docs/plans/` for
  implementation plans, and `docs/audits/` for audit/review artifacts when a
  written artifact is required.
- If an external workflow or agent skill defaults to `docs/superpowers/...`,
  override that path to the matching `docs/...` directory before writing or
  committing the artifact.
- For non-trivial feature work, establish the module boundary, observable
  interface, test strategy, and complexity budget before coding.
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
  - Runtime contract changes under `packages/luma-*-runtime`, `src/lib/export`,
    `src/lib/raw`, `src/lib/runtime`, or `src/lib/workers`: run
    `pnpm test:runtime` plus touched package `typecheck` and `build` commands.
  - Native/runtime artifact changes under package `native/` folders or
    `packages/luma-native-artifacts`: run relevant `build:native`,
    `native:verify`, and native smoke commands.
  - CLI changes under `packages/lmfg-cli`: run `pnpm cli:build` once, then
    `pnpm --filter @lumaforge/lmfg-cli typecheck` and
    `LMFG_REQUIRE_FIXTURE=1 pnpm test:cli`. The e2e suite needs the public DNG
    fixture (`pnpm --filter @lumaforge/luma-raw-runtime fixtures:fetch-public`);
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
- Built-app preview validation can use `pnpm serve` or
  `pnpm exec vite preview` after `pnpm build`.
- CI follows the same split:
  - `app` uses `pnpm lint:check`, `pnpm test:app`, prebuilt native assets, and
    app build checks.
  - `runtime` runs runtime package typecheck/test/build and app adapter tests.
  - `native` installs Emscripten and runs native build/verify/smoke only for
    native artifact paths.

## When Unsure

- Follow the current code over old agent habits.
- Follow README and DESIGN.md over generic frontend assumptions.
- Search the repo before relying on memory for names, paths, or runtime
  boundaries.
- Keep the product narrow, the color pipeline explicit, and the export path
  trustworthy.
