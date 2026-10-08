# @lumaforge/render-engine

Headless render engine for LumaForge. Runs in browser and Node.js.

It holds the render pipeline shared by the `/raw` app and the `lmfg` CLI:

- `RenderManifest` v1 types, canonical-JSON `manifest_sha256`, source content
  identity, incremental SHA-256, the color-graph descriptor, the
  `render_params` projection, and `parseRenderManifest`, which verifies the
  hash over the whole file and then the full v1 structure (`./manifest/*`).
- Full-resolution row-band JPEG export, including strip scheduling and export
  geometry planning and resampling (`./export/*`). `assessProcessedExport`
  reports whether a probed RAW source can feed the processed-window export,
  with every typed refusal; `runProcessedWindowExportLifecycle` brackets one
  such export with the session's begin and end hooks.
- The pure 3x3 projective geometry kernel export geometry runs
  (`./geometry/*`).
- CPU preview render, the preview plan and preview color plan, candidate
  render, and contact sheets (`./preview/*`).
- Export and interactive policy decisions and resource budgets (`./policy/*`).

## Subpath exports

- `@lumaforge/render-engine` — public types and entry points
- `@lumaforge/render-engine/manifest` — manifest types, hash utilities, and
  `parseRenderManifest`
- `@lumaforge/render-engine/export` — full-resolution export engine, export
  geometry planning, and the processed-export assessment and lifecycle
- `@lumaforge/render-engine/geometry` — `applyMatrix`, `invertMatrix`,
  `isMatrix3`, `Matrix3`, and `Point`: the same matrix functions the export
  subpath exports, from an entry that imports no RAW, JPEG, or color runtime
  and no browser object, so loading it initializes no renderer. Geometry
  authoring (composing upright and manual controls into a matrix) is not
  part of the engine.
- `@lumaforge/render-engine/preview` — CPU preview, candidates, contact sheets
- `@lumaforge/render-engine/policy` — capability input and policy decisions

## Deprecated exports

`LumaRenderContext` and its parts, `ExportCheckpointManifest` and its parts,
`RenderBudget`, `NODE_DEFAULT_CAPABILITY`, `ExportFidelity`,
`sourceContentIdFromFile`, and `createNodeJpegRowSink` are still exported but
deprecated: nothing in the engine, the app, or `lmfg` uses them, and they are
scheduled for removal. `CHANGELOG.md` says what to use instead of each.

## Test environment

Tests run under Node (vitest `environment: 'node'`). The package is
designed to work in both browser and Node, but Node is the canonical test
environment.
