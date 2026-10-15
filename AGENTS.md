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
- Stay inside the shared app runtime patterns: do not recreate the Jotai
  store, router plumbing, or provider stack outside the existing
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
- `src/providers/root-providers.tsx` owns `LazyMotion`, Jotai, i18n, error
  boundary, viewport width, settings sync, and toasts. Preserve provider order
  unless a concrete bug requires changing it.
- `src/modules/raw-processor/RawProcessorView.tsx` is a thin composition layer.
  Keep orchestration in hooks/controllers and domain logic in services.
- `src/modules/raw-processor/hooks/useRawProcessorViewController.ts` bridges
  route/runtime state, hidden file pickers, runtime readiness, reset
  confirmation, CPU preview state, and workflow actions for the view.
- `src/modules/raw-processor/hooks/useRawWorkflow.ts` and
  `src/modules/raw-processor/hooks/stages/` are the workflow state machine
  boundary. Stage hooks are grouped by `ingest`, `preview`, `look`, `compare`,
  and `export`. Transform is not a stage folder: the session owns its intent
  and accepted answers through the pure transitions in
  `src/modules/raw-processor/services/transform/transform-state.ts`;
  `src/modules/raw-processor/hooks/useRawPreviewTransform.ts` applies them
  and moves the geometry that export reproduces only with them, and
  `src/modules/raw-processor/hooks/useRawTransformFeature.ts` keeps the
  preview frame, the worker, and the overlay.
- The `/raw` mount owns the session it publishes.
  `src/modules/raw-processor/hooks/stages/ingest/useRawProcessorLifecycle.ts`
  ends that session on a real route departure, while a StrictMode effect
  replay keeps it, and the workflow's RAW runtime host goes with the mount.
  `src/modules/raw-processor/services/workflow/raw-workflow-resources.ts`
  releases what a source holds on reset, replacement, and unmount by calling
  each resource's own owner; there is no single lifecycle controller.
  `docs/PERFORMANCE_RESOURCE_MANAGEMENT.md` ("Source Session Lifetime") holds
  the order and keeps released preview pixels, route departure, the source's
  exposure pin, and export result currency apart.
- `src/modules/raw-processor/services/` contains scriptable domain behavior:
  `ingest`, `preview`, `look`, `compare`, `export`, `transform` (the pure
  Transform session transitions), `workflow` (source teardown), and `surface`
  (which actions a tool surface may run, and why not). Prefer adding tested
  logic here before growing React components.
- `src/modules/raw-processor/model/` defines session/workflow/export result
  shapes. Keep model changes small and contract-like.
- `src/modules/raw-processor/state/` contains Jotai atoms for workflow and tool
  state. Prefer these over introducing a second state model.
  `src/modules/raw-processor/state/session.atoms.ts` holds the current image
  session on the production store the root providers mount;
  `src/modules/raw-processor/state/workflow.atoms.ts` stores the color intent
  and the LUT, holds no view state, and exports `rawWorkflowStore`, the store
  accessors the workflow's commands and services read and write through;
  `src/modules/raw-processor/state/preview-view.atoms.ts` holds only the view
  of the sample shown before a source loads. Load, restore, export, and
  delivery read the session, the color intent, and the LUT from the store
  when they run, not from the last render, and fence on that read before
  they write. The effective intent the photo renders and exports with is the
  stored intent with the session's look projected over it
  (`src/modules/raw-processor/services/look/effective-color-intent.ts`).
- `src/modules/raw-processor/components/RawWorkflowToolProvider.tsx` is the
  bridge from workflow state/actions to tool surfaces. Surfaces read the
  adjustments, the workflow stage, and its progress as store slices from
  `src/modules/raw-processor/hooks/useRawToolState.ts`, the commands from
  `useRawToolCommands`, and availability, export decisions, and file facts
  from the context in
  `src/modules/raw-processor/components/RawWorkflowContext.tsx`, where the
  preview histogram and the preview stats, which move with every render,
  have providers of their own. A value is read where it is shown, so a
  scrub step or a new render timing renders the control that names it, not
  the surface around it. Commands keep their identity and decide when they
  are called; a surface reads availability to disable a control, never to
  choose which command to hold.
- `src/modules/raw-processor/components/RawToolSurface.tsx` switches desktop vs
  mobile surfaces by viewport. Respect that split.
- `src/modules/raw-processor/components/tools/` is the desktop command rail:
  Adjust (Tone, Color, and HSL sections), Transform, Compare, Export, File
  Facts, the LUT contract tool under
  `src/modules/raw-processor/components/tools/lut/`, and the rail's tool
  chrome.
- `src/modules/raw-processor/components/shared/` holds what both surfaces
  render: the histogram, slider ticks and tracks, the segmented control paint
  (`src/modules/raw-processor/components/shared/segmented-chrome.ts`), and
  the LUT option buttons, issue copy, and source warnings under
  `src/modules/raw-processor/components/shared/lut/`. The desktop rail and the
  mobile shell never import each other (`plugins/eslint-import-boundaries.mjs`
  refuses it); they share through services, hooks, or this folder.
- `src/modules/raw-processor/components/mobile/` is the mobile photo-first
  shell: a topbar with the Export action and a More menu of real actions, a
  dock of tools over a deck, and the compare lens on the photo. `DESIGN.md`
  "Mobile Shell: Tools, Lens, Action" is its spec. The histogram runs only
  while More turns it on, and never in the CPU preview or over an applied
  Transform;
  `src/modules/raw-processor/components/mobile/mobile-stage-layout.ts` fits
  the photo first and sizes the deck from what is left.
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
  (`src/lib/preview/gpu-backend.ts`: WebGPU or CPU, and why), the preview
  capability decision (`src/lib/preview/raw-preview-capability.ts`), the
  renderer-neutral view contract (`src/lib/preview/preview-view.ts`), and the
  decoded frame descriptor (`src/lib/preview/preview-frame.ts`, see Canonical
  Owners). The CPU preview worker is not here: it lives in
  `packages/render-engine/src/preview/worker-bridge`, and
  `src/modules/raw-processor/hooks/useCpuPreview.ts` drives it.
- `src/modules/raw-processor/hooks/preview/` holds the WebGPU preview stage's
  mechanics.
  `src/modules/raw-processor/hooks/preview/usePreviewPipelineLifecycle.ts` is
  the one owner of each preview GPU pipeline (the processed one in
  `src/modules/raw-processor/components/PreviewCanvas.tsx`, the original one
  in `src/modules/raw-processor/components/OriginalGpuLayer.tsx`): it
  publishes a pipeline only once it has initialized and releases it on
  unmount or suspension; export evacuation calls that owner's release
  through
  `src/modules/raw-processor/hooks/stages/preview/usePreviewPipelineEvacuation.ts`.
  `src/modules/raw-processor/hooks/preview/useProcessedPreview.ts` renders the
  processed preview and owns its readiness, not the pipeline's lifetime;
  `src/modules/raw-processor/hooks/preview/usePreviewViewportGestures.ts` owns
  zoom and pan only, never the split; and
  `src/modules/raw-processor/hooks/preview/backing-store-resize.ts` settles
  GPU backing stores after layout resizes.
  `src/modules/raw-processor/components/PreviewStageFrame.tsx` is the stage
  markup and decides nothing.
- `src/lib/export` adapts the engine's full-resolution export to the browser:
  the export worker shell (`src/lib/export/full-res-export.worker.ts`), its
  client, OPFS and blob output sinks and the cross-tab OPFS output lifetime
  (`src/lib/export/opfs-output-lifetime.ts`), the large-resource registry,
  browser plan selection (`src/lib/export/export-plan.ts`), and export debug
  events and mode copy (`src/lib/export/execution-profile.ts`). It holds no
  checkpoint store or export journal. The export algorithm and its
  fail-closed gates live in `packages/render-engine/src/export`.
- `src/lib/workers` holds the idle-terminating worker bridges for RAW decode
  and export; each bridge reports generation-scoped lifecycle snapshots.
- `src/lib/raw` adapts the app to `@lumaforge/luma-raw-runtime`.
  `src/lib/raw/raw-runtime-host.ts` is the workflow's one RAW runtime host,
  created in `src/modules/raw-processor/hooks/useRawWorkflowRefs.ts`. It owns
  the decode bridge, the prewarm history that runtime readiness subscribes
  to, and at most one source session lease at a time. Ingest, preview restore
  after export, and export evacuation go through it; cancelling or
  superseding a lease ends the runtime generation its native work runs on, so
  that work cannot run ahead of the next load.
- `src/lib/runtime` detects browser facts: the capability vector, export
  storage (OPFS) resources, and preview GPU facts, plus the per-source preview
  GPU budget derived from them (`src/lib/runtime/preview-gpu-budget.ts`).
  Export and interactive policy decisions live in
  `packages/render-engine/src/policy`.
- `src/lib/lut` runs the `@lumaforge/luma-color-runtime` `.cube` parser off
  the main thread (`src/lib/lut/cube-parse-async.ts`) and persists LUT
  contract choices in the browser (`src/lib/lut/profile-resolution.ts` is a
  storage adapter over the package resolver, not a second resolver).
  `src/lib/profiles` parses and fetches online LUT catalogs and source URLs
  (catalog entries and source URLs pass one shared transport URL check). A
  catalog entry's LUT contract is mapped by `mapProfileLUTContract` in
  `packages/luma-color-runtime/src/lut-contract.ts`, which the catalog parser
  imports.
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
    geometry. `assessProcessedExport` decides whether a probed source can
    feed the processed-window export (the app, `lmfg` export, and
    `lmfg inspect` apply it).
  - `packages/render-engine/src/geometry`: the
    `@lumaforge/render-engine/geometry` subpath, the pure 3x3 projective
    kernel export geometry runs (`applyMatrix`, `invertMatrix`, `isMatrix3`,
    `Matrix3`, `Point`). It imports no RAW, JPEG, or color runtime; the app's
    Transform imports its matrix math from here.
  - `packages/render-engine/src/preview`: the CPU preview renderer, the
    quick/bounded-HQ preview plan, the preview color plan
    (`resolvePreviewColorPlan`: what each preview executor draws for the
    selected look, and why when that differs), JPEG preview encode, contact
    sheets, and the CPU preview worker bridge and protocol.
  - `packages/render-engine/src/policy`: export and interactive policy
    decisions and resource budgets.
  - `packages/render-engine/src/manifest`: `RenderManifest` types,
    canonical-JSON `manifest_sha256`, source and LUT identity, the color
    graph descriptor, and `parseRenderManifest` (the hash over the whole
    file, then the full v1 structure), which `lmfg` and `lmfg-mcp` read
    manifests through.
- `packages/luma-raw-runtime` is the browser RAW metadata/decode/runtime
  boundary, including worker protocol, native artifacts, processed-window facts,
  fixtures, benchmarks, and native verification.
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
  about it. It authors no Transform geometry; `render replay` reapplies a
  recorded one (see Retained And Scheduled Slices). The package entry exports
  the workspace layout (`packages/lmfg-cli/src/workspace/paths.ts`) and the
  stored record schemas (`packages/lmfg-cli/src/schemas/results.ts`).
- `packages/lmfg-mcp` is the `lmfg-mcp` stdio MCP server. The tools declared in
  `packages/lmfg-mcp/src/tools.ts` map one-to-one to `lmfg` commands: each runs
  the CLI in-process and returns its envelope unchanged. Two tools are
  MCP-native, with their own result schemas and error codes and no CLI
  command: `lmfg_image_read` (`packages/lmfg-mcp/src/image.ts`: view a session
  preview, candidate, or contact sheet) and `lmfg_export_detail`
  (`packages/lmfg-mcp/src/export-detail-tool.ts`: a verified 1:1 PNG region of
  a full-resolution `lmfg` export). Both read the workspace through the CLI's
  exported layout and record schemas, and manifests through
  `parseRenderManifest`. `pnpm cli:build` builds it and `pnpm test:cli` runs
  its tests.

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

Contract owners inside those homes. Extend these instead of defining a local
variant:

- Color intent: `packages/luma-color-runtime/src/user-color-intent.ts` defines
  `UserColorIntent` (tone, color balance, saturation, HSL), `LookSelection`
  (none, built-in preset, or custom LUT, with a continuous strength), and
  their union `ColorGraphIntent`, plus the field bounds, normalization, and
  signatures. View state, RAW render exposure, LUT bytes, and geometry are not
  part of it. Each entry point keeps its own look strength default: the app's
  standard Strength preset, `lmfg`'s `intensity` 1.
- View: `src/lib/preview/preview-view.ts` defines `PreviewView` (view mode and
  frame-anchored compare split) and maps a mode to what each executor draws.
  The session's `viewState` owns the view once a source loads; zoom and pan
  stay with the preview viewport. Executors receive only their output
  selection. The color params (`ColorGraphIntent`) carry
  no view fields.
- Decoded preview frame identity: `DecodedPreviewFrame` in
  `src/lib/preview/preview-frame.ts`. Only
  `src/modules/raw-processor/hooks/stages/preview/useDecodedPreviewResource.ts`
  mints one, once per accepted frame (a restored frame gets a new one). The
  GPU and CPU previews, the histogram, the original reference snapshot, and
  the Transform source key their work by it and never rebuild an identity
  from dimensions, version counters, or byte lengths; a request's own
  identity stays with its consumer.
- Export output results: `packages/render-engine/src/export/jpeg/output-result.ts`.
  `src/lib/export/output-sink.ts`, the export worker and client, and the
  workflow import these types; the sink adds only OPFS addressing and
  finalization types.
- Manifest render parameters: `projectManifestRenderParams` in
  `packages/render-engine/src/manifest/render-params.ts` writes
  `render_params` for both the app
  (`src/modules/raw-processor/services/export/export-manifest.ts`) and `lmfg`
  (`packages/lmfg-cli/src/services/color-graph.ts`). A manifest read from
  outside passes `parseRenderManifest`
  (`packages/render-engine/src/manifest/parse-render-manifest.ts`) before
  `lmfg` reads its params back.
- Preview color policy: `resolvePreviewColorPlan`
  (`packages/render-engine/src/preview/preview-color-plan.ts`) decides what the
  WebGPU preview, the CPU preview, and the histogram draw for the selected
  look, and the typed reason when that differs from the selection.
  `src/modules/raw-processor/services/surface/raw-reason.ts` turns those
  reasons into surface copy.
- Surface availability:
  `src/modules/raw-processor/services/surface/derive-tool-availability.ts`
  decides each tool action separately (edit, strength, LUT application,
  original view, split, export entry, full and HQ export, delivery, restore).
  The desktop rail, the mobile dock, and the compare lens read it through
  `src/modules/raw-processor/components/RawWorkflowToolProvider.tsx`; do not
  fold actions back into one compare or edit flag.
- Browser export plan: `selectExportPlan` in `src/lib/export/export-plan.ts`
  is the one entry from the export request, device facts, and interruption
  history to the engine's `deriveExportPolicy`.
- Export result currency: `src/modules/raw-processor/model/export-result.ts`
  defines the immutable identity a completed result carries, and
  `src/modules/raw-processor/services/export/export-result-identity.ts`
  captures it from the request before any work. Delivery (download, copy,
  share, manifest) goes through
  `src/modules/raw-processor/services/export/export-result-actions.ts`, which
  checks after every await and right before each side effect that the
  workflow still asks for that result: the same session, source, color
  intent, LUT, committed geometry, and a Transform status the result's kind
  accepts. A stale delivery has no side effect.
- Transform geometry: the matrix kernel is `@lumaforge/render-engine/geometry`
  and export planning is `packages/render-engine/src/export/geometry`. The
  manual-control composition (`composeManualTransform` in
  `src/lib/transform/transform-render.ts`, over
  `src/lib/transform/geometry/matrix.ts`) and upright detection are app-only:
  no package or CLI authors a geometry, so they stay in `src/lib/transform`.
- LUT contract composition:
  `src/modules/raw-processor/services/look/lut-contract.ts`,
  `src/modules/raw-processor/services/look/lut-output-options.ts`, and
  `src/modules/raw-processor/services/look/lut-source-grouping.ts` compose
  contracts, output options, and source groups for both surfaces. Their
  labels and profile grouping (`formatLUTContractOutput`,
  `getProfileOutputLabel`, `groupProfiles`, and their siblings) live in
  `src/modules/raw-processor/services/look/lut-contract-labels.ts`: pure label
  helpers that decide no contract, which the desktop rail, the mobile Look
  footer, and the output-options service all import.

Known duplication. None is known today. A copy found later is listed here,
with the move that removes it, until that move lands; do not extend a listed
copy.

Retired public API. No published export is deprecated: a replaced export is
deleted in the change that replaces it, with a `### Breaking` CHANGELOG entry,
and no `@deprecated` forwarding export, compatibility re-export, or legacy
field reader takes its place. `scripts/quality/check-retired-api.mjs`
(`pnpm check:retired-api`) lists the retired names and fails when a published
entry exports one again, an exported type regains a retired member, code or a
document outside a test or CHANGELOG names one, or code outside a test carries
a `@deprecated` tag.

Data the deployed build has written to users' devices is not a compatibility
path. Its readers are supported production code and stay while that data can
exist: the OPFS export outputs, including those written straight into the
active export directory before outputs moved into per-tab directories, read
by `src/lib/export/output-sink.ts` and `src/lib/export/opfs-output-lifetime.ts`;
the online LUT source registry and its removed-default tombstones in
`src/modules/raw-processor/services/look/online-lut-sources.ts`; and the LUT
contract choices `src/lib/lut/profile-resolution.ts` stores, which it trusts
only in the exact canonical form it writes. The retired API check also fails
when the OPFS or online LUT source readers it lists disappear.

Close the extraction. When you move code to its canonical owner, switch every
consumer to the owner's export and delete the old copy in the same change: no
type-only mirrors, "keep these in step" comments, or forwarding shims. This
holds for the published packages (`@lumaforge/render-engine`,
`@lumaforge/luma-raw-runtime`, `@lumaforge/luma-color-runtime`,
`@lumaforge/luma-jpeg-runtime`) too; check every consumer in the repository
and record the break as above.

## Retained And Scheduled Slices

These are owner decisions. They override cleanup advice that says otherwise.

- Transform: `/raw` Transform lives in production code. Types, upright
  geometry, the preview renderer, and its worker are in `src/lib/transform`;
  `src/modules/raw-processor/hooks/useRawTransformFeature.ts` drives
  `src/modules/raw-processor/hooks/useTransformPreview.ts`, and the preview
  overlay renders through
  `src/modules/raw-processor/components/TransformCanvas.tsx`.
  There is no `/transform-demo` route or demo module. Four paths touch a
  geometry and stay distinct:
  - preview: the app's Transform worker resamples the processed preview
    frame for the overlay; it shows the framing but is not the export
    reference;
  - export: the committed geometry is planned and resampled at full
    resolution in `packages/render-engine` before the color graph, and a
    geometry the engine cannot plan fails closed;
  - authoring: `lmfg` params carry no geometry, so neither `lmfg` nor
    `lmfg-mcp` can author a Transform;
  - replay: `lmfg render replay` reapplies the geometry a full-resolution
    export manifest records, through the same engine planner and executor,
    after checking before any decode that it plans from the recorded source
    frame to the recorded output, and refuses preview and candidate
    manifests that record one.
- DCP calibration: the app slice (stage hook, service, atoms, and the
  calibration catalog and DCP params parsers) is removed, and the workflow
  applies no camera calibration. The LUT catalog parser rejects calibration
  documents through its generic `invalid-catalog` check. The runtime side
  stays:
  `applyCalibration` in `@lumaforge/luma-raw-runtime`, `solveDcpInterpolation`
  in `@lumaforge/luma-color-runtime`, and the manifest's null `calibration`
  slot.
- Built-in style presets are retained: keep `styleKind: 'builtin'`,
  `builtinPreset`, their WGSL branches and uniforms in `src/lib/webgpu`, and
  their goldens in `scripts/webgpu/goldens.json`. No UI entry point selects a
  preset today, and full-resolution export refuses one:
  `resolveExportColorGraph` in `packages/luma-color-runtime/src/color-graph.ts`
  returns `unsupported-pipeline` for `styleKind: 'builtin'`. The preview color
  plan lets the WebGPU preview keep drawing a preset, while the CPU preview
  and the histogram leave it out with a typed reason. Do not delete the
  plumbing and do not restore a preset picker without a request. Product and
  user docs describe only the looks a user can actually pick (catalog LUTs
  and their own `.cube` files); do not describe a built-in finish picker.
- Online LUT catalog activation is lazy.
  `src/modules/raw-processor/hooks/useOnlineLutSources.ts` requests no catalog
  when it mounts. A listed source (the default or a saved one) is requested
  when a surface that shows its catalog asks for it: opening that source on
  the desktop rail, the mobile Look strip coming on screen, or the mobile LUT
  sources sheet opening. A `?luts=` link, adding a source, and Refresh request
  at once; a failed source waits for Retry or Refresh. `?luts=` deep links and
  Share stay.
- Export interruption is a hint, not a recovery.
  `src/modules/raw-processor/services/export/export-interruption.ts` writes a
  bounded, attempt-scoped marker per export, located by the source's file
  tuple (name, size, last modified) and owned by the page that started it.
  When the same file is loaded again after an attempt was left running by a
  page that is gone, or ended in a resource failure, the export panels say
  so, and the next export the user starts gets the safer plan (fewer rows,
  one worker). Nothing resumes partial output, reselects a source, or exports
  on its own; the app writes no export journal or checkpoint. Do not add
  source reselection or automatic re-export.
- The RAW render exposure is pinned per source: the first quick frame sets it
  (`src/modules/raw-processor/hooks/stages/preview/useDecodedPreviewResource.ts`),
  and bounded-HQ frames, preview restored after export, and the export carry
  the same value until the source is replaced or reset. `lmfg` measures
  automatic exposure on the same standard quick frame.
- The app encodes every JPEG, full-resolution and HQ preview export alike, at
  the one quality `EXPORT_JPEG_QUALITY` (0.92) in
  `src/modules/raw-processor/services/export/export-system.ts`. There is no
  quality option, and the internal performance preference sizes the export
  plan without changing the quality.

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
  `docs/ANTI_AI_SLOP_GUARDRAILS.md`: the standing anti-AI-slop
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
  A split drag moves only CSS and commits the split once, when the gesture
  ends.
- The CPU preview has no split surface, but it still shows the original: the
  desktop CPU stage has a processed/original toggle under the photo, and the
  mobile compare lens toggles the original (a hold peeks). Split commands are
  refused there while the original view stays available; keep the `split` and
  `originalView` actions separate.
- Original reference snapshots are capped and lifecycle-managed. Treat object
  URL release as part of the compare contract.
- The Adjust workflow is shared color-pipeline behavior, not a local UI-only
  tweak. Tone, color, and HSL params flow through preview, histogram, export,
  CPU preview, and mobile focus/list UI.
- Desktop Adjust lives in
  `src/modules/raw-processor/components/tools/AdjustTool.tsx`, which composes
  `ToneTool`, `ColorTool`, and `HSLTool`; mobile Adjust uses `AdjustListPanel`,
  `ToneListPanel`, `ColorListPanel`, `HSLListPanel`, `AdjustSliderRow`, and
  `ScrubValueHud`. Transform is `TransformTool` on desktop and
  `TransformListPanel` on mobile.
- The stable color insertion point for user tone and color balance is after
  raw-render exposure and before LUT input conversion.
- Transform geometry is not a color step: export resamples it before the color
  graph and paints the matte in output space afterwards, and the preview must
  show the same framing.
- CPU preview/degraded mode must have a usable startup/empty-state path.
  Production validation should include `/raw?forcePreview=cpu` when touching
  degraded-preview behavior.

## Docs

- Do not commit spec, plan, audit, or execution-plan documents. Code, tests,
  commit messages, this file, `DESIGN.md`, and `PRODUCT.md` are the durable
  record. If a workflow or agent skill wants to write one (for example under
  `docs/superpowers/`), keep it out of the repository unless the user asks.
- `docs/` holds user guides plus living references
  (`docs/PERFORMANCE_RESOURCE_MANAGEMENT.md`,
  `docs/ANTI_AI_SLOP_GUARDRAILS.md`).
  Update them when the behavior they describe changes.
- `README.md`, `docs/README.md`, and the user guides each have a Chinese
  twin (`README_zh.md`, `docs/README_zh.md`, and the `_zh` guides). Change a
  pair together so both say the same thing.
- Write every repository path in this file and in
  `docs/PERFORMANCE_RESOURCE_MANAGEMENT.md` in full from the repository root.
  `pnpm check:agent-paths` fails on a backticked path in either that does not
  resolve; CI runs it on every change, docs-only ones included.
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
  - Repository tooling and browser specs: `pnpm typecheck:tooling` checks
    the root TypeScript configs and the TypeScript under `scripts/` and
    `plugins/` (`tsconfig.tooling.json`), and `pnpm typecheck:browser` checks
    `tests/browser/tsconfig.json`. The color and JPEG runtime tests
    typecheck with `pnpm typecheck:runtime-tests`.
  - Structure and retired API: `pnpm check:structure` and
    `pnpm check:retired-api` (see Retired public API under Canonical Owners)
    read the whole repository; run them after removing or moving an export.
- Default closeout verification for broad app changes remains:
  - `pnpm lint`
  - `pnpm test:run`
  - `pnpm build`
- `pnpm test:run` is the full Vitest sweep: `vitest.config.ts` names the
  `app` and `tooling` projects and one project per workspace package, named
  after its directory (for example `vitest run --project lmfg-mcp`). Each
  package keeps its own config, so the aggregate runs a package's tests as
  that package's own `test` script does. `pnpm test:app` runs the `app`,
  `tooling`, and `luma-color-runtime` projects. Do not make `pnpm test:run`
  the first command after every UI batch when `pnpm test:ui` or
  `pnpm test:app` gives the faster signal needed for the current scope.
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
- Tests use the shared fixtures in
  `src/modules/raw-processor/test-support/builders.ts` (sessions, decoded
  frames, Transform states, LUT cubes) and
  `src/modules/raw-processor/test-support/web-locks.ts`; extend them instead
  of hand-writing literals. Cover a contract once, at the lowest layer that
  owns it.
- CI (`.github/workflows/build.yml`) follows the same split; every job except
  `quality` is path-selected. `quality` runs on every change, docs-only ones
  included: the path check above, `scripts/quality/check-test-projects.mjs`
  (each test file runs in exactly one Vitest project), `pnpm lint:check`
  (with the module ownership rule in `plugins/eslint-import-boundaries.mjs`),
  `pnpm typecheck:tooling`, `pnpm check:structure` (knip, then import
  cycles; no baseline), and `pnpm check:retired-api`.

## When Unsure

- Follow the current code over old agent habits.
- Follow README and DESIGN.md over generic frontend assumptions.
- Search the repo before relying on memory for names, paths, or runtime
  boundaries.
- Keep the product narrow, the color pipeline explicit, and the export path
  trustworthy.
