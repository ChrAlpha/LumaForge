# @lumaforge/render-engine

Headless render engine for LumaForge. Runs in browser and Node.js.

It holds the render pipeline shared by the `/raw` app and the `lmfg` CLI:

- `LumaRenderContext` injection surface (`./context/runtime-context.ts`).
- `RenderManifest` v1 + `ExportCheckpointManifest` types, canonical-JSON
  `manifest_sha256`, source content identity, and incremental SHA-256
  (`./manifest/*`).
- Full-resolution row-band JPEG export, including strip scheduling and export
  geometry (`./export/*`).
- CPU preview render, candidate render, and contact sheets (`./preview/*`).
- Export and interactive policy decisions and resource budgets (`./policy/*`).

## Subpath exports

- `@lumaforge/render-engine` — public types and entry points
- `@lumaforge/render-engine/manifest` — manifest types and hash utilities
- `@lumaforge/render-engine/export` — full-resolution export engine
- `@lumaforge/render-engine/preview` — CPU preview, candidates, contact sheets
- `@lumaforge/render-engine/policy` — capability input and policy decisions

## Test environment

Tests run under Node (vitest `environment: 'node'`). The package is
designed to work in both browser and Node, but Node is the canonical test
environment.
