# @lumaforge/render-engine

Headless render engine for LumaForge. Runs in browser and Node.js.

It holds the render pipeline shared by the `/raw` app and the `lmfg` CLI:

- `RenderManifest` v1 types, canonical-JSON `manifest_sha256`, source content
  identity, incremental SHA-256, the color-graph descriptor, the
  `render_params` projection, and `parseRenderManifest`, which verifies the
  hash over the whole file and then the full v1 structure
  (`@lumaforge/render-engine/manifest`).
- Full-resolution row-band JPEG export, including strip scheduling and export
  geometry planning and resampling (`@lumaforge/render-engine/export`).
  `assessProcessedExport` reports whether a probed RAW source can feed the
  processed-window export, with every typed refusal;
  `runProcessedWindowExportLifecycle` brackets one such export with the
  session's begin and end hooks.
- The pure 3x3 projective geometry kernel export geometry runs
  (`@lumaforge/render-engine/geometry`).
- CPU preview render and JPEG encode, the preview plan and preview color
  plan, and contact sheets (`@lumaforge/render-engine/preview`).
- Export and interactive policy decisions and resource budgets
  (`@lumaforge/render-engine/policy`).

The engine takes host facts as input and detects none: policy functions take
the `CapabilityVector` that describes the actual host, and there is no default
vector. `runFullResolutionJpegExport` takes its inputs explicitly
(`capability`, an optional `jpegSink`, `signal`, `onProgress`); without a
`jpegSink` it encodes through `createWasmJpegRowSink`. An interrupted export
reruns from the start: the engine keeps no export journal or checkpoint.

## Subpath exports

- `@lumaforge/render-engine` — public types and entry points
- `@lumaforge/render-engine/manifest` — manifest types, hash utilities,
  manifest construction, `parseRenderManifest`, and
  `checkRecordedExportGeometry`
- `@lumaforge/render-engine/export` — full-resolution export engine, export
  geometry planning, and the processed-export assessment and lifecycle
- `@lumaforge/render-engine/geometry` — `applyMatrix`, `invertMatrix`,
  `isMatrix3`, `Matrix3`, and `Point`: the matrix functions export geometry
  runs, from an entry that imports no RAW, JPEG, or color runtime and no
  browser object, so loading it initializes no renderer. Geometry
  authoring (composing upright and manual controls into a matrix) is not
  part of the engine.
- `@lumaforge/render-engine/preview` — CPU preview, JPEG preview encode,
  contact sheets
- `@lumaforge/render-engine/policy` — capability input and policy decisions

`@lumaforge/luma-color-runtime`, `@lumaforge/luma-jpeg-runtime`, and
`@lumaforge/luma-raw-runtime` are peer dependencies; the bundle imports them
at runtime instead of carrying a copy.

## Reading manifests

`parseRenderManifest` is the reader for a manifest that comes from outside:
it checks `manifest_sha256` over the complete parsed object, unknown fields
included, then the v1 structure without coercing anything. Everything a
replay executes must be recorded the way the current writers record it: a
color-graph descriptor of `COLOR_GRAPH_DESCRIPTOR_VERSION` whose fingerprint
hashes it, and complete tone, color balance, saturation, strength, and RAW
render exposure fields. A record an earlier writer sealed without one of
these, including every manifest `lmfg` 0.1.0 wrote, is refused, not
completed. It returns the manifest typed, or every issue with its field path.

`checkRecordedExportGeometry` then says whether a structurally valid manifest
records an export the engine can produce, with a typed refusal when it does
not.

## Test environment

Tests run under Node (vitest `environment: 'node'`). The package is
designed to work in both browser and Node, but Node is the canonical test
environment.

The tests resolve the built runtime packages, so build them first:

```bash
pnpm cli:build:deps
pnpm --filter @lumaforge/render-engine test
```

`pnpm cli:build:deps` also builds this package; the bundle smoke test
(`src/dist-bundle.test.ts`) checks the built `dist` entries and skips when
they are missing.
