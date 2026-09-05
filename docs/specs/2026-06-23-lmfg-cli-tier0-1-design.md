# lmfg CLI — Tier 0+1 Design

- Status: Tier 0 (cpu-wasm) implemented per
  `docs/plans/2026-09-05-lmfg-cli-tier0-release-plan.md`; Tier 1 (browser
  bridge, §6) deferred. `capabilities` reports the browser tier as
  unavailable. JSON is the default stdout format (`--json` is a no-op).

## 1. Purpose

`lmfg` is an agent-friendly, reproducible RAW/LUT rendering CLI. Its core value
is letting AI agents safely, repeatedly, and observably iterate on RAW photo
color grading through structured sessions, manifests, and artifact workspaces.

Human CLI is a natural byproduct; the primary consumer is an agent loop:

```
inspect → intent → LUT search/contract → candidate sweep → evaluate → export
```

## 2. Architecture (Approach C)

render-engine defines `LumaRenderContext` as the single injection surface. The
CLI provides two implementations:

```
@lumaforge/lmfg-cli
  src/context/
    node-cpu-context.ts   — LumaRenderContext via Node WASM (luma-raw-runtime/node)
    browser-context.ts    — LumaRenderContext via Playwright + render harness

  src/commands/         — command handlers
  src/protocol/         — JSON/NDJSON envelope, error codes, event stream
  src/workspace/        — .lmfg/ session/artifact store
  src/schemas/          — Zod schemas → JSON Schema generation
  src/cli.ts            — entry point (commander/yargs)
  render-harness/       — minimal HTML page for Playwright rendering
```

### Rendering tiers

| Tier | Backend | Capabilities |
|------|---------|-------------|
| cpu-wasm | luma-raw-runtime/node + luma-color-runtime + luma-jpeg-runtime | inspect, source identity, CPU preview, LUT contract, manifest, export (CPU path) |
| browser-bridge | Playwright + render-harness.html (WebGL2 + WASM) | Full WebGL2 preview, candidate render, contact sheet, full-res export |

Both tiers produce identical `RenderManifest` output. The only difference is
rendering fidelity and speed.

### Dependency structure

```
@lumaforge/lmfg-cli
  ├── @lumaforge/render-engine (workspace dep)
  ├── @lumaforge/luma-color-runtime (workspace dep)
  ├── @lumaforge/luma-raw-runtime (workspace dep)
  ├── @lumaforge/luma-jpeg-runtime (workspace dep)
  ├── @lumaforge/luma-native-artifacts (workspace dep)
  ├── zod (schema definition)
  ├── commander (CLI parsing)
  └── playwright (optional peer dep for Tier 1)
```

## 3. Command Surface (P0 Scope)

### 3.1 Introspection

```bash
lmfg version --json
lmfg capabilities --json
lmfg schema list --json
lmfg schema show <schema-id> --json
```

### 3.2 Session

```bash
lmfg session init --source <file> [--workspace <dir>] --json
lmfg session status --session <id> --json
lmfg session list --json
```

### 3.3 Source / Inspect

```bash
lmfg inspect --session <id> --json
lmfg inspect <file> --json
```

### 3.4 LUT Contract

```bash
lmfg lut inspect <file.cube> --json
lmfg lut contract infer --lut <file.cube> --json
lmfg lut contract validate --lut <file.cube> --contract <contract.json> --json
```

### 3.5 Render

```bash
lmfg render preview --session <id> --params <params.json> [--tier cpu|browser] --json
lmfg render candidate --session <id> --plan <plan.json> --json
lmfg render sweep --session <id> --plan <sweep.json> --contact-sheet --emit ndjson
lmfg render export --session <id> --candidate <id> --quality <n> --json
```

### 3.6 Compare / Metrics

```bash
lmfg compare sheet --session <id> --iteration <id> --layout <WxH> --json
lmfg metrics compute --session <id> --candidate <id> --json
```

### 3.7 Manifest

```bash
lmfg manifest verify <manifest.json> --json
lmfg manifest show <manifest.json> --json
```

## 4. JSON Protocol

### 4.1 Success envelope

```json
{
  "schema": "lmfg.<command>.<version>",
  "ok": true,
  "result": { ... }
}
```

### 4.2 Error envelope

```json
{
  "schema": "lmfg.error.v1",
  "ok": false,
  "error": {
    "code": "lut.contract.incomplete",
    "message": "...",
    "retryable": true,
    "suggested_next_actions": ["lmfg lut contract infer ..."]
  }
}
```

### 4.3 NDJSON event stream (--emit ndjson)

```json
{"event":"started","command":"render.sweep","session_id":"sess_...","schema":"lmfg.event.v1"}
{"event":"candidate.started","candidate_id":"cand_0001","index":1,"total":12}
{"event":"candidate.ready","candidate_id":"cand_0001","preview_uri":"file:///...","manifest_sha256":"..."}
{"event":"artifact.ready","role":"contact-sheet","uri":"file:///..."}
{"event":"completed","ok":true,"result_uri":"file:///..."}
```

### 4.4 Exit codes

```
0   success
1   generic failure
2   invalid arguments / schema validation
3   unsupported RAW / capability
4   incomplete LUT contract
5   permission denied / network not allowed
6   fetch / hash verification failed
7   render failed
8   export refused (cannot prove reproducibility)
9   cancelled / aborted
10  internal bug
```

## 5. Workspace Layout

```
.lmfg/
  sessions/
    sess_<timestamp>_<id>/
      session.json
      source/
        source.identity.json
        embedded-preview.jpg
      luts/
        cache/
      iterations/
        iter_0001/
          plan.json
          events.ndjson
          contact-sheet.jpg
          contact-sheet.map.json
          candidates/
            cand_0001/
              preview.jpg
              manifest.json
              metrics.json
      exports/
        final.jpg
        final.manifest.json
```

## 6. Render Harness (Tier 1)

A minimal HTML page bundled with the CLI:

```html
<!-- render-harness/index.html -->
<script type="module">
  import { createRawRuntime } from '@lumaforge/luma-raw-runtime'
  import { applyColorPipeline } from '@lumaforge/luma-color-runtime'
  import { createJpegEncoder } from '@lumaforge/luma-jpeg-runtime'
  // WebGL2 renderer from src/lib/gl (extracted or copied)
  // Exposes window.__lmfg_harness = { render, export, getManifest }
</script>
```

Playwright drives this page:
1. `page.goto('file:///render-harness/index.html')`
2. `page.evaluate(() => __lmfg_harness.loadSource(bytes))`
3. `page.evaluate(() => __lmfg_harness.render(params))`
4. `page.evaluate(() => __lmfg_harness.exportJpeg(quality))`

### Optimization: single browser instance

Following mermaid-cli's pattern, the CLI reuses a single Playwright browser
instance across all renders within a session/sweep. Browser is launched lazily
on first render command.

## 7. Capability Discovery

`lmfg capabilities --json` output:

```json
{
  "schema": "lmfg.capabilities.v1",
  "render_tiers": {
    "cpu_wasm": {
      "available": true,
      "supports": ["inspect", "source-identity", "cpu-preview", "lut-contract", "manifest", "cpu-export"]
    },
    "browser_bridge": {
      "available": true,
      "backend": "playwright-chromium",
      "version": "1.52.0",
      "supports": ["webgl2-preview", "candidate-render", "contact-sheet", "full-res-export"]
    }
  },
  "active_tier": "browser_bridge",
  "fallback_order": ["browser_bridge", "cpu_wasm"],
  "runtime_versions": {
    "luma_raw_runtime": "0.1.0",
    "luma_color_runtime": "0.1.0",
    "luma_jpeg_runtime": "0.1.0",
    "render_engine": "0.1.0"
  }
}
```

## 8. Global Flags

```
--json              Single JSON result to stdout
--emit ndjson       Event stream to stdout
--quiet             Suppress stderr non-essential output
--no-color          Disable ANSI
--workspace <dir>   Artifact root (default: .lmfg)
--session <id>      Explicit session
--tier <tier>       Force rendering tier (cpu|browser)
--dry-run           Validate only
--yes               Non-interactive
--timeout <ms>      Per-operation timeout
```

## 9. Implementation Milestones

### M0: CLI skeleton + protocol (1-2 days)
- Package scaffolding, bin entry, commander setup
- JSON/NDJSON protocol envelope
- Exit code handling
- `lmfg version`, `lmfg capabilities`, `lmfg schema list/show`
- Zod schema infrastructure

### M1: Session + inspect (1-2 days)
- Workspace/session store implementation
- `lmfg session init/status/list`
- `lmfg inspect` via luma-raw-runtime/node
- Source identity (SHA-256, dimensions, embedded preview extraction)

### M2: LUT contract (1 day)
- `lmfg lut inspect`
- `lmfg lut contract infer/validate`
- Integrate luma-color-runtime profile registry

### M3: CPU render path (1-2 days)
- Node CPU context implementing LumaRenderContext
- `lmfg render preview --tier cpu`
- Manifest generation
- `lmfg manifest verify/show`

### M4: Browser bridge (2-3 days)
- Render harness HTML page
- Playwright browser context implementing LumaRenderContext
- `lmfg render preview --tier browser`
- `lmfg render candidate`
- `lmfg render sweep` with NDJSON events
- Contact sheet generation
- `lmfg render export`

### M5: End-to-end validation (1 day)
- Full agent loop test: init → inspect → render sweep → compare → export
- Manifest chain verification
- Capability fallback test
- CI integration

## 10. Schema Version Strategy

All schemas are versioned: `lmfg.<domain>.v<n>`. Zod definitions are the source
of truth; JSON Schema is generated for `lmfg schema show`. Breaking changes
increment the version number. `--schema-version` flag allows agents to pin.

## 11. Non-Goals (P0)

- MCP server
- Intent/tune commands (require LLM integration)
- LUT catalog network discovery
- Eval/scoring import
- `lmfg auto` convenience command
- Multi-file batch
- Remote render service
