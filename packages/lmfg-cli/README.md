# @lumaforge/lmfg-cli

`lmfg` is the agent-friendly, reproducible RAW/LUT rendering CLI for LumaForge.
It drives the same headless engine the browser app uses
(`@lumaforge/render-engine` over the `luma-raw`, `luma-color`, and `luma-jpeg`
runtimes) from Node.js, and records every render in a sealed `RenderManifest`.

This release ships the **cpu-wasm tier**: in-process WebAssembly decode, CPU
color pipeline, and the authoritative full-resolution JPEG export. The browser
bridge tier (WebGL2 via Playwright) is not included; `lmfg capabilities` reports
it as unavailable and `--tier browser` exits with code 3.

Requirements: Node.js 20 or newer.

## Install

```bash
npm install -g @lumaforge/lmfg-cli
lmfg version
```

Inside this repository: `pnpm cli:build && node packages/lmfg-cli/bin/lmfg.mjs version`.

## Agent loop

```bash
lmfg session init --source DSC0042.ARW                # → sess_…
lmfg inspect --session sess_…                         # metadata, embedded preview, export capability
lmfg lut contract infer --lut look.cube               # confirm or pick a color contract
lmfg render sweep --session sess_… --plan sweep.json --contact-sheet --emit ndjson
lmfg compare sheet --session sess_… --iteration iter_0001 --layout 4x3
lmfg metrics compute --session sess_… --iteration iter_0001 --candidate cand_0007
lmfg render export --session sess_… --iteration iter_0001 --candidate cand_0007
lmfg manifest verify .lmfg/sessions/sess_…/exports/final.manifest.json
```

Every command prints exactly one JSON envelope on stdout:

```json
{ "schema": "lmfg.render.export.v1", "ok": true, "result": { "…": "…" } }
```

Failures use `lmfg.error.v1` with a stable `code`, `retryable`, and
`suggested_next_actions`. `--emit ndjson` streams `lmfg.event.v1` lines
(`started`, `candidate.ready`, `artifact.ready`, `export.progress`, …) and ends
with a `completed` event that carries the result or error. Diagnostics go to
stderr; `--quiet` silences them.

## Commands

| Command | Purpose |
|---|---|
| `version`, `capabilities`, `schema list`, `schema show <id>` | Introspection; schemas are JSON Schema draft 2020-12 |
| `session init --source <raw>`, `session status`, `session list` | `.lmfg/` workspace sessions (full-file SHA-256 identity) |
| `inspect [file]` | Probe a RAW (or the `--session` source) |
| `lut inspect <cube>`, `lut contract infer --lut`, `lut contract validate --lut --contract` | LUT parsing and color-contract resolution |
| `lut fetch --url <https-url> --sha256 <hex> [--out <file>] [--allow-network]` | Download a `.cube` into the workspace LUT cache behind a network gate with hash verification |
| `render preview --params` | One CPU preview (quick ≤ 2.5 MP or bounded HQ up to 12 MP) |
| `render candidate --plan`, `render sweep --plan` | Multi-candidate iterations with per-candidate manifests, metrics, and tiles |
| `compare sheet --iteration --layout <cols>x<rows>` | Recompose contact sheets from stored tiles |
| `metrics compute --iteration --candidate` | Luma/chroma statistics for a candidate |
| `render export (--iteration --candidate \| --params)` | Full-resolution JPEG; refuses when reproducibility cannot be proven |
| `render replay --manifest <file> [--source <raw>] [--lut <cube>]` | Re-render a preview, candidate, or export manifest and report whether the output SHA-256 was reproduced |
| `manifest verify <file>`, `manifest show <file>` | Canonical-hash verification and display |

Global flags: `--workspace <dir>` (default `.lmfg`), `--session <id>`,
`--tier cpu|browser`, `--emit json|ndjson`, `--json`, `--quiet`, `--no-color`,
`--dry-run`, `--yes`, `--timeout <ms>`, `--memory-profile desktop|low-memory`.

Environment: `LMFG_ALLOW_NETWORK=1` is equivalent to `--allow-network` for
`lut fetch`; `NO_COLOR` disables ANSI output. Nothing else reads the network.

## Params, plans, sweeps, contracts

`lmfg schema show lmfg.params.v1` prints the authoritative schema. Example:

```json
{
  "exposure_ev": 0.3, "contrast": 15, "highlights": -20, "shadows": 10,
  "whites": 0, "blacks": 0, "temperature": 5, "tint": 0,
  "saturation": 0, "vibrance": 10, "intensity": 1,
  "selective_color": { "orange": { "hue": -6, "saturation": 12, "lightness": 0 } },
  "raw_render_exposure": "auto",
  "lut": {
    "path": "looks/vlog-to-709.cube",
    "contract": {
      "role": "combined-look-output",
      "input_profile": "panasonic-vgamut-vlog",
      "output_gamut": "srgb-rec709", "output_transfer": "bt709", "output_range": "full"
    }
  }
}
```

A candidate plan (`lmfg.plan.v1`) lists explicit candidates; a sweep plan
(`lmfg.sweep.v1`) expands numeric axes into a cartesian product (max 64
candidates):

```json
{ "base": { "lut": { "path": "look.cube" } }, "axes": { "exposure_ev": [-0.5, 0, 0.5], "contrast": [0, 20] } }
```

`selective_color` takes per-band HSL shifts for any of `red`, `orange`,
`yellow`, `green`, `aqua`, `blue`, `purple`, `magenta` (hue -180..180,
saturation and lightness -100..100); omitted bands stay neutral.

LUTs whose contract cannot be confirmed from `LUMAFORGE_*` comments must carry
an explicit `contract`; `lut contract infer` returns ready-to-use
`suggested_contracts`. Rendering never guesses a log/gamut contract.

`lut fetch` only runs with `--allow-network` (or `LMFG_ALLOW_NETWORK=1`),
requires an `https://` URL and the expected SHA-256, caps the download at
64 MB, and stores the file as `.lmfg/luts/<sha256>.cube`. A cached file with
the same hash is reused without touching the network. The response includes
the same inspect and contract summary as `lut inspect`, so an agent can decide
whether it needs an explicit contract before rendering.

## Workspace layout

```
.lmfg/sessions/sess_<timestamp>_<id>/
  session.json
  source/{source.identity.json, inspect.json, embedded-preview.jpg}
  previews/prev_0001.jpg, prev_0001.manifest.json
  iterations/iter_0001/{plan.json, events.ndjson, contact-sheet.jpg, contact-sheet.map.json}
  iterations/iter_0001/candidates/cand_0001/{preview.jpg, manifest.json, metrics.json, params.json, tile.rgba, tile.json}
  exports/final.jpg, final.manifest.json
  replays/replay_<timestamp>_<id>/{output.jpg, manifest.json}
.lmfg/luts/<sha256>.cube
```

All writes are atomic (temp file + rename).

## Manifests and reproducibility

Every preview, candidate, and export writes a `RenderManifest` v1 sealed with
`manifest_sha256` (SHA-256 of the canonical JSON without that field). It
records the source RAW SHA-256, the LUT file SHA-256 and contracts, the
resolved color graph (LUT tables replaced by their hash), user params, the
resolved raw-render exposure, policy, and runtime versions including the native
artifact build id. `render export --candidate` reuses the candidate's exposure
and sets `parent_manifest_sha256` so the chain preview → candidate → export can
be audited with `manifest verify`.

Export fails closed (exit 8) when the source bytes changed, the LUT file
changed, the JPEG stream is incomplete, or the manifest fails
self-verification. Unsupported RAWs exit 3; incomplete LUT contracts exit 4.

`render replay --manifest` re-renders from the manifest alone: the recorded
params, LUT contract, raw-render exposure, decode budget (`policy.max_pixels`),
and JPEG quality. The source comes from `--source` or the session that owns the
manifest, and the LUT from `--lut` or the workspace cache by SHA-256. Replay
refuses (exit 8, `replay.mismatch`) when the color-graph fingerprint no longer
matches, exits 6 when the source or LUT bytes differ from the recorded
hashes, and reports `reproduced: true` only when the new output SHA-256 equals
the recorded one. The replay writes its own manifest with
`parent_manifest_sha256` pointing at the replayed manifest.

The browser app seals the same `RenderManifest` for every completed
full-resolution export ("Manifest" next to Download on desktop and mobile);
`lmfg manifest verify` accepts those files, and `render replay` can reproduce
them when the same LUT file is available.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | success |
| 1 | generic failure (including `manifest.invalid`) |
| 2 | invalid arguments / schema validation / missing files |
| 3 | unsupported RAW, capability, or tier |
| 4 | incomplete or invalid LUT contract |
| 5 | permission denied / network not allowed |
| 6 | fetch or hash verification failed |
| 7 | render failed |
| 8 | export refused (cannot prove reproducibility) or replay mismatch (`replay.mismatch`) |
| 9 | cancelled / timed out |
| 10 | internal bug |

## Releasing

1. `pnpm cli:build && pnpm --filter @lumaforge/lmfg-cli test`
2. `pnpm --filter @lumaforge/render-engine exec npm pack --dry-run` and
   `pnpm --filter @lumaforge/lmfg-cli pack:dry-run` — both must succeed.
3. Publish `@lumaforge/render-engine` first (it is a `workspace:*` dependency),
   then `@lumaforge/lmfg-cli`. The runtime packages and
   `@lumaforge/luma-native-artifacts` are already published.
