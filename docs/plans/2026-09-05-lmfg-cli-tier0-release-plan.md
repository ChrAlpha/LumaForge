# lmfg CLI Tier 0 Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `@lumaforge/lmfg-cli` (`lmfg`) at release maturity on the cpu-wasm tier: the full P0 command surface from the spec, a stable JSON/NDJSON protocol with spec exit codes, a `.lmfg/` session workspace, sealed `RenderManifest` chains from preview to full-resolution export, tests that run the real pipeline on the public DNG fixture, CI coverage, and package docs.

**Architecture:** A new workspace package `packages/lmfg-cli` composes the already-shipped engine pieces: `@lumaforge/luma-raw-runtime/node` and `@lumaforge/luma-jpeg-runtime/node` (in-process WASM), `@lumaforge/luma-color-runtime` (LUT parse, contracts, color graph), and `@lumaforge/render-engine` (`renderCpuPreviewFrame`, `candidateRender`, `composeContactSheet`, `runFullResolutionJpegExport` + `createNodeJpegRowSink`, manifest sealing). Domain logic lives in `src/services/*` (pure, unit-tested); command handlers in `src/commands/*` are thin adapters that map results onto the protocol envelope. All filesystem writes are atomic (temp + rename).

**Tech Stack:** TypeScript (ESM, Node ≥ 20), commander 15, zod 4 (`z.toJSONSchema`), Vite lib build (matches sibling packages), Vitest (`environment: node`), GitHub Actions.

**Spec:** `docs/specs/2026-06-23-lmfg-cli-tier0-1-design.md` (command surface §3, protocol §4, workspace §5, capabilities §7, flags §8). Engine contracts: `docs/specs/2026-06-13-render-engine-extraction-design.md` §5–§7.

---

## Release scope and locked decisions

Verified on 2026-09-05 (Node 24, prebuilt artifacts present, fixture `packages/luma-raw-runtime/fixtures/.cache/public/raw-pixls-iphone-se.dng` 12 MP): quick decode 0.43 s, CPU preview 0.25 s, preview JPEG 0.16 s, full-resolution export 2.7 s (4.5 MB). The whole Tier 0 pipeline already runs in plain Node; this plan wraps it.

| # | Decision | Rationale |
|---|---|---|
| D1 | **Release = Tier 0 (`cpu_wasm`) covering the entire P0 command surface.** The browser bridge (Tier 1, Playwright) is deferred; `lmfg capabilities` reports `browser_bridge.available: false` with a reason, and `--tier browser` fails with `tier.unavailable` (exit 3). | CPU export is the authoritative path in the app too. Tier 1 adds a Playwright dependency and a WebGL harness extraction; not required for reproducible agent loops. |
| D2 | **stdout is always one JSON envelope** (`--json` accepted as a no-op), or an NDJSON event stream with `--emit ndjson`. Human diagnostics go to stderr, silenced by `--quiet`. | Agent-first consumer; one output contract to test. |
| D3 | Export buffers the JPEG bytes in memory via `createNodeJpegRowSink`, injects EXIF with `preserveJpegMetadataBytes`, then writes atomically. | Node has headroom (a 100 MP q0.92 JPEG is tens of MB). Streaming sink is a follow-up. |
| D4 | Candidate rendering runs with `maxConcurrent: 1`. | Single-threaded WASM; the Node JPEG runtime allows one active encoder. |
| D5 | Manifest `color_graph.descriptor` is a JSON-safe projection (`descriptor_version: 1`): typed arrays become plain arrays, `lut3d.data` becomes `{ data_sha256, data_length }`; `fingerprint = sha256(canonicalizeJson(descriptor))`. | Keeps manifests small and hashable while still identifying the exact LUT table. |
| D6 | Each candidate stores a box-downsampled RGBA tile (`tile.rgba` + `tile.json`) so `compare sheet` can recompose layouts without a JPEG decoder. | No JPEG decoder exists in the runtimes. |
| D7 | Params JSON (`lmfg.params.v1`) is snake_case; selective color is not exposed in v1. | Mirrors manifest style; keeps the agent contract small. |
| D8 | `raw_render_exposure` is `"auto"` (DNG baseline or quick-frame statistics, exactly like the app) or an explicit EV. Candidate manifests persist the resolved value; `render export --candidate` reuses it so preview and export share color intent. | Guardrail: preview/export share intent, not executors. |
| D9 | The package resolves workspace deps through package `exports` (built `dist`). Its tsconfig sets `"paths": {}` to drop the root mapping. Root `vitest.config.ts` gains aliases for the `/node` subpaths so `pnpm test:run` runs from source. | Verified: without `paths: {}` tsc pulls sibling `src` into the program and fails on `rootDir`. |
| D10 | `render-engine` `RenderParams` gains optional additive fields (`raw_render_exposure_ev`, `color_balance.temperature`, `saturation`). `manifest_version` stays 1. | Additive, forward-compatible per spec §6.4 reader contract. |
| D11 | Errors carry `code`, `message`, `retryable`, `suggested_next_actions`, optional `details`; exit codes follow spec §4.4 exactly. | Agent recovery loop. |
| D12 | Release blocker recorded, not fixed here: `@lumaforge/render-engine` is not on npm (the four runtime packages are). Publish order: `render-engine` → `lmfg-cli`. `npm pack --dry-run` must pass for both. | Publishing needs credentials and is an outward-facing action. |

Not in scope (unchanged from spec §11): MCP server, intent/tune commands, LUT catalog network discovery, eval import, `lmfg auto`, batch, remote render, Tier 1.

---

## File Map

### New package `packages/lmfg-cli`

| File | Responsibility |
|---|---|
| `package.json` | name/bin/exports/files/engines/scripts/deps (already scaffolded, see Task 1) |
| `bin/lmfg.mjs` | executable shim → `dist/cli.js` |
| `tsconfig.json`, `tsconfig.build.json` | typecheck / declaration emit (`paths: {}`) |
| `vite.config.ts` | lib build (`cli`, `index` entries) + vitest node env |
| `README.md` | usage, agent loop, protocol, exit codes, workspace layout, release notes |
| `src/index.ts` | programmatic API re-exports (`runCli`, `createProgram`, types) |
| `src/cli.ts` | commander program: global options, command registration, `runCli(argv, io)` |
| `src/protocol/exit-codes.ts` | spec §4.4 exit code table |
| `src/protocol/errors.ts` | `LmfgError`, error code → exit code map, `toLmfgError` normalizer |
| `src/protocol/envelope.ts` | success/error envelope builders |
| `src/protocol/output.ts` | `Output`: json/ndjson stdout writer, stderr logger, quiet/color |
| `src/schemas/params.ts` | `lmfg.params.v1`, LUT reference, LUT contract input |
| `src/schemas/plan.ts` | `lmfg.plan.v1` (candidate list) and `lmfg.sweep.v1` (axes) + expansion |
| `src/schemas/results.ts` | zod result schemas for every command |
| `src/schemas/registry.ts` | schema id registry, `listSchemas`, `showSchema` (JSON Schema) |
| `src/workspace/paths.ts` | workspace root + session/iteration/candidate path helpers |
| `src/workspace/atomic-fs.ts` | atomic write helpers, JSON read/write |
| `src/workspace/ids.ts` | `sess_`/`iter_`/`cand_`/`prev_` id generation |
| `src/workspace/session-store.ts` | `session.json` record + init/load/list/update/counters |
| `src/workspace/iteration-store.ts` | iteration `plan.json`, `events.ndjson`, candidate artifact IO |
| `src/runtime/node-runtime.ts` | lazy RAW + JPEG Node runtimes with dispose |
| `src/runtime/versions.ts` | package versions, native artifact build id → `RenderEnvironment` |
| `src/runtime/capability.ts` | tier availability (artifact presence), limits |
| `src/runtime/source-loader.ts` | read RAW bytes + content identity, identity verification |
| `src/services/lut.ts` | load `.cube`, contract selection (pure port), infer/validate, identity |
| `src/services/color-graph.ts` | params → `resolveExportColorGraph`; descriptor v1 + fingerprint; manifest `render_params` |
| `src/services/manifest.ts` | build + seal manifests; verify/show with warnings |
| `src/services/inspect.ts` | probe, embedded preview, export capability, render exposure |
| `src/services/preview.ts` | decode frame (quick / bounded-hq), CPU render, JPEG encode |
| `src/services/metrics.ts` | image statistics from RGBA |
| `src/services/contact-sheet.ts` | box downsample, fit, compose sheet + map |
| `src/services/iteration.ts` | candidate/sweep runner (events, artifacts, manifests, sheet) |
| `src/services/export.ts` | fail-closed full-resolution export + manifest chain |
| `src/commands/context.ts` | `CommandContext`, timeout signal, `runCommand` envelope wrapper |
| `src/commands/introspection.ts` | `version`, `capabilities`, `schema list/show` |
| `src/commands/session.ts` | `session init/status/list` |
| `src/commands/inspect.ts` | `inspect [file] / --session` |
| `src/commands/lut.ts` | `lut inspect`, `lut contract infer/validate` |
| `src/commands/render.ts` | `render preview/candidate/sweep/export` |
| `src/commands/compare.ts` | `compare sheet` |
| `src/commands/metrics.ts` | `metrics compute` |
| `src/commands/manifest.ts` | `manifest verify/show` |
| `src/e2e/fixture.ts` | fixture/artifact discovery + `describeWithFixture` |
| `src/e2e/cli.e2e.test.ts` | in-process agent loop on the DNG fixture |
| `src/e2e/bin.dist.test.ts` | spawns `bin/lmfg.mjs` (skips without dist) |
| `src/**/*.test.ts` | unit tests colocated with modules |

### Modified files

| File | Change |
|---|---|
| `packages/render-engine/src/manifest/render-manifest.ts` | additive optional `RenderParams` fields (D10) |
| `packages/render-engine/src/manifest/canonicalize.test.ts` | round-trip test with the new fields |
| `vitest.config.ts` (root) | aliases for `@lumaforge/luma-raw-runtime/node`, `@lumaforge/luma-jpeg-runtime/node` |
| `package.json` (root) | `test:cli` script; `lint` globs unchanged (already cover `packages/*/src`) |
| `.github/workflows/build.yml` | `cli` job + path filter + gate |
| `AGENTS.md` | Current Architecture entry for `packages/lmfg-cli`; verification row |
| `README.md` | "Command line: lmfg" section |
| `docs/specs/2026-06-23-lmfg-cli-tier0-1-design.md` | status header: Tier 0 shipped, Tier 1 deferred (commit the spec) |

---

## Verification ladder (run at each commit)

- Package-local: `pnpm --filter @lumaforge/lmfg-cli typecheck && pnpm --filter @lumaforge/lmfg-cli test`
- Lint: `pnpm exec eslint "packages/lmfg-cli/src/**/*.ts" "packages/lmfg-cli/*.ts"`
- Before any test run the deps must be built once: `pnpm --filter @lumaforge/luma-color-runtime build && pnpm --filter @lumaforge/luma-jpeg-runtime build && pnpm --filter @lumaforge/luma-raw-runtime build && pnpm --filter @lumaforge/render-engine build` (≈7 s total).
- Closeout: `pnpm lint:check`, `pnpm test:runtime`, `pnpm test:run`, `pnpm --filter @lumaforge/lmfg-cli build`, `pnpm --filter @lumaforge/lmfg-cli pack:dry-run`, `LUMAFORGE_NATIVE_RUNTIME_MODE=prebuilt pnpm build`.

Commit convention: one focused commit per task, no co-authorship metadata; pre-commit runs lint-staged (prettier + eslint --fix).

---

### Task 1: Package scaffold, bin shim, build/test wiring

**Files:**
- Modify: `packages/lmfg-cli/package.json` (scaffolded during planning; keep as-is)
- Modify: `packages/lmfg-cli/tsconfig.json` (scaffolded; verify `paths: {}` present)
- Create: `packages/lmfg-cli/tsconfig.build.json`
- Modify: `packages/lmfg-cli/vite.config.ts` (scaffolded; keep)
- Create: `packages/lmfg-cli/bin/lmfg.mjs`
- Create: `packages/lmfg-cli/src/index.ts`, `packages/lmfg-cli/src/cli.ts` (minimal placeholder that Task 9 replaces)
- Create: `packages/lmfg-cli/src/cli.test.ts`
- Modify: `vitest.config.ts` (root), `package.json` (root)
- Add: `docs/specs/2026-06-23-lmfg-cli-tier0-1-design.md` (untracked spec) to git

- [x] **Step 1: Confirm scaffold contents**

`packages/lmfg-cli/package.json` must contain exactly:

```json
{
  "name": "@lumaforge/lmfg-cli",
  "type": "module",
  "version": "0.1.0",
  "private": false,
  "description": "Agent-friendly, reproducible RAW/LUT rendering CLI for LumaForge.",
  "license": "SEE LICENSE IN LICENSE",
  "bin": { "lmfg": "./bin/lmfg.mjs" },
  "exports": { ".": { "types": "./dist/src/index.d.ts", "import": "./dist/index.js" } },
  "files": ["LICENSE", "README.md", "bin", "dist"],
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "vite build --config vite.config.ts && tsc -p tsconfig.build.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run src",
    "pack:dry-run": "npm pack --dry-run --json"
  },
  "dependencies": {
    "@lumaforge/luma-color-runtime": "workspace:*",
    "@lumaforge/luma-jpeg-runtime": "workspace:*",
    "@lumaforge/luma-native-artifacts": "workspace:*",
    "@lumaforge/luma-raw-runtime": "workspace:*",
    "@lumaforge/render-engine": "workspace:*",
    "commander": "^15.0.0",
    "zod": "^4.4.3"
  }
}
```

`tsconfig.json` (extends root; the `paths: {}` line is mandatory):

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "lib": ["ESNext"],
    "types": ["node"],
    "rootDir": ".",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "paths": {},
    "allowJs": false,
    "strict": true,
    "noImplicitAny": true,
    "declaration": true,
    "declarationMap": true,
    "emitDeclarationOnly": false,
    "noEmit": true,
    "outDir": "dist"
  },
  "include": ["src/**/*"]
}
```

- [x] **Step 2: Add `tsconfig.build.json`, bin shim, and placeholder entries**

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "emitDeclarationOnly": true, "noEmit": false },
  "exclude": ["src/**/*.test.ts", "src/e2e/**"]
}
```

`bin/lmfg.mjs`:

```js
#!/usr/bin/env node
import process from 'node:process'

const { runCli } = await import('../dist/cli.js')
process.exitCode = await runCli(process.argv.slice(2))
```

`src/cli.ts` placeholder (replaced in Task 9):

```ts
export async function runCli(argv: readonly string[]): Promise<number> {
  return argv.length === 0 ? 0 : 0
}
```

`src/index.ts`:

```ts
export { runCli } from './cli'
```

- [x] **Step 3: Write the failing smoke test `src/cli.test.ts`**

```ts
// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { runCli } from './cli'

describe('runCli', () => {
  it('returns exit code 0 for version', async () => {
    const stdout: string[] = []
    const code = await runCli(['version'], {
      stdout: (chunk) => stdout.push(chunk),
      stderr: () => {},
      cwd: process.cwd(),
    })
    expect(code).toBe(0)
    expect(JSON.parse(stdout.join('')).ok).toBe(true)
  })
})
```

- [x] **Step 4: Run it to verify it fails**

Run: `pnpm --filter @lumaforge/lmfg-cli test`
Expected: FAIL (runCli signature mismatch / `stdout.join('')` empty → JSON parse error). This test is satisfied in Task 9; keep it red until then.

- [x] **Step 5: Root wiring**

`vitest.config.ts` alias block, add before the `'@lumaforge/luma-raw-runtime'` entry (order matters: subpath aliases must precede the bare package alias):

```ts
      '@lumaforge/luma-raw-runtime/node': fileURLToPath(
        new URL('./packages/luma-raw-runtime/src/runtime-node.ts', import.meta.url),
      ),
      '@lumaforge/luma-jpeg-runtime/node': fileURLToPath(
        new URL('./packages/luma-jpeg-runtime/src/runtime-node.ts', import.meta.url),
      ),
```

Root `package.json` scripts, add:

```json
    "test:cli": "pnpm --filter @lumaforge/lmfg-cli test",
```

- [x] **Step 6: Verify typecheck and lint pass, then commit**

Run: `pnpm --filter @lumaforge/lmfg-cli typecheck && pnpm exec eslint "packages/lmfg-cli/src/**/*.ts" "packages/lmfg-cli/*.ts" && pnpm install --frozen-lockfile --offline`
Expected: exit 0 (lockfile already contains commander from the scaffold install).

```bash
git add packages/lmfg-cli pnpm-lock.yaml vitest.config.ts package.json docs/specs/2026-06-23-lmfg-cli-tier0-1-design.md docs/plans/2026-09-05-lmfg-cli-tier0-release-plan.md
git commit -m "feat(cli): scaffold @lumaforge/lmfg-cli package and commit CLI spec"
```

---

### Task 2: Protocol — exit codes, errors, envelopes, output writer

**Files:**
- Create: `src/protocol/exit-codes.ts`, `src/protocol/errors.ts`, `src/protocol/envelope.ts`, `src/protocol/output.ts`
- Test: `src/protocol/errors.test.ts`, `src/protocol/output.test.ts`

- [x] **Step 1: Write failing tests**

`src/protocol/errors.test.ts`:

```ts
// @vitest-environment node
import { LumaRawRuntimeError } from '@lumaforge/luma-raw-runtime'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { EXIT_CODES } from './exit-codes'
import { LmfgError, toLmfgError } from './errors'

describe('LmfgError', () => {
  it('maps codes to spec exit codes', () => {
    expect(new LmfgError('args.invalid', { message: 'x' }).exitCode).toBe(EXIT_CODES.invalidArguments)
    expect(new LmfgError('source.unsupported', { message: 'x' }).exitCode).toBe(EXIT_CODES.unsupported)
    expect(new LmfgError('lut.contract.incomplete', { message: 'x' }).exitCode).toBe(EXIT_CODES.lutContract)
    expect(new LmfgError('export.refused', { message: 'x' }).exitCode).toBe(EXIT_CODES.exportRefused)
    expect(new LmfgError('cancelled', { message: 'x' }).exitCode).toBe(EXIT_CODES.cancelled)
    expect(new LmfgError('internal', { message: 'x' }).exitCode).toBe(EXIT_CODES.internal)
  })

  it('serializes to the error envelope', () => {
    const error = new LmfgError('lut.contract.incomplete', {
      message: 'LUT contract is incomplete.',
      retryable: true,
      suggestedNextActions: ['lmfg lut contract infer --lut look.cube'],
      details: { resolution: 'recommended' },
    })
    expect(error.toEnvelope()).toEqual({
      schema: 'lmfg.error.v1',
      ok: false,
      error: {
        code: 'lut.contract.incomplete',
        message: 'LUT contract is incomplete.',
        retryable: true,
        suggested_next_actions: ['lmfg lut contract infer --lut look.cube'],
        details: { resolution: 'recommended' },
      },
    })
  })
})

describe('toLmfgError', () => {
  it('passes LmfgError through', () => {
    const error = new LmfgError('render.failed', { message: 'boom' })
    expect(toLmfgError(error)).toBe(error)
  })

  it('maps zod errors to schema.invalid with issue details', () => {
    const result = z.object({ a: z.number() }).safeParse({ a: 'x' })
    const error = toLmfgError(result.error)
    expect(error.code).toBe('schema.invalid')
    expect(error.exitCode).toBe(2)
    expect(error.details?.issues).toBeInstanceOf(Array)
  })

  it('maps RAW runtime errors', () => {
    expect(toLmfgError(new LumaRawRuntimeError('RAW_UNSUPPORTED_FORMAT', 'nope')).code).toBe('source.unsupported')
    expect(toLmfgError(new LumaRawRuntimeError('RAW_JOB_CANCELLED', 'nope')).code).toBe('cancelled')
    expect(toLmfgError(new LumaRawRuntimeError('RAW_MEMORY_LIMIT', 'nope')).code).toBe('render.failed')
    expect(toLmfgError(new LumaRawRuntimeError('RAW_RUNTIME_UNAVAILABLE', 'nope')).code).toBe('runtime.unavailable')
  })

  it('maps engine sentinel messages and abort errors', () => {
    expect(toLmfgError(new Error('FULL_RES_EXPORT_UNSUPPORTED_SOURCE')).code).toBe('source.export_unsupported')
    expect(toLmfgError(new Error('FULL_RES_EXPORT_UNSUPPORTED_PIPELINE')).code).toBe('lut.contract.incomplete')
    expect(toLmfgError(new Error('FULL_RES_EXPORT_CANCELLED')).code).toBe('cancelled')
    expect(toLmfgError(new Error('FULL_RES_EXPORT_RESOURCE_FAILURE')).code).toBe('render.failed')
    const abort = new Error('aborted')
    abort.name = 'AbortError'
    expect(toLmfgError(abort).code).toBe('cancelled')
    expect(toLmfgError('weird').code).toBe('internal')
  })
})
```

`src/protocol/output.test.ts`:

```ts
// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { LmfgError } from './errors'
import { successEnvelope } from './envelope'
import { Output } from './output'

function capture() {
  const out: string[] = []
  const err: string[] = []
  return { out, err, io: { stdout: (s: string) => out.push(s), stderr: (s: string) => err.push(s) } }
}

describe('Output json mode', () => {
  it('writes one envelope and logs to stderr', () => {
    const c = capture()
    const output = new Output({ emit: 'json', quiet: false, color: false, ...c.io })
    output.log('working')
    output.event({ event: 'candidate.ready', candidate_id: 'cand_0001' })
    output.result(successEnvelope('lmfg.version.v1', { lmfg: '0.1.0' }))
    expect(c.out).toEqual([`${JSON.stringify({ schema: 'lmfg.version.v1', ok: true, result: { lmfg: '0.1.0' } })}\n`])
    expect(c.err).toEqual(['working\n'])
  })

  it('suppresses stderr when quiet', () => {
    const c = capture()
    const output = new Output({ emit: 'json', quiet: true, color: false, ...c.io })
    output.log('hidden')
    expect(c.err).toEqual([])
  })
})

describe('Output ndjson mode', () => {
  it('streams events and terminates with completed', () => {
    const c = capture()
    const output = new Output({ emit: 'ndjson', quiet: true, color: false, ...c.io })
    output.event({ event: 'started', command: 'render.sweep' })
    output.result(successEnvelope('lmfg.render.sweep.v1', { iteration_id: 'iter_0001' }))
    const lines = c.out.join('').trimEnd().split('\n').map((line) => JSON.parse(line))
    expect(lines[0]).toEqual({ event: 'started', command: 'render.sweep', schema: 'lmfg.event.v1' })
    expect(lines[1]).toEqual({
      event: 'completed',
      ok: true,
      schema: 'lmfg.event.v1',
      result_schema: 'lmfg.render.sweep.v1',
      result: { iteration_id: 'iter_0001' },
    })
  })

  it('terminates with a failed completed event on error', () => {
    const c = capture()
    const output = new Output({ emit: 'ndjson', quiet: true, color: false, ...c.io })
    output.error(new LmfgError('render.failed', { message: 'boom' }))
    const line = JSON.parse(c.out.join('').trim())
    expect(line.event).toBe('completed')
    expect(line.ok).toBe(false)
    expect(line.error.code).toBe('render.failed')
  })
})
```

- [x] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @lumaforge/lmfg-cli test`
Expected: FAIL — modules not found.

- [x] **Step 3: Implement**

`src/protocol/exit-codes.ts`:

```ts
// Spec §4.4 exit codes.
export const EXIT_CODES = {
  ok: 0,
  failure: 1,
  invalidArguments: 2,
  unsupported: 3,
  lutContract: 4,
  permission: 5,
  fetch: 6,
  render: 7,
  exportRefused: 8,
  cancelled: 9,
  internal: 10,
} as const

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES]
```

`src/protocol/errors.ts`:

```ts
import { LumaRawRuntimeError } from '@lumaforge/luma-raw-runtime'
import { ZodError } from 'zod'

import type { ExitCode } from './exit-codes'
import { EXIT_CODES } from './exit-codes'

export type LmfgErrorCode =
  | 'args.invalid'
  | 'schema.invalid'
  | 'file.not_found'
  | 'session.not_found'
  | 'iteration.not_found'
  | 'candidate.not_found'
  | 'source.unsupported'
  | 'source.export_unsupported'
  | 'tier.unavailable'
  | 'runtime.unavailable'
  | 'lut.parse_failed'
  | 'lut.contract.incomplete'
  | 'lut.contract.unsupported_output'
  | 'lut.contract.invalid'
  | 'permission.denied'
  | 'network.not_allowed'
  | 'fetch.failed'
  | 'hash.mismatch'
  | 'render.failed'
  | 'export.refused'
  | 'cancelled'
  | 'timeout'
  | 'manifest.invalid'
  | 'internal'

const EXIT_BY_CODE: Record<LmfgErrorCode, ExitCode> = {
  'args.invalid': EXIT_CODES.invalidArguments,
  'schema.invalid': EXIT_CODES.invalidArguments,
  'file.not_found': EXIT_CODES.invalidArguments,
  'session.not_found': EXIT_CODES.invalidArguments,
  'iteration.not_found': EXIT_CODES.invalidArguments,
  'candidate.not_found': EXIT_CODES.invalidArguments,
  'lut.parse_failed': EXIT_CODES.invalidArguments,
  'source.unsupported': EXIT_CODES.unsupported,
  'source.export_unsupported': EXIT_CODES.unsupported,
  'tier.unavailable': EXIT_CODES.unsupported,
  'runtime.unavailable': EXIT_CODES.unsupported,
  'lut.contract.incomplete': EXIT_CODES.lutContract,
  'lut.contract.unsupported_output': EXIT_CODES.lutContract,
  'lut.contract.invalid': EXIT_CODES.lutContract,
  'permission.denied': EXIT_CODES.permission,
  'network.not_allowed': EXIT_CODES.permission,
  'fetch.failed': EXIT_CODES.fetch,
  'hash.mismatch': EXIT_CODES.fetch,
  'render.failed': EXIT_CODES.render,
  'export.refused': EXIT_CODES.exportRefused,
  cancelled: EXIT_CODES.cancelled,
  timeout: EXIT_CODES.cancelled,
  'manifest.invalid': EXIT_CODES.failure,
  internal: EXIT_CODES.internal,
}

export type LmfgErrorInit = {
  message: string
  retryable?: boolean
  suggestedNextActions?: readonly string[]
  details?: Record<string, unknown>
  cause?: unknown
}

export type ErrorEnvelope = {
  schema: 'lmfg.error.v1'
  ok: false
  error: {
    code: LmfgErrorCode
    message: string
    retryable: boolean
    suggested_next_actions: string[]
    details?: Record<string, unknown>
  }
}

export class LmfgError extends Error {
  readonly code: LmfgErrorCode
  readonly exitCode: ExitCode
  readonly retryable: boolean
  readonly suggestedNextActions: string[]
  readonly details?: Record<string, unknown>

  constructor(code: LmfgErrorCode, init: LmfgErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause })
    this.name = 'LmfgError'
    this.code = code
    this.exitCode = EXIT_BY_CODE[code]
    this.retryable = init.retryable ?? false
    this.suggestedNextActions = [...(init.suggestedNextActions ?? [])]
    this.details = init.details
  }

  toEnvelope(): ErrorEnvelope {
    return {
      schema: 'lmfg.error.v1',
      ok: false,
      error: {
        code: this.code,
        message: this.message,
        retryable: this.retryable,
        suggested_next_actions: this.suggestedNextActions,
        ...(this.details ? { details: this.details } : {}),
      },
    }
  }
}

const RAW_CODE_MAP: Record<string, LmfgErrorCode> = {
  RAW_RUNTIME_UNAVAILABLE: 'runtime.unavailable',
  RAW_CROSS_ORIGIN_ISOLATION_REQUIRED: 'runtime.unavailable',
  RAW_UNSUPPORTED_FORMAT: 'source.unsupported',
  RAW_OPEN_FAILED: 'source.unsupported',
  RAW_METADATA_FAILED: 'source.unsupported',
  RAW_THUMBNAIL_UNAVAILABLE: 'render.failed',
  RAW_QUICK_DECODE_FAILED: 'render.failed',
  RAW_HQ_DECODE_FAILED: 'render.failed',
  RAW_MEMORY_LIMIT: 'render.failed',
  RAW_JOB_CANCELLED: 'cancelled',
  RAW_WORKER_PROTOCOL_ERROR: 'internal',
}

const MESSAGE_CODE_MAP: Array<[pattern: RegExp, code: LmfgErrorCode]> = [
  [/^FULL_RES_EXPORT_UNSUPPORTED_SOURCE$/, 'source.export_unsupported'],
  [/^FULL_RES_EXPORT_UNSUPPORTED_PIPELINE$/, 'lut.contract.incomplete'],
  [/^FULL_RES_EXPORT_CANCELLED$/, 'cancelled'],
  [/^CANDIDATE_RENDER_ABORTED$/, 'cancelled'],
  [/^FULL_RES_EXPORT_RESOURCE_FAILURE$/, 'render.failed'],
  [/^JPEG_/, 'render.failed'],
  [/^LUMA_JPEG_/, 'render.failed'],
  [/^PREVIEW_JPEG_ENCODE_/, 'render.failed'],
  [/^CONTACT_SHEET_/, 'render.failed'],
]

export function toLmfgError(error: unknown): LmfgError {
  if (error instanceof LmfgError) return error
  if (error instanceof ZodError) {
    return new LmfgError('schema.invalid', {
      message: 'Input failed schema validation.',
      details: {
        issues: error.issues.map((issue) => ({
          path: issue.path.map(String).join('.'),
          message: issue.message,
          code: issue.code,
        })),
      },
      cause: error,
    })
  }
  if (error instanceof LumaRawRuntimeError) {
    const code = RAW_CODE_MAP[error.code] ?? 'internal'
    return new LmfgError(code, {
      message: error.message,
      retryable: code === 'render.failed',
      details: { runtime_code: error.code },
      cause: error,
    })
  }
  if (error instanceof Error) {
    if (error.name === 'AbortError' || error.name === 'TimeoutError') {
      return new LmfgError('cancelled', { message: error.message || 'Operation was cancelled.', cause: error })
    }
    for (const [pattern, code] of MESSAGE_CODE_MAP) {
      if (pattern.test(error.message)) {
        return new LmfgError(code, { message: error.message, retryable: code === 'render.failed', cause: error })
      }
    }
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return new LmfgError('file.not_found', { message: error.message, cause: error })
    }
    if ((error as NodeJS.ErrnoException).code === 'EACCES' || (error as NodeJS.ErrnoException).code === 'EPERM') {
      return new LmfgError('permission.denied', { message: error.message, cause: error })
    }
    return new LmfgError('internal', { message: error.message || 'Internal error.', cause: error })
  }
  return new LmfgError('internal', { message: typeof error === 'string' ? error : 'Internal error.', cause: error })
}
```

`src/protocol/envelope.ts`:

```ts
import type { ErrorEnvelope, LmfgError } from './errors'

export type SuccessEnvelope<T> = {
  schema: string
  ok: true
  result: T
}

export type Envelope<T> = SuccessEnvelope<T> | ErrorEnvelope

export function successEnvelope<T>(schema: string, result: T): SuccessEnvelope<T> {
  return { schema, ok: true, result }
}

export function errorEnvelope(error: LmfgError): ErrorEnvelope {
  return error.toEnvelope()
}
```

`src/protocol/output.ts`:

```ts
import type { SuccessEnvelope } from './envelope'
import type { LmfgError } from './errors'

export type EmitMode = 'json' | 'ndjson'

export type OutputIo = {
  stdout: (chunk: string) => void
  stderr: (chunk: string) => void
}

export type OutputOptions = OutputIo & {
  emit: EmitMode
  quiet: boolean
  color: boolean
}

export type LmfgEvent = { event: string } & Record<string, unknown>

export const EVENT_SCHEMA = 'lmfg.event.v1'

export class Output {
  readonly emit: EmitMode
  private readonly quiet: boolean
  private readonly io: OutputIo

  constructor(options: OutputOptions) {
    this.emit = options.emit
    this.quiet = options.quiet
    this.io = { stdout: options.stdout, stderr: options.stderr }
  }

  /** Progress event. Streamed in ndjson mode; a one-line stderr note in json mode. */
  event(event: LmfgEvent): void {
    if (this.emit === 'ndjson') {
      this.io.stdout(`${JSON.stringify({ ...event, schema: EVENT_SCHEMA })}\n`)
      return
    }
    this.log(`[${event.event}]${describeEvent(event)}`)
  }

  result<T>(envelope: SuccessEnvelope<T>): void {
    if (this.emit === 'ndjson') {
      this.io.stdout(
        `${JSON.stringify({ event: 'completed', ok: true, schema: EVENT_SCHEMA, result_schema: envelope.schema, result: envelope.result })}\n`,
      )
      return
    }
    this.io.stdout(`${JSON.stringify(envelope)}\n`)
  }

  error(error: LmfgError): void {
    const envelope = error.toEnvelope()
    if (this.emit === 'ndjson') {
      this.io.stdout(`${JSON.stringify({ event: 'completed', ok: false, schema: EVENT_SCHEMA, error: envelope.error })}\n`)
      return
    }
    this.io.stdout(`${JSON.stringify(envelope)}\n`)
  }

  /** Human diagnostics; never on stdout. */
  log(message: string): void {
    if (this.quiet) return
    this.io.stderr(`${message}\n`)
  }
}

function describeEvent(event: LmfgEvent): string {
  const parts = Object.entries(event)
    .filter(([key]) => key !== 'event' && key !== 'schema')
    .map(([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : String(value)}`)
  return parts.length > 0 ? ` ${parts.join(' ')}` : ''
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @lumaforge/lmfg-cli test`
Expected: `errors.test.ts` and `output.test.ts` PASS (`cli.test.ts` still red until Task 9).

- [x] **Step 5: Commit**

```bash
git add packages/lmfg-cli/src/protocol
git commit -m "feat(cli): add lmfg protocol envelopes, error codes, and output writer"
```

---

### Task 3: Schemas — params, plans, results, registry (zod → JSON Schema)

**Files:**
- Create: `src/schemas/params.ts`, `src/schemas/plan.ts`, `src/schemas/results.ts`, `src/schemas/registry.ts`
- Test: `src/schemas/params.test.ts`, `src/schemas/plan.test.ts`, `src/schemas/registry.test.ts`

- [x] **Step 1: Write failing tests**

`src/schemas/params.test.ts`:

```ts
// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { mergeRenderParams, parseRenderParams, RenderParamsOverrideSchema } from './params'

describe('parseRenderParams', () => {
  it('fills defaults', () => {
    expect(parseRenderParams({})).toEqual({
      exposure_ev: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0,
      temperature: 0, tint: 0, saturation: 0, vibrance: 0, intensity: 1,
      raw_render_exposure: 'auto', lut: null,
    })
  })

  it('rejects unknown keys and out-of-range values', () => {
    expect(() => parseRenderParams({ exposure: 1 })).toThrow()
    expect(() => parseRenderParams({ exposure_ev: 9 })).toThrow()
    expect(() => parseRenderParams({ intensity: 2 })).toThrow()
  })

  it('accepts a LUT reference with a contract', () => {
    const params = parseRenderParams({
      lut: { path: 'look.cube', contract: { role: 'combined-look-output', input_profile: 'panasonic-vgamut-vlog', output_gamut: 'srgb-rec709', output_transfer: 'bt709', output_range: 'full' } },
    })
    expect(params.lut?.path).toBe('look.cube')
    expect(params.lut?.contract?.role).toBe('combined-look-output')
  })

  it('merges overrides without touching untouched keys', () => {
    const base = parseRenderParams({ contrast: 10 })
    const merged = mergeRenderParams(base, RenderParamsOverrideSchema.parse({ exposure_ev: 1 }))
    expect(merged.contrast).toBe(10)
    expect(merged.exposure_ev).toBe(1)
    expect(base.exposure_ev).toBe(0)
  })
})
```

`src/schemas/plan.test.ts`:

```ts
// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { expandSweepPlan, MAX_CANDIDATES_PER_SWEEP, normalizeCandidatePlan } from './plan'

describe('normalizeCandidatePlan', () => {
  it('assigns sequential ids and merges base params', () => {
    const plan = normalizeCandidatePlan({
      base: { contrast: 20 },
      candidates: [{ params: { exposure_ev: -1 } }, { id: 'warm', tag: 'warm', params: { temperature: 30 } }],
    })
    expect(plan.candidates.map((c) => c.id)).toEqual(['cand_0001', 'warm'])
    expect(plan.candidates[0].params).toMatchObject({ exposure_ev: -1, contrast: 20 })
    expect(plan.candidates[1].params).toMatchObject({ temperature: 30, contrast: 20 })
    expect(plan.candidates[1].tag).toBe('warm')
  })

  it('rejects duplicate ids', () => {
    expect(() =>
      normalizeCandidatePlan({ candidates: [{ id: 'a', params: {} }, { id: 'a', params: {} }] }),
    ).toThrow(/duplicate/i)
  })
})

describe('expandSweepPlan', () => {
  it('expands axes as a cartesian product in declaration order', () => {
    const plan = expandSweepPlan({ base: { contrast: 5 }, axes: { exposure_ev: [-1, 1], temperature: [0, 20, 40] } })
    expect(plan.candidates).toHaveLength(6)
    expect(plan.candidates[0]).toMatchObject({ id: 'cand_0001', tag: 'exposure_ev=-1,temperature=0' })
    expect(plan.candidates[1].params).toMatchObject({ exposure_ev: -1, temperature: 20, contrast: 5 })
    expect(plan.candidates[5].params).toMatchObject({ exposure_ev: 1, temperature: 40 })
  })

  it('caps the sweep size', () => {
    const values = Array.from({ length: 9 }, (_, i) => i)
    expect(() => expandSweepPlan({ axes: { exposure_ev: values, contrast: values } })).toThrow(
      new RegExp(String(MAX_CANDIDATES_PER_SWEEP)),
    )
  })
})
```

`src/schemas/registry.test.ts`:

```ts
// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { listSchemas, showSchema } from './registry'

describe('schema registry', () => {
  it('lists every public schema id', () => {
    const ids = listSchemas().map((entry) => entry.id)
    for (const id of [
      'lmfg.version.v1', 'lmfg.capabilities.v1', 'lmfg.schema.list.v1', 'lmfg.schema.show.v1',
      'lmfg.session.v1', 'lmfg.session.status.v1', 'lmfg.session.list.v1', 'lmfg.inspect.v1',
      'lmfg.lut.inspect.v1', 'lmfg.lut.contract.infer.v1', 'lmfg.lut.contract.validate.v1',
      'lmfg.params.v1', 'lmfg.plan.v1', 'lmfg.sweep.v1', 'lmfg.contract.v1',
      'lmfg.render.preview.v1', 'lmfg.render.candidate.v1', 'lmfg.render.sweep.v1', 'lmfg.render.export.v1',
      'lmfg.compare.sheet.v1', 'lmfg.metrics.v1', 'lmfg.metrics.compute.v1',
      'lmfg.manifest.verify.v1', 'lmfg.manifest.show.v1', 'lmfg.dry-run.v1', 'lmfg.error.v1', 'lmfg.event.v1',
    ]) {
      expect(ids, id).toContain(id)
    }
  })

  it('renders JSON Schema draft 2020-12 for params', () => {
    const shown = showSchema('lmfg.params.v1')
    expect(shown).not.toBeNull()
    expect(shown!.json_schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema')
    expect((shown!.json_schema.properties as Record<string, unknown>).exposure_ev).toBeDefined()
  })

  it('returns null for unknown ids', () => {
    expect(showSchema('lmfg.nope.v9')).toBeNull()
  })
})
```

- [x] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @lumaforge/lmfg-cli test src/schemas`
Expected: FAIL — modules not found.

- [x] **Step 3: Implement `src/schemas/params.ts`**

```ts
import { z } from 'zod'

export const LUT_ROLES = ['display-look', 'scene-creative', 'technical-output', 'combined-look-output'] as const
export const SIGNAL_RANGES = ['full', 'legal', 'unknown'] as const

export const LutContractInputSchema = z.strictObject({
  role: z.enum(LUT_ROLES),
  input_profile: z.string().min(1).optional(),
  input_gamut: z.string().min(1).optional(),
  input_transfer: z.string().min(1).optional(),
  input_range: z.enum(SIGNAL_RANGES).optional(),
  output_gamut: z.string().min(1).optional(),
  output_transfer: z.string().min(1).optional(),
  output_range: z.enum(SIGNAL_RANGES).optional(),
})

export const LutReferenceSchema = z.strictObject({
  path: z.string().min(1),
  contract: LutContractInputSchema.optional(),
})

const slider = (min: number, max: number) => z.number().min(min).max(max)

/** Field schemas without defaults — shared by the full and override shapes. */
const PARAM_FIELDS = {
  exposure_ev: slider(-5, 5),
  contrast: slider(-100, 100),
  highlights: slider(-100, 100),
  shadows: slider(-100, 100),
  whites: slider(-100, 100),
  blacks: slider(-100, 100),
  temperature: slider(-100, 100),
  tint: slider(-100, 100),
  saturation: slider(-100, 100),
  vibrance: slider(-100, 100),
  intensity: z.number().min(0).max(1),
  raw_render_exposure: z.union([z.literal('auto'), slider(-3, 3)]),
  lut: LutReferenceSchema.nullable(),
} as const

export const PARAM_DEFAULTS = {
  exposure_ev: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0,
  temperature: 0, tint: 0, saturation: 0, vibrance: 0, intensity: 1,
  raw_render_exposure: 'auto' as const, lut: null,
}

export const NUMERIC_PARAM_KEYS = [
  'exposure_ev', 'contrast', 'highlights', 'shadows', 'whites', 'blacks',
  'temperature', 'tint', 'saturation', 'vibrance', 'intensity',
] as const
export type NumericParamKey = (typeof NUMERIC_PARAM_KEYS)[number]

export const RenderParamsSchema = z.strictObject({
  schema: z.literal('lmfg.params.v1').optional(),
  exposure_ev: PARAM_FIELDS.exposure_ev.default(PARAM_DEFAULTS.exposure_ev),
  contrast: PARAM_FIELDS.contrast.default(PARAM_DEFAULTS.contrast),
  highlights: PARAM_FIELDS.highlights.default(PARAM_DEFAULTS.highlights),
  shadows: PARAM_FIELDS.shadows.default(PARAM_DEFAULTS.shadows),
  whites: PARAM_FIELDS.whites.default(PARAM_DEFAULTS.whites),
  blacks: PARAM_FIELDS.blacks.default(PARAM_DEFAULTS.blacks),
  temperature: PARAM_FIELDS.temperature.default(PARAM_DEFAULTS.temperature),
  tint: PARAM_FIELDS.tint.default(PARAM_DEFAULTS.tint),
  saturation: PARAM_FIELDS.saturation.default(PARAM_DEFAULTS.saturation),
  vibrance: PARAM_FIELDS.vibrance.default(PARAM_DEFAULTS.vibrance),
  intensity: PARAM_FIELDS.intensity.default(PARAM_DEFAULTS.intensity),
  raw_render_exposure: PARAM_FIELDS.raw_render_exposure.default(PARAM_DEFAULTS.raw_render_exposure),
  lut: PARAM_FIELDS.lut.default(PARAM_DEFAULTS.lut),
}).transform(({ schema: _schema, ...rest }) => rest)

export const RenderParamsOverrideSchema = z.strictObject({
  exposure_ev: PARAM_FIELDS.exposure_ev.optional(),
  contrast: PARAM_FIELDS.contrast.optional(),
  highlights: PARAM_FIELDS.highlights.optional(),
  shadows: PARAM_FIELDS.shadows.optional(),
  whites: PARAM_FIELDS.whites.optional(),
  blacks: PARAM_FIELDS.blacks.optional(),
  temperature: PARAM_FIELDS.temperature.optional(),
  tint: PARAM_FIELDS.tint.optional(),
  saturation: PARAM_FIELDS.saturation.optional(),
  vibrance: PARAM_FIELDS.vibrance.optional(),
  intensity: PARAM_FIELDS.intensity.optional(),
  raw_render_exposure: PARAM_FIELDS.raw_render_exposure.optional(),
  lut: PARAM_FIELDS.lut.optional(),
})

export type RenderParamsInput = z.input<typeof RenderParamsSchema>
export type RenderParams = z.output<typeof RenderParamsSchema>
export type RenderParamsOverride = z.output<typeof RenderParamsOverrideSchema>
export type LutReference = z.output<typeof LutReferenceSchema>
export type LutContractInput = z.output<typeof LutContractInputSchema>

export function parseRenderParams(input: unknown): RenderParams {
  return RenderParamsSchema.parse(input ?? {})
}

export function mergeRenderParams(base: RenderParams, override: RenderParamsOverride): RenderParams {
  const merged: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(override)) {
    if (value !== undefined) merged[key] = value
  }
  return RenderParamsSchema.parse(merged)
}
```

- [x] **Step 4: Implement `src/schemas/plan.ts`**

```ts
import { z } from 'zod'

import { LmfgError } from '../protocol/errors'
import { formatCandidateId } from '../workspace/ids'
import type { RenderParams } from './params'
import {
  mergeRenderParams, NUMERIC_PARAM_KEYS, parseRenderParams, RenderParamsOverrideSchema, RenderParamsSchema,
} from './params'

export const MAX_CANDIDATES_PER_SWEEP = 64
export const MAX_AXIS_VALUES = 16

export const ContactSheetOptionsSchema = z.strictObject({
  cols: z.int().min(1).max(12).optional(),
  tile_width: z.int().min(64).max(1024).optional(),
  gap: z.int().min(0).max(64).optional(),
})

export const CandidateSpecSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/i).optional(),
  tag: z.string().max(64).optional(),
  params: RenderParamsOverrideSchema.optional(),
})

export const CandidatePlanSchema = z.strictObject({
  schema: z.literal('lmfg.plan.v1').optional(),
  base: RenderParamsSchema.optional(),
  candidates: z.array(CandidateSpecSchema).min(1).max(MAX_CANDIDATES_PER_SWEEP),
  contact_sheet: ContactSheetOptionsSchema.optional(),
})

export const SweepPlanSchema = z.strictObject({
  schema: z.literal('lmfg.sweep.v1').optional(),
  base: RenderParamsSchema.optional(),
  axes: z.record(z.enum(NUMERIC_PARAM_KEYS), z.array(z.number()).min(1).max(MAX_AXIS_VALUES)),
  contact_sheet: ContactSheetOptionsSchema.optional(),
})

export type ContactSheetOptions = z.output<typeof ContactSheetOptionsSchema>
export type CandidatePlanInput = z.input<typeof CandidatePlanSchema>
export type SweepPlanInput = z.input<typeof SweepPlanSchema>

export type NormalizedCandidate = {
  id: string
  tag: string | null
  params: RenderParams
}

export type NormalizedPlan = {
  kind: 'candidate' | 'sweep'
  base: RenderParams
  candidates: NormalizedCandidate[]
  contactSheet: ContactSheetOptions | null
}

export function normalizeCandidatePlan(input: unknown): NormalizedPlan {
  const plan = CandidatePlanSchema.parse(input)
  const base = plan.base ?? parseRenderParams({})
  const seen = new Set<string>()
  const candidates = plan.candidates.map((spec, index) => {
    const id = spec.id ?? formatCandidateId(index + 1)
    if (seen.has(id)) {
      throw new LmfgError('args.invalid', { message: `Duplicate candidate id "${id}" in plan.` })
    }
    seen.add(id)
    return {
      id,
      tag: spec.tag ?? null,
      params: spec.params ? mergeRenderParams(base, spec.params) : base,
    }
  })
  return { kind: 'candidate', base, candidates, contactSheet: plan.contact_sheet ?? null }
}

export function expandSweepPlan(input: unknown): NormalizedPlan {
  const plan = SweepPlanSchema.parse(input)
  const base = plan.base ?? parseRenderParams({})
  const axes = Object.entries(plan.axes) as Array<[string, number[]]>
  if (axes.length === 0) {
    throw new LmfgError('args.invalid', { message: 'Sweep plan must declare at least one axis.' })
  }
  const total = axes.reduce((count, [, values]) => count * values.length, 1)
  if (total > MAX_CANDIDATES_PER_SWEEP) {
    throw new LmfgError('args.invalid', {
      message: `Sweep expands to ${total} candidates; the limit is ${MAX_CANDIDATES_PER_SWEEP}.`,
    })
  }
  const combos: Array<Array<[string, number]>> = [[]]
  for (const [key, values] of axes) {
    const next: Array<Array<[string, number]>> = []
    for (const combo of combos) for (const value of values) next.push([...combo, [key, value]])
    combos.splice(0, combos.length, ...next)
  }
  const candidates = combos.map((combo, index) => ({
    id: formatCandidateId(index + 1),
    tag: combo.map(([key, value]) => `${key}=${value}`).join(','),
    params: mergeRenderParams(base, RenderParamsOverrideSchema.parse(Object.fromEntries(combo))),
  }))
  return { kind: 'sweep', base, candidates, contactSheet: plan.contact_sheet ?? null }
}
```

- [x] **Step 5: Implement `src/schemas/results.ts`**

```ts
import { z } from 'zod'

import { LutContractInputSchema } from './params'

const sha256 = z.string().regex(/^[0-9a-f]{64}$/)
const dims = z.object({ width: z.int().positive(), height: z.int().positive() })
const nullableString = z.string().nullable()
const nullableNumber = z.number().nullable()

export const NativeArtifactsSchema = z.object({
  build_id: z.string(),
  variant: z.enum(['desktop', 'low-memory']),
})

export const RuntimeVersionsSchema = z.object({
  luma_raw_runtime: z.string(),
  luma_color_runtime: z.string(),
  luma_jpeg_runtime: z.string(),
  render_engine: z.string(),
  native_artifacts: NativeArtifactsSchema,
})

export const VersionResultSchema = z.object({
  lmfg: z.string(),
  node: z.string(),
  platform: z.string(),
  arch: z.string(),
  runtime_versions: RuntimeVersionsSchema,
})

export const CapabilitiesResultSchema = z.object({
  render_tiers: z.object({
    cpu_wasm: z.object({
      available: z.boolean(),
      memory_profile: z.enum(['desktop', 'low-memory']),
      supports: z.array(z.string()),
      artifacts: z.object({ raw_wasm: z.boolean(), jpeg_wasm: z.boolean() }),
      reason: z.string().optional(),
    }),
    browser_bridge: z.object({
      available: z.boolean(),
      supports: z.array(z.string()),
      reason: z.string().optional(),
    }),
  }),
  active_tier: z.enum(['cpu_wasm']),
  fallback_order: z.array(z.string()),
  runtime_versions: RuntimeVersionsSchema,
  limits: z.object({
    max_candidates_per_sweep: z.int(),
    quick_preview_max_pixels: z.int(),
    bounded_hq_max_pixels: z.int(),
  }),
})

export const SchemaListResultSchema = z.object({
  schemas: z.array(z.object({ id: z.string(), description: z.string() })),
})

export const SchemaShowResultSchema = z.object({
  id: z.string(),
  description: z.string(),
  json_schema: z.record(z.string(), z.unknown()),
})

export const SessionSourceSchema = z.object({
  path: z.string(),
  filename: z.string(),
  byte_size: z.int().nonnegative(),
  sha256,
})

export const SessionRecordSchema = z.object({
  schema: z.literal('lmfg.session.v1'),
  id: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  workspace_root: z.string(),
  source: SessionSourceSchema,
  decoded_dimensions: dims.nullable(),
  counters: z.object({ previews: z.int(), iterations: z.int(), exports: z.int() }),
  status: z.enum(['initialized', 'inspected']),
})

export const SessionStatusResultSchema = SessionRecordSchema.extend({
  session_dir: z.string(),
  source_present: z.boolean(),
  iterations: z.array(
    z.object({
      id: z.string(),
      created_at: z.string(),
      kind: z.enum(['candidate', 'sweep']),
      candidate_count: z.int(),
      contact_sheet: z.boolean(),
    }),
  ),
  previews: z.array(z.string()),
  exports: z.array(z.object({ name: z.string(), output_uri: z.string(), manifest_uri: z.string() })),
})

export const SessionListResultSchema = z.object({
  workspace_root: z.string(),
  sessions: z.array(SessionRecordSchema),
})

export const ExposureSchema = z.object({
  ev: z.number(),
  multiplier: z.number(),
  source: z.enum(['dng-baseline', 'image-statistics', 'identity', 'user']),
})

export const InspectResultSchema = z.object({
  session_id: nullableString,
  source: SessionSourceSchema,
  metadata: z.object({
    make: nullableString, model: nullableString, lens: nullableString,
    iso: nullableNumber, aperture: nullableNumber, focal_length: nullableNumber, shutter: nullableNumber,
    timestamp: nullableNumber, orientation: nullableNumber,
    width: nullableNumber, height: nullableNumber, raw_width: nullableNumber, raw_height: nullableNumber,
    baseline_exposure: nullableNumber,
    support_level: z.enum(['official', 'experimental', 'unsupported']),
  }),
  decoded_dimensions: dims,
  embedded_preview: z.object({ width: z.int(), height: z.int(), mime_type: z.string(), byte_size: z.int(), uri: z.string() }).nullable(),
  export_capability: z.object({
    supported: z.boolean(),
    strategy: nullableString,
    width: z.int(),
    height: z.int(),
    reasons: z.array(z.string()),
  }),
  raw_render_exposure: ExposureSchema,
  timings_ms: z.record(z.string(), z.number()),
})

export const LutProfileOutputSchema = z.object({
  profile_id: z.string(),
  label: z.string(),
  role: z.string(),
  input_gamut: z.string(),
  input_transfer: z.string(),
  input_range: z.string(),
  output_gamut: nullableString,
  output_transfer: nullableString,
  output_range: nullableString,
})

export const LutResolutionSchema = z.object({
  kind: z.enum(['confirmed', 'recommended', 'unknown', 'unsupported-output']),
  confidence: z.enum(['metadata', 'user', 'persisted-user']).optional(),
  profile: LutProfileOutputSchema.optional(),
  recommendations: z.array(LutProfileOutputSchema).optional(),
})

const tuple3 = z.tuple([z.number(), z.number(), z.number()])

export const LutInspectResultSchema = z.object({
  path: z.string(),
  filename: z.string(),
  sha256,
  byte_size: z.int(),
  title: z.string(),
  size: z.int(),
  domain_min: tuple3,
  domain_max: tuple3,
  comments: z.array(z.string()),
  fingerprint: z.string(),
  valid: z.boolean(),
  validation_errors: z.array(z.string()),
  resolution: LutResolutionSchema,
})

export const LutContractInferResultSchema = z.object({
  path: z.string(),
  sha256,
  resolution: LutResolutionSchema,
  complete: z.boolean(),
  contract: LutContractInputSchema.nullable(),
  suggested_contracts: z.array(LutContractInputSchema),
  message: z.string(),
})

export const LutContractValidateResultSchema = z.object({
  path: z.string(),
  sha256,
  valid: z.boolean(),
  issues: z.array(z.string()),
  contract: LutContractInputSchema.nullable(),
  profile: LutProfileOutputSchema.nullable(),
  export_supported: z.boolean(),
  export_reason: nullableString,
})

export const RenderOutputSchema = z.object({
  uri: z.string(),
  path: z.string(),
  width: z.int(),
  height: z.int(),
  byte_size: z.int(),
  sha256,
  quality: z.int().min(1).max(100),
})

export const PreviewResultSchema = z.object({
  session_id: z.string(),
  preview_id: z.string(),
  output: RenderOutputSchema,
  manifest_uri: z.string(),
  manifest_sha256: sha256,
  decode: z.enum(['quick', 'bounded-hq']),
  raw_render_exposure: ExposureSchema,
  color_graph_fingerprint: sha256,
  timings_ms: z.record(z.string(), z.number()),
})

export const CandidateSummarySchema = z.object({
  id: z.string(),
  index: z.int(),
  tag: nullableString,
  preview_uri: z.string(),
  manifest_uri: z.string(),
  manifest_sha256: sha256,
  metrics_uri: z.string(),
  width: z.int(),
  height: z.int(),
  byte_size: z.int(),
  sha256,
})

export const ContactSheetSummarySchema = z.object({
  uri: z.string(),
  map_uri: z.string(),
  width: z.int(),
  height: z.int(),
  cols: z.int(),
  rows: z.int(),
  tile_width: z.int(),
  tile_height: z.int(),
})

export const IterationResultSchema = z.object({
  session_id: z.string(),
  iteration_id: z.string(),
  iteration_dir: z.string(),
  kind: z.enum(['candidate', 'sweep']),
  candidate_count: z.int(),
  candidates: z.array(CandidateSummarySchema),
  contact_sheet: ContactSheetSummarySchema.nullable(),
  decode: z.enum(['quick', 'bounded-hq']),
  raw_render_exposure: ExposureSchema,
  timings_ms: z.record(z.string(), z.number()),
})

export const ExportResultSchema = z.object({
  session_id: z.string(),
  output: RenderOutputSchema,
  manifest_uri: z.string(),
  manifest_sha256: sha256,
  parent_manifest_sha256: sha256.nullable(),
  color_graph_fingerprint: sha256,
  raw_render_exposure: ExposureSchema,
  strips: z.int(),
  timings_ms: z.record(z.string(), z.number()),
})

export const CompareSheetResultSchema = z.object({
  session_id: z.string(),
  iteration_id: z.string(),
  contact_sheet: ContactSheetSummarySchema,
  tiles: z.array(z.object({ candidate_id: z.string(), index: z.int(), x: z.int(), y: z.int(), width: z.int(), height: z.int() })),
})

export const MetricsSchema = z.object({
  schema: z.literal('lmfg.metrics.v1'),
  width: z.int(),
  height: z.int(),
  sampled_pixels: z.int(),
  luma: z.object({
    mean: z.number(), p1: z.number(), p50: z.number(), p99: z.number(),
    clipped_highlight_ratio: z.number(), clipped_shadow_ratio: z.number(),
  }),
  chroma: z.object({ mean_saturation: z.number(), colorfulness: z.number() }),
  histogram: z.object({ bins: z.int(), luma: z.array(z.int()) }),
  approximate: z.boolean(),
})

export const MetricsResultSchema = z.object({
  session_id: z.string(),
  iteration_id: z.string(),
  candidate_id: z.string(),
  metrics_uri: z.string(),
  metrics: MetricsSchema,
})

export const ManifestVerifyResultSchema = z.object({
  path: z.string(),
  valid: z.boolean(),
  manifest_sha256: sha256.nullable(),
  kind: nullableString,
  issues: z.array(z.string()),
  warnings: z.array(z.string()),
  environment_match: z.boolean().nullable(),
})

export const ManifestShowResultSchema = z.object({
  path: z.string(),
  verified: z.boolean(),
  warnings: z.array(z.string()),
  manifest: z.record(z.string(), z.unknown()),
})

export const DryRunResultSchema = z.object({
  dry_run: z.literal(true),
  command: z.string(),
  plan: z.record(z.string(), z.unknown()),
})

export const ErrorEnvelopeSchema = z.object({
  schema: z.literal('lmfg.error.v1'),
  ok: z.literal(false),
  error: z.object({
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
    suggested_next_actions: z.array(z.string()),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
})

export const EventSchema = z.object({
  event: z.string(),
  schema: z.literal('lmfg.event.v1'),
}).catchall(z.unknown())

export type VersionResult = z.output<typeof VersionResultSchema>
export type CapabilitiesResult = z.output<typeof CapabilitiesResultSchema>
export type SessionRecord = z.output<typeof SessionRecordSchema>
export type SessionStatusResult = z.output<typeof SessionStatusResultSchema>
export type InspectResult = z.output<typeof InspectResultSchema>
export type Exposure = z.output<typeof ExposureSchema>
export type LutProfileOutput = z.output<typeof LutProfileOutputSchema>
export type LutResolutionOutput = z.output<typeof LutResolutionSchema>
export type LutInspectResult = z.output<typeof LutInspectResultSchema>
export type LutContractInferResult = z.output<typeof LutContractInferResultSchema>
export type LutContractValidateResult = z.output<typeof LutContractValidateResultSchema>
export type RenderOutput = z.output<typeof RenderOutputSchema>
export type PreviewResult = z.output<typeof PreviewResultSchema>
export type CandidateSummary = z.output<typeof CandidateSummarySchema>
export type ContactSheetSummary = z.output<typeof ContactSheetSummarySchema>
export type IterationResult = z.output<typeof IterationResultSchema>
export type ExportResult = z.output<typeof ExportResultSchema>
export type CompareSheetResult = z.output<typeof CompareSheetResultSchema>
export type Metrics = z.output<typeof MetricsSchema>
export type MetricsResult = z.output<typeof MetricsResultSchema>
export type ManifestVerifyResult = z.output<typeof ManifestVerifyResultSchema>
export type ManifestShowResult = z.output<typeof ManifestShowResultSchema>
export type DryRunResult = z.output<typeof DryRunResultSchema>
```

- [x] **Step 6: Implement `src/schemas/registry.ts`**

```ts
import type { ZodType } from 'zod'
import { z } from 'zod'

import { LutContractInputSchema, RenderParamsSchema } from './params'
import { CandidatePlanSchema, SweepPlanSchema } from './plan'
import * as results from './results'

type SchemaEntry = { schema: ZodType; description: string }

export const SCHEMA_REGISTRY: Record<string, SchemaEntry> = {
  'lmfg.version.v1': { schema: results.VersionResultSchema, description: 'Result of `lmfg version`.' },
  'lmfg.capabilities.v1': { schema: results.CapabilitiesResultSchema, description: 'Result of `lmfg capabilities`.' },
  'lmfg.schema.list.v1': { schema: results.SchemaListResultSchema, description: 'Result of `lmfg schema list`.' },
  'lmfg.schema.show.v1': { schema: results.SchemaShowResultSchema, description: 'Result of `lmfg schema show`.' },
  'lmfg.session.v1': { schema: results.SessionRecordSchema, description: 'Session record (`session.json`) and result of `lmfg session init`.' },
  'lmfg.session.status.v1': { schema: results.SessionStatusResultSchema, description: 'Result of `lmfg session status`.' },
  'lmfg.session.list.v1': { schema: results.SessionListResultSchema, description: 'Result of `lmfg session list`.' },
  'lmfg.inspect.v1': { schema: results.InspectResultSchema, description: 'Result of `lmfg inspect`.' },
  'lmfg.lut.inspect.v1': { schema: results.LutInspectResultSchema, description: 'Result of `lmfg lut inspect`.' },
  'lmfg.lut.contract.infer.v1': { schema: results.LutContractInferResultSchema, description: 'Result of `lmfg lut contract infer`.' },
  'lmfg.lut.contract.validate.v1': { schema: results.LutContractValidateResultSchema, description: 'Result of `lmfg lut contract validate`.' },
  'lmfg.params.v1': { schema: RenderParamsSchema, description: 'Render parameters file accepted by `--params`.' },
  'lmfg.plan.v1': { schema: CandidatePlanSchema, description: 'Candidate plan file accepted by `render candidate --plan`.' },
  'lmfg.sweep.v1': { schema: SweepPlanSchema, description: 'Sweep plan file accepted by `render sweep --plan`.' },
  'lmfg.contract.v1': { schema: LutContractInputSchema, description: 'LUT contract selection accepted by `--contract` and `params.lut.contract`.' },
  'lmfg.render.preview.v1': { schema: results.PreviewResultSchema, description: 'Result of `lmfg render preview`.' },
  'lmfg.render.candidate.v1': { schema: results.IterationResultSchema, description: 'Result of `lmfg render candidate`.' },
  'lmfg.render.sweep.v1': { schema: results.IterationResultSchema, description: 'Result of `lmfg render sweep`.' },
  'lmfg.render.export.v1': { schema: results.ExportResultSchema, description: 'Result of `lmfg render export`.' },
  'lmfg.compare.sheet.v1': { schema: results.CompareSheetResultSchema, description: 'Result of `lmfg compare sheet`.' },
  'lmfg.metrics.v1': { schema: results.MetricsSchema, description: 'Per-candidate `metrics.json`.' },
  'lmfg.metrics.compute.v1': { schema: results.MetricsResultSchema, description: 'Result of `lmfg metrics compute`.' },
  'lmfg.manifest.verify.v1': { schema: results.ManifestVerifyResultSchema, description: 'Result of `lmfg manifest verify`.' },
  'lmfg.manifest.show.v1': { schema: results.ManifestShowResultSchema, description: 'Result of `lmfg manifest show`.' },
  'lmfg.dry-run.v1': { schema: results.DryRunResultSchema, description: 'Result of any command run with `--dry-run`.' },
  'lmfg.error.v1': { schema: results.ErrorEnvelopeSchema, description: 'Error envelope written on failure.' },
  'lmfg.event.v1': { schema: results.EventSchema, description: 'NDJSON event line written with `--emit ndjson`.' },
}

export function listSchemas(): Array<{ id: string; description: string }> {
  return Object.entries(SCHEMA_REGISTRY).map(([id, entry]) => ({ id, description: entry.description }))
}

export function showSchema(id: string): { id: string; description: string; json_schema: Record<string, unknown> } | null {
  const entry = SCHEMA_REGISTRY[id]
  if (!entry) return null
  const json_schema = z.toJSONSchema(entry.schema, {
    target: 'draft-2020-12',
    unrepresentable: 'any',
    io: 'input',
  }) as Record<string, unknown>
  return { id, description: entry.description, json_schema: { $id: id, ...json_schema } }
}
```

Note: `showSchema` renders the *input* shape (`io: 'input'`) so agents see optional-with-default fields as optional.

- [x] **Step 7: Run tests to verify they pass**

Run: `pnpm --filter @lumaforge/lmfg-cli test src/schemas`
Expected: PASS (plan tests need `../workspace/ids` from Task 4 — implement `ids.ts` first if running Task 3 in isolation; it is 12 lines and listed in Task 4 Step 3).

- [x] **Step 8: Commit**

```bash
git add packages/lmfg-cli/src/schemas packages/lmfg-cli/src/workspace/ids.ts
git commit -m "feat(cli): add lmfg params, plan, result schemas and JSON Schema registry"
```

---

### Task 4: Workspace — paths, atomic fs, ids, session store, iteration store

**Files:**
- Create: `src/workspace/paths.ts`, `src/workspace/atomic-fs.ts`, `src/workspace/ids.ts`, `src/workspace/session-store.ts`, `src/workspace/iteration-store.ts`
- Test: `src/workspace/ids.test.ts`, `src/workspace/atomic-fs.test.ts`, `src/workspace/session-store.test.ts`, `src/workspace/iteration-store.test.ts`

- [x] **Step 1: Write failing tests**

`src/workspace/ids.test.ts`:

```ts
// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { createSessionId, formatCandidateId, formatIterationId, formatPreviewId, isSessionId } from './ids'

describe('ids', () => {
  it('creates spec-shaped session ids', () => {
    const id = createSessionId(new Date('2026-09-05T02:03:04Z'), () => 'abc123')
    expect(id).toBe('sess_20260905T020304_abc123')
    expect(isSessionId(id)).toBe(true)
    expect(isSessionId('sess_x')).toBe(false)
  })

  it('formats zero-padded iteration, candidate, preview ids', () => {
    expect(formatIterationId(1)).toBe('iter_0001')
    expect(formatCandidateId(12)).toBe('cand_0012')
    expect(formatPreviewId(3)).toBe('prev_0003')
  })
})
```

`src/workspace/atomic-fs.test.ts`:

```ts
// @vitest-environment node
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { readJson, writeFileAtomic, writeJsonAtomic } from './atomic-fs'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'lmfg-fs-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('atomic-fs', () => {
  it('writes files atomically and leaves no temp files', async () => {
    const target = join(dir, 'nested', 'out.bin')
    await writeFileAtomic(target, new Uint8Array([1, 2, 3]))
    expect([...(await readFile(target))]).toEqual([1, 2, 3])
    expect(await readdir(join(dir, 'nested'))).toEqual(['out.bin'])
  })

  it('round-trips JSON', async () => {
    const target = join(dir, 'a.json')
    await writeJsonAtomic(target, { b: 1, a: [true] })
    expect(await readJson<{ a: boolean[] }>(target)).toEqual({ b: 1, a: [true] })
  })

  it('maps missing files to file.not_found', async () => {
    await expect(readJson(join(dir, 'missing.json'))).rejects.toMatchObject({ code: 'file.not_found' })
  })
})
```

`src/workspace/session-store.test.ts`:

```ts
// @vitest-environment node
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createSessionStore } from './session-store'

const SHA = 'a'.repeat(64)
let root: string
beforeEach(async () => { root = join(await mkdtemp(join(tmpdir(), 'lmfg-ws-')), '.lmfg') })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('session store', () => {
  it('initializes a session with directories and identity file', async () => {
    const store = createSessionStore(root)
    const session = await store.init({
      sourcePath: '/photos/DSC0001.ARW', sha256: SHA, byteSize: 42, now: new Date('2026-09-05T00:00:00Z'), random: () => 'ffffff',
    })
    expect(session.id).toBe('sess_20260905T000000_ffffff')
    expect(session.source).toEqual({ path: '/photos/DSC0001.ARW', filename: 'DSC0001.ARW', byte_size: 42, sha256: SHA })
    expect(session.status).toBe('initialized')
    expect((await stat(join(root, 'sessions', session.id, 'source', 'source.identity.json'))).isFile()).toBe(true)
    expect((await stat(join(root, 'sessions', session.id, 'session.json'))).isFile()).toBe(true)
  })

  it('loads, lists, updates and allocates counters', async () => {
    const store = createSessionStore(root)
    const a = await store.init({ sourcePath: '/p/a.dng', sha256: SHA, byteSize: 1, now: new Date('2026-09-05T00:00:00Z'), random: () => '000001' })
    const b = await store.init({ sourcePath: '/p/b.dng', sha256: SHA, byteSize: 1, now: new Date('2026-09-05T00:00:01Z'), random: () => '000002' })
    expect((await store.list()).map((s) => s.id)).toEqual([a.id, b.id])
    expect(await store.allocate(a.id, 'iterations')).toBe(1)
    expect(await store.allocate(a.id, 'iterations')).toBe(2)
    const updated = await store.update(a.id, (rec) => ({ ...rec, status: 'inspected', decoded_dimensions: { width: 10, height: 5 } }))
    expect(updated.status).toBe('inspected')
    expect((await store.load(a.id)).counters.iterations).toBe(2)
    await expect(store.load('sess_missing')).rejects.toMatchObject({ code: 'session.not_found' })
  })
})
```

`src/workspace/iteration-store.test.ts`:

```ts
// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { parseRenderParams } from '../schemas/params'
import { createIterationStore } from './iteration-store'

let root: string
beforeEach(async () => { root = join(await mkdtemp(join(tmpdir(), 'lmfg-it-')), '.lmfg') })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('iteration store', () => {
  it('writes plan, events, candidate artifacts, and reads tiles back', async () => {
    const store = createIterationStore(root, 'sess_x')
    const params = parseRenderParams({})
    await store.create({
      schema: 'lmfg.iteration.v1', id: 'iter_0001', session_id: 'sess_x', created_at: 'now', kind: 'candidate',
      base: params, candidates: [{ id: 'cand_0001', tag: null, params }],
      options: { max_pixels: 2_500_000, quality: 85, contact_sheet: null },
    })
    await store.appendEvent('iter_0001', { event: 'started' })
    await store.appendEvent('iter_0001', { event: 'completed' })
    const tile = { rgba: new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 255]), width: 2, height: 1 }
    const paths = await store.writeCandidate('iter_0001', 'cand_0001', {
      previewJpeg: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
      manifest: { manifest_sha256: 'x' } as never,
      metrics: { schema: 'lmfg.metrics.v1' } as never,
      tile,
      params,
    })
    expect(paths.preview.endsWith('preview.jpg')).toBe(true)
    expect((await readFile(join(root, 'sessions', 'sess_x', 'iterations', 'iter_0001', 'events.ndjson'), 'utf8')).trim().split('\n')).toHaveLength(2)
    expect(await store.readCandidateTile('iter_0001', 'cand_0001')).toEqual(tile)
    expect(await store.listCandidates('iter_0001')).toEqual(['cand_0001'])
    expect((await store.read('iter_0001')).candidates[0].id).toBe('cand_0001')
    await expect(store.read('iter_9999')).rejects.toMatchObject({ code: 'iteration.not_found' })
  })
})
```

- [x] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @lumaforge/lmfg-cli test src/workspace`
Expected: FAIL — modules not found.

- [x] **Step 3: Implement `ids.ts` and `paths.ts`**

`src/workspace/ids.ts`:

```ts
import { randomBytes } from 'node:crypto'

const SESSION_ID_RE = /^sess_\d{8}T\d{6}_[0-9a-f]{6}$/

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0')
}

export function createSessionId(now = new Date(), random: () => string = () => randomBytes(3).toString('hex')): string {
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
  return `sess_${stamp}_${random()}`
}

export function isSessionId(value: string): boolean {
  return SESSION_ID_RE.test(value)
}

export const formatIterationId = (n: number): string => `iter_${pad(n, 4)}`
export const formatCandidateId = (n: number): string => `cand_${pad(n, 4)}`
export const formatPreviewId = (n: number): string => `prev_${pad(n, 4)}`
```

`src/workspace/paths.ts`:

```ts
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const DEFAULT_WORKSPACE_DIRNAME = '.lmfg'

export function resolveWorkspaceRoot(cwd: string, option?: string): string {
  return resolve(cwd, option ?? DEFAULT_WORKSPACE_DIRNAME)
}

export function toFileUri(path: string): string {
  return pathToFileURL(path).href
}

export const workspacePaths = {
  sessions: (root: string) => join(root, 'sessions'),
  session: (root: string, id: string) => join(root, 'sessions', id),
  sessionFile: (root: string, id: string) => join(root, 'sessions', id, 'session.json'),
  source: (root: string, id: string) => join(root, 'sessions', id, 'source'),
  sourceIdentityFile: (root: string, id: string) => join(root, 'sessions', id, 'source', 'source.identity.json'),
  inspectFile: (root: string, id: string) => join(root, 'sessions', id, 'source', 'inspect.json'),
  embeddedPreviewFile: (root: string, id: string) => join(root, 'sessions', id, 'source', 'embedded-preview.jpg'),
  previews: (root: string, id: string) => join(root, 'sessions', id, 'previews'),
  previewFile: (root: string, id: string, previewId: string) => join(root, 'sessions', id, 'previews', `${previewId}.jpg`),
  previewManifestFile: (root: string, id: string, previewId: string) => join(root, 'sessions', id, 'previews', `${previewId}.manifest.json`),
  iterations: (root: string, id: string) => join(root, 'sessions', id, 'iterations'),
  iteration: (root: string, id: string, iterationId: string) => join(root, 'sessions', id, 'iterations', iterationId),
  iterationPlanFile: (root: string, id: string, iterationId: string) => join(root, 'sessions', id, 'iterations', iterationId, 'plan.json'),
  iterationEventsFile: (root: string, id: string, iterationId: string) => join(root, 'sessions', id, 'iterations', iterationId, 'events.ndjson'),
  contactSheetFile: (root: string, id: string, iterationId: string, name = 'contact-sheet') => join(root, 'sessions', id, 'iterations', iterationId, `${name}.jpg`),
  contactSheetMapFile: (root: string, id: string, iterationId: string, name = 'contact-sheet') => join(root, 'sessions', id, 'iterations', iterationId, `${name}.map.json`),
  candidates: (root: string, id: string, iterationId: string) => join(root, 'sessions', id, 'iterations', iterationId, 'candidates'),
  candidate: (root: string, id: string, iterationId: string, candidateId: string) => join(root, 'sessions', id, 'iterations', iterationId, 'candidates', candidateId),
  candidatePreviewFile: (root: string, id: string, iterationId: string, candidateId: string) => join(root, 'sessions', id, 'iterations', iterationId, 'candidates', candidateId, 'preview.jpg'),
  candidateManifestFile: (root: string, id: string, iterationId: string, candidateId: string) => join(root, 'sessions', id, 'iterations', iterationId, 'candidates', candidateId, 'manifest.json'),
  candidateMetricsFile: (root: string, id: string, iterationId: string, candidateId: string) => join(root, 'sessions', id, 'iterations', iterationId, 'candidates', candidateId, 'metrics.json'),
  candidateParamsFile: (root: string, id: string, iterationId: string, candidateId: string) => join(root, 'sessions', id, 'iterations', iterationId, 'candidates', candidateId, 'params.json'),
  candidateTileFile: (root: string, id: string, iterationId: string, candidateId: string) => join(root, 'sessions', id, 'iterations', iterationId, 'candidates', candidateId, 'tile.rgba'),
  candidateTileMetaFile: (root: string, id: string, iterationId: string, candidateId: string) => join(root, 'sessions', id, 'iterations', iterationId, 'candidates', candidateId, 'tile.json'),
  exports: (root: string, id: string) => join(root, 'sessions', id, 'exports'),
  exportFile: (root: string, id: string, name: string) => join(root, 'sessions', id, 'exports', `${name}.jpg`),
  exportManifestFile: (root: string, id: string, name: string) => join(root, 'sessions', id, 'exports', `${name}.manifest.json`),
}
```

- [x] **Step 4: Implement `atomic-fs.ts`**

```ts
import { randomBytes } from 'node:crypto'
import { appendFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import process from 'node:process'

import { LmfgError } from '../protocol/errors'

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

export async function writeFileAtomic(path: string, data: Uint8Array | string): Promise<void> {
  await ensureDir(dirname(path))
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  try {
    await writeFile(tmp, data)
    await rename(tmp, path)
  } catch (error) {
    await rm(tmp, { force: true })
    throw error
  }
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`)
}

export async function readJson<T>(path: string): Promise<T> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new LmfgError('file.not_found', { message: `File not found: ${path}`, cause: error })
    }
    throw error
  }
  try {
    return JSON.parse(text) as T
  } catch (error) {
    throw new LmfgError('schema.invalid', { message: `File is not valid JSON: ${path}`, cause: error })
  }
}

export async function readJsonOrNull<T>(path: string): Promise<T | null> {
  if (!(await fileExists(path))) return null
  return readJson<T>(path)
}

export async function appendLine(path: string, line: string): Promise<void> {
  await ensureDir(dirname(path))
  await appendFile(path, `${line}\n`)
}

export async function listDirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}
```

- [x] **Step 5: Implement `session-store.ts`**

```ts
import { basename } from 'node:path'

import { LmfgError } from '../protocol/errors'
import type { SessionRecord } from '../schemas/results'
import { SessionRecordSchema } from '../schemas/results'
import { ensureDir, fileExists, listDirs, readJson, writeJsonAtomic } from './atomic-fs'
import { createSessionId } from './ids'
import { workspacePaths } from './paths'

export type SessionInitInput = {
  sourcePath: string
  sha256: string
  byteSize: number
  now?: Date
  random?: () => string
}

export type SessionCounter = 'previews' | 'iterations' | 'exports'

export type SessionStore = {
  readonly root: string
  init: (input: SessionInitInput) => Promise<SessionRecord>
  load: (id: string) => Promise<SessionRecord>
  list: () => Promise<SessionRecord[]>
  update: (id: string, patch: (record: SessionRecord) => SessionRecord) => Promise<SessionRecord>
  allocate: (id: string, counter: SessionCounter) => Promise<number>
}

export function createSessionStore(root: string): SessionStore {
  async function load(id: string): Promise<SessionRecord> {
    const file = workspacePaths.sessionFile(root, id)
    if (!(await fileExists(file))) {
      throw new LmfgError('session.not_found', {
        message: `Session "${id}" was not found under ${root}.`,
        suggestedNextActions: ['lmfg session list'],
      })
    }
    return SessionRecordSchema.parse(await readJson(file))
  }

  async function write(record: SessionRecord): Promise<void> {
    await writeJsonAtomic(workspacePaths.sessionFile(root, record.id), record)
  }

  return {
    root,
    async init(input) {
      const now = input.now ?? new Date()
      const id = createSessionId(now, input.random)
      const record: SessionRecord = {
        schema: 'lmfg.session.v1',
        id,
        created_at: now.toISOString(),
        updated_at: now.toISOString(),
        workspace_root: root,
        source: {
          path: input.sourcePath,
          filename: basename(input.sourcePath),
          byte_size: input.byteSize,
          sha256: input.sha256,
        },
        decoded_dimensions: null,
        counters: { previews: 0, iterations: 0, exports: 0 },
        status: 'initialized',
      }
      await ensureDir(workspacePaths.source(root, id))
      await ensureDir(workspacePaths.previews(root, id))
      await ensureDir(workspacePaths.iterations(root, id))
      await ensureDir(workspacePaths.exports(root, id))
      await writeJsonAtomic(workspacePaths.sourceIdentityFile(root, id), {
        schema: 'lmfg.source-identity.v1',
        ...record.source,
      })
      await write(record)
      return record
    },
    load,
    async list() {
      const ids = await listDirs(workspacePaths.sessions(root))
      const records: SessionRecord[] = []
      for (const id of ids) {
        if (await fileExists(workspacePaths.sessionFile(root, id))) records.push(await load(id))
      }
      return records.sort((a, b) => a.created_at.localeCompare(b.created_at))
    },
    async update(id, patch) {
      const next = { ...patch(await load(id)), updated_at: new Date().toISOString() }
      await write(next)
      return next
    },
    async allocate(id, counter) {
      const record = await load(id)
      const value = record.counters[counter] + 1
      await write({ ...record, counters: { ...record.counters, [counter]: value }, updated_at: new Date().toISOString() })
      return value
    },
  }
}
```

- [x] **Step 6: Implement `iteration-store.ts`**

```ts
import { readFile } from 'node:fs/promises'

import type { RenderManifest } from '@lumaforge/render-engine'

import { LmfgError } from '../protocol/errors'
import type { RenderParams } from '../schemas/params'
import type { ContactSheetOptions } from '../schemas/plan'
import type { Metrics } from '../schemas/results'
import { appendLine, ensureDir, fileExists, listDirs, readJson, readJsonOrNull, writeFileAtomic, writeJsonAtomic } from './atomic-fs'
import { workspacePaths } from './paths'

export type IterationRecord = {
  schema: 'lmfg.iteration.v1'
  id: string
  session_id: string
  created_at: string
  kind: 'candidate' | 'sweep'
  base: RenderParams
  candidates: Array<{ id: string; tag: string | null; params: RenderParams }>
  options: {
    max_pixels: number
    quality: number
    contact_sheet: (ContactSheetOptions & { cols: number; tile_width: number; gap: number }) | null
  }
}

export type CandidateTile = { rgba: Uint8ClampedArray; width: number; height: number }

export type CandidateArtifacts = {
  previewJpeg: Uint8Array
  manifest: RenderManifest
  metrics: Metrics
  tile: CandidateTile
  params: RenderParams
}

export type CandidatePaths = { dir: string; preview: string; manifest: string; metrics: string; params: string; tile: string; tileMeta: string }

export type ContactSheetMap = {
  schema: 'lmfg.contact-sheet-map.v1'
  iteration_id: string
  cols: number
  rows: number
  tile_width: number
  tile_height: number
  gap: number
  width: number
  height: number
  tiles: Array<{ candidate_id: string; index: number; x: number; y: number; width: number; height: number }>
}

export function createIterationStore(root: string, sessionId: string) {
  const p = workspacePaths
  function candidatePaths(iterationId: string, candidateId: string): CandidatePaths {
    return {
      dir: p.candidate(root, sessionId, iterationId, candidateId),
      preview: p.candidatePreviewFile(root, sessionId, iterationId, candidateId),
      manifest: p.candidateManifestFile(root, sessionId, iterationId, candidateId),
      metrics: p.candidateMetricsFile(root, sessionId, iterationId, candidateId),
      params: p.candidateParamsFile(root, sessionId, iterationId, candidateId),
      tile: p.candidateTileFile(root, sessionId, iterationId, candidateId),
      tileMeta: p.candidateTileMetaFile(root, sessionId, iterationId, candidateId),
    }
  }

  async function read(iterationId: string): Promise<IterationRecord> {
    const file = p.iterationPlanFile(root, sessionId, iterationId)
    if (!(await fileExists(file))) {
      throw new LmfgError('iteration.not_found', {
        message: `Iteration "${iterationId}" was not found in session ${sessionId}.`,
        suggestedNextActions: [`lmfg session status --session ${sessionId}`],
      })
    }
    return readJson<IterationRecord>(file)
  }

  return {
    candidatePaths,
    async create(record: IterationRecord): Promise<string> {
      const dir = p.iteration(root, sessionId, record.id)
      await ensureDir(p.candidates(root, sessionId, record.id))
      await writeJsonAtomic(p.iterationPlanFile(root, sessionId, record.id), record)
      return dir
    },
    read,
    async appendEvent(iterationId: string, event: Record<string, unknown>): Promise<void> {
      await appendLine(p.iterationEventsFile(root, sessionId, iterationId), JSON.stringify({ ...event, schema: 'lmfg.event.v1' }))
    },
    async writeCandidate(iterationId: string, candidateId: string, artifacts: CandidateArtifacts): Promise<CandidatePaths> {
      const paths = candidatePaths(iterationId, candidateId)
      await ensureDir(paths.dir)
      await writeFileAtomic(paths.preview, artifacts.previewJpeg)
      await writeJsonAtomic(paths.manifest, artifacts.manifest)
      await writeJsonAtomic(paths.metrics, artifacts.metrics)
      await writeJsonAtomic(paths.params, { schema: 'lmfg.params.v1', ...artifacts.params })
      await writeFileAtomic(paths.tile, new Uint8Array(artifacts.tile.rgba.buffer, artifacts.tile.rgba.byteOffset, artifacts.tile.rgba.byteLength))
      await writeJsonAtomic(paths.tileMeta, { schema: 'lmfg.tile.v1', format: 'rgba8', width: artifacts.tile.width, height: artifacts.tile.height, byte_length: artifacts.tile.rgba.byteLength })
      return paths
    },
    async listCandidates(iterationId: string): Promise<string[]> {
      return listDirs(p.candidates(root, sessionId, iterationId))
    },
    async readCandidateTile(iterationId: string, candidateId: string): Promise<CandidateTile> {
      const paths = candidatePaths(iterationId, candidateId)
      const meta = await readJsonOrNull<{ width: number; height: number; byte_length: number }>(paths.tileMeta)
      if (!meta || !(await fileExists(paths.tile))) {
        throw new LmfgError('candidate.not_found', { message: `Candidate "${candidateId}" has no tile in ${iterationId}.` })
      }
      const bytes = await readFile(paths.tile)
      return { rgba: new Uint8ClampedArray(bytes.buffer, bytes.byteOffset, bytes.byteLength), width: meta.width, height: meta.height }
    },
    async readCandidateMetrics(iterationId: string, candidateId: string): Promise<Metrics | null> {
      return readJsonOrNull<Metrics>(candidatePaths(iterationId, candidateId).metrics)
    },
    async readCandidateManifest(iterationId: string, candidateId: string): Promise<RenderManifest> {
      const paths = candidatePaths(iterationId, candidateId)
      if (!(await fileExists(paths.manifest))) {
        throw new LmfgError('candidate.not_found', {
          message: `Candidate "${candidateId}" was not found in ${iterationId}.`,
          suggestedNextActions: [`lmfg session status --session ${sessionId}`],
        })
      }
      return readJson<RenderManifest>(paths.manifest)
    },
    async readCandidateParams(iterationId: string, candidateId: string): Promise<RenderParams> {
      const { schema: _schema, ...params } = await readJson<RenderParams & { schema?: string }>(candidatePaths(iterationId, candidateId).params)
      return params
    },
    async writeContactSheet(iterationId: string, input: { jpeg: Uint8Array; map: ContactSheetMap; name?: string }): Promise<{ sheet: string; map: string }> {
      const sheet = p.contactSheetFile(root, sessionId, iterationId, input.name)
      const map = p.contactSheetMapFile(root, sessionId, iterationId, input.name)
      await writeFileAtomic(sheet, input.jpeg)
      await writeJsonAtomic(map, input.map)
      return { sheet, map }
    },
  }
}

export type IterationStore = ReturnType<typeof createIterationStore>
```

- [x] **Step 7: Run tests to verify they pass, then commit**

Run: `pnpm --filter @lumaforge/lmfg-cli test src/workspace src/schemas`
Expected: PASS.

```bash
git add packages/lmfg-cli/src/workspace
git commit -m "feat(cli): add .lmfg workspace session and iteration stores"
```

---

### Task 5: Runtime adapters — versions/environment, capabilities, Node runtimes, source loader

**Files:**
- Create: `src/runtime/versions.ts`, `src/runtime/capability.ts`, `src/runtime/node-runtime.ts`, `src/runtime/source-loader.ts`
- Test: `src/runtime/versions.test.ts`, `src/runtime/capability.test.ts`, `src/runtime/node-runtime.test.ts`, `src/runtime/source-loader.test.ts`

- [x] **Step 1: Write failing tests**

`src/runtime/versions.test.ts`:

```ts
// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { LMFG_VERSION, readPackageVersion, resolvePackageDir, resolveRenderEnvironment, resolveRuntimeVersions } from './versions'

describe('versions', () => {
  it('resolves workspace package directories', () => {
    expect(resolvePackageDir('@lumaforge/render-engine')).toMatch(/render-engine$/)
    expect(resolvePackageDir('@lumaforge/does-not-exist')).toBeNull()
  })

  it('reads semver strings for every runtime dependency', () => {
    const versions = resolveRuntimeVersions('desktop')
    for (const key of ['luma_raw_runtime', 'luma_color_runtime', 'luma_jpeg_runtime', 'render_engine'] as const) {
      expect(versions[key]).toMatch(/^\d+\.\d+\.\d+/)
    }
    expect(versions.native_artifacts.variant).toBe('desktop')
    expect(LMFG_VERSION).toMatch(/^\d+\.\d+\.\d+/)
    expect(readPackageVersion('@lumaforge/nope')).toBe('unknown')
  })

  it('derives a stable native build id from provenance hashes', () => {
    const env = resolveRenderEnvironment('low-memory')
    expect(env.native_artifacts.variant).toBe('low-memory')
    expect(env.native_artifacts.build_id).toMatch(/^raw:[0-9a-f]{12}\+jpeg:[0-9a-f]{12}$|^unknown$/)
    expect(env.render_engine).toBe(resolveRuntimeVersions('low-memory').render_engine)
  })
})
```

`src/runtime/capability.test.ts`:

```ts
// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { assertTierAvailable, detectCapabilities } from './capability'

describe('capabilities', () => {
  it('reports cpu_wasm as the active tier and the browser bridge as unavailable', () => {
    const caps = detectCapabilities({ memoryProfile: 'desktop' })
    expect(caps.active_tier).toBe('cpu_wasm')
    expect(caps.fallback_order).toEqual(['cpu_wasm'])
    expect(caps.render_tiers.browser_bridge.available).toBe(false)
    expect(caps.render_tiers.browser_bridge.reason).toMatch(/--tier cpu/)
    expect(caps.render_tiers.cpu_wasm.supports).toContain('cpu-export')
    expect(caps.limits.max_candidates_per_sweep).toBe(64)
  })

  it('rejects the browser tier', () => {
    expect(() => assertTierAvailable('cpu')).not.toThrow()
    expect(() => assertTierAvailable('browser')).toThrow(expect.objectContaining({ code: 'tier.unavailable', exitCode: 3 }))
  })
})
```

`src/runtime/node-runtime.test.ts`:

```ts
// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { detectCapabilities } from './capability'
import { createLmfgRuntime } from './node-runtime'

const hasArtifacts = detectCapabilities({ memoryProfile: 'desktop' }).render_tiers.cpu_wasm.available
const d = hasArtifacts ? describe : describe.skip

d('createLmfgRuntime', () => {
  it('lazily creates and disposes both runtimes', async () => {
    const runtime = createLmfgRuntime({ memoryProfile: 'desktop' })
    const raw = await runtime.raw()
    expect(await raw.init()).toMatchObject({ runtime: 'luma', memoryProfile: 'desktop' })
    expect(await runtime.raw()).toBe(raw)
    const jpeg = await runtime.jpeg()
    expect(typeof jpeg.createEncoder).toBe('function')
    runtime.dispose()
    runtime.dispose()
  }, 30_000)
})
```

`src/runtime/source-loader.test.ts`:

```ts
// @vitest-environment node
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { loadSourceFile, verifySourceIdentity } from './source-loader'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'lmfg-src-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('source loader', () => {
  it('reads bytes and computes the full-file sha256', async () => {
    const file = join(dir, 'a.dng')
    await writeFile(file, Buffer.from('hello raw'))
    const source = await loadSourceFile('a.dng', dir)
    expect(source.absolutePath).toBe(file)
    expect(source.filename).toBe('a.dng')
    expect(source.byteSize).toBe(9)
    expect(source.sha256).toBe(createHash('sha256').update('hello raw').digest('hex'))
    expect(source.input).toEqual({ data: source.bytes, name: 'a.dng', size: 9 })
  })

  it('maps missing files and directories to argument errors', async () => {
    await expect(loadSourceFile('missing.dng', dir)).rejects.toMatchObject({ code: 'file.not_found' })
    await expect(loadSourceFile('.', dir)).rejects.toMatchObject({ code: 'args.invalid' })
  })

  it('verifies identity and reports mismatches', async () => {
    const file = join(dir, 'b.dng')
    await writeFile(file, Buffer.from('bytes'))
    const source = await loadSourceFile(file, dir)
    expect(() => verifySourceIdentity(source, source.sha256)).not.toThrow()
    expect(() => verifySourceIdentity(source, 'f'.repeat(64))).toThrow(expect.objectContaining({ code: 'hash.mismatch' }))
  })
})
```

- [x] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @lumaforge/lmfg-cli test src/runtime`
Expected: FAIL — modules not found.

- [x] **Step 3: Implement `versions.ts`**

```ts
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { RenderEnvironment } from '@lumaforge/render-engine'

import type { RuntimeVersionsSchema } from '../schemas/results'
import type { z } from 'zod'

export type MemoryProfile = 'desktop' | 'low-memory'
export type RuntimeVersions = z.output<typeof RuntimeVersionsSchema>

type PackageJson = { name?: string; version?: string }

function readPackageJson(dir: string): PackageJson | null {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as PackageJson
  } catch {
    return null
  }
}

/**
 * Locate an installed package directory by probing the node_modules
 * ancestry of this module. Works with pnpm symlinks (existsSync follows
 * them) and with hoisted installs.
 */
export function resolvePackageDir(name: string, from: string = import.meta.url): string | null {
  const require = createRequire(from)
  for (const dir of require.resolve.paths(name) ?? []) {
    const candidate = join(dir, name)
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  return null
}

export function readPackageVersion(name: string): string {
  const dir = resolvePackageDir(name)
  return (dir && readPackageJson(dir)?.version) || 'unknown'
}

function findOwnPackageDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 5; depth += 1) {
    if (readPackageJson(dir)?.name === '@lumaforge/lmfg-cli') return dir
    dir = dirname(dir)
  }
  throw new Error('LMFG_PACKAGE_ROOT_NOT_FOUND')
}

export const LMFG_PACKAGE_DIR = findOwnPackageDir()
export const LMFG_VERSION = readPackageJson(LMFG_PACKAGE_DIR)?.version ?? 'unknown'

type Provenance = { artifacts?: { wasm?: { sha256?: string } } }

export type NativeArtifactStatus = {
  package_dir: string | null
  variant: MemoryProfile
  build_id: string
  raw_wasm: string | null
  jpeg_wasm: string | null
  raw_present: boolean
  jpeg_present: boolean
}

function readProvenance(dir: string, names: string[]): Provenance | null {
  for (const name of names) {
    const file = join(dir, 'native', 'provenance', name)
    if (!existsSync(file)) continue
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as Provenance
    } catch {
      return null
    }
  }
  return null
}

export function resolveNativeArtifacts(memoryProfile: MemoryProfile): NativeArtifactStatus {
  const dir = resolvePackageDir('@lumaforge/luma-native-artifacts')
  if (!dir) {
    return { package_dir: null, variant: memoryProfile, build_id: 'unknown', raw_wasm: null, jpeg_wasm: null, raw_present: false, jpeg_present: false }
  }
  const rawWasm = join(dir, 'native', memoryProfile, 'luma_raw.wasm')
  const jpegWasm = join(dir, 'native', 'luma_jpeg.wasm')
  const raw = readProvenance(dir, [`raw-${memoryProfile}.json`, 'raw.json'])
  const jpeg = readProvenance(dir, ['jpeg.json'])
  const rawSha = raw?.artifacts?.wasm?.sha256
  const jpegSha = jpeg?.artifacts?.wasm?.sha256
  return {
    package_dir: dir,
    variant: memoryProfile,
    build_id: rawSha && jpegSha ? `raw:${rawSha.slice(0, 12)}+jpeg:${jpegSha.slice(0, 12)}` : 'unknown',
    raw_wasm: rawWasm,
    jpeg_wasm: jpegWasm,
    raw_present: existsSync(rawWasm),
    jpeg_present: existsSync(jpegWasm),
  }
}

export function resolveRuntimeVersions(memoryProfile: MemoryProfile): RuntimeVersions {
  const artifacts = resolveNativeArtifacts(memoryProfile)
  return {
    luma_raw_runtime: readPackageVersion('@lumaforge/luma-raw-runtime'),
    luma_color_runtime: readPackageVersion('@lumaforge/luma-color-runtime'),
    luma_jpeg_runtime: readPackageVersion('@lumaforge/luma-jpeg-runtime'),
    render_engine: readPackageVersion('@lumaforge/render-engine'),
    native_artifacts: { build_id: artifacts.build_id, variant: artifacts.variant },
  }
}

export function resolveRenderEnvironment(memoryProfile: MemoryProfile): RenderEnvironment {
  const versions = resolveRuntimeVersions(memoryProfile)
  return {
    render_engine: versions.render_engine,
    luma_color_runtime: versions.luma_color_runtime,
    luma_raw_runtime: versions.luma_raw_runtime,
    luma_jpeg_runtime: versions.luma_jpeg_runtime,
    native_artifacts: versions.native_artifacts,
  }
}
```

- [x] **Step 4: Implement `capability.ts`**

```ts
import { BOUNDED_HQ_PREVIEW_MAX_PIXELS, QUICK_PREVIEW_MAX_PIXELS } from '@lumaforge/render-engine/preview'

import { LmfgError } from '../protocol/errors'
import { MAX_CANDIDATES_PER_SWEEP } from '../schemas/plan'
import type { CapabilitiesResult } from '../schemas/results'
import type { MemoryProfile } from './versions'
import { resolveNativeArtifacts, resolveRuntimeVersions } from './versions'

export type RenderTier = 'cpu' | 'browser'

export const CPU_TIER_SUPPORTS = [
  'inspect', 'source-identity', 'cpu-preview', 'lut-contract', 'manifest',
  'candidate-render', 'contact-sheet', 'metrics', 'cpu-export',
] as const

export const BROWSER_TIER_SUPPORTS = ['webgl2-preview', 'candidate-render', 'contact-sheet', 'full-res-export'] as const

export const BROWSER_TIER_UNAVAILABLE_REASON =
  'The browser bridge tier is not included in this release; use --tier cpu.'

export function detectCapabilities(input: { memoryProfile: MemoryProfile }): CapabilitiesResult {
  const artifacts = resolveNativeArtifacts(input.memoryProfile)
  const available = artifacts.raw_present && artifacts.jpeg_present
  return {
    render_tiers: {
      cpu_wasm: {
        available,
        memory_profile: input.memoryProfile,
        supports: [...CPU_TIER_SUPPORTS],
        artifacts: { raw_wasm: artifacts.raw_present, jpeg_wasm: artifacts.jpeg_present },
        ...(available ? {} : { reason: 'Native WASM artifacts are missing; install @lumaforge/luma-native-artifacts.' }),
      },
      browser_bridge: {
        available: false,
        supports: [...BROWSER_TIER_SUPPORTS],
        reason: BROWSER_TIER_UNAVAILABLE_REASON,
      },
    },
    active_tier: 'cpu_wasm',
    fallback_order: ['cpu_wasm'],
    runtime_versions: resolveRuntimeVersions(input.memoryProfile),
    limits: {
      max_candidates_per_sweep: MAX_CANDIDATES_PER_SWEEP,
      quick_preview_max_pixels: QUICK_PREVIEW_MAX_PIXELS,
      bounded_hq_max_pixels: BOUNDED_HQ_PREVIEW_MAX_PIXELS,
    },
  }
}

export function assertTierAvailable(tier: RenderTier): void {
  if (tier === 'cpu') return
  throw new LmfgError('tier.unavailable', {
    message: BROWSER_TIER_UNAVAILABLE_REASON,
    suggestedNextActions: ['lmfg capabilities'],
    details: { requested_tier: tier, active_tier: 'cpu_wasm' },
  })
}
```

- [x] **Step 5: Implement `node-runtime.ts`**

```ts
import type { LumaJpegNodeRuntime } from '@lumaforge/luma-jpeg-runtime/node'
import { createLumaJpegRuntimeForNode } from '@lumaforge/luma-jpeg-runtime/node'
import type { LumaRawNodeRuntime } from '@lumaforge/luma-raw-runtime/node'
import { createLumaRawRuntimeForNode } from '@lumaforge/luma-raw-runtime/node'

import { LmfgError, toLmfgError } from '../protocol/errors'
import type { MemoryProfile } from './versions'

export type LmfgRuntime = {
  readonly memoryProfile: MemoryProfile
  raw: () => Promise<LumaRawNodeRuntime>
  jpeg: () => Promise<LumaJpegNodeRuntime>
  dispose: () => void
}

export function createLmfgRuntime(input: { memoryProfile: MemoryProfile }): LmfgRuntime {
  let rawPromise: Promise<LumaRawNodeRuntime> | null = null
  let jpegPromise: Promise<LumaJpegNodeRuntime> | null = null
  let disposed = false

  function assertLive() {
    if (disposed) throw new LmfgError('internal', { message: 'Runtime already disposed.' })
  }

  return {
    memoryProfile: input.memoryProfile,
    raw() {
      assertLive()
      rawPromise ??= (async () => {
        try {
          const runtime = await createLumaRawRuntimeForNode({ memoryProfile: input.memoryProfile })
          await runtime.init()
          return runtime
        } catch (error) {
          const mapped = toLmfgError(error)
          throw mapped.code === 'internal'
            ? new LmfgError('runtime.unavailable', { message: `RAW runtime failed to start: ${mapped.message}`, cause: error })
            : mapped
        }
      })()
      return rawPromise
    },
    jpeg() {
      assertLive()
      jpegPromise ??= createLumaJpegRuntimeForNode().catch((error: unknown) => {
        throw new LmfgError('runtime.unavailable', { message: `JPEG runtime failed to start: ${String(error)}`, cause: error })
      })
      return jpegPromise
    },
    dispose() {
      if (disposed) return
      disposed = true
      void rawPromise?.then((runtime) => runtime.dispose()).catch(() => undefined)
      void jpegPromise?.then((runtime) => runtime.dispose()).catch(() => undefined)
    },
  }
}
```

- [x] **Step 6: Implement `source-loader.ts`**

```ts
import { readFile, stat } from 'node:fs/promises'
import { basename, resolve } from 'node:path'

import type { LumaRawNodeSourceInput } from '@lumaforge/luma-raw-runtime/node'
import { sourceContentIdFromBytes } from '@lumaforge/render-engine'

import { LmfgError } from '../protocol/errors'

export type LoadedSource = {
  absolutePath: string
  filename: string
  bytes: Uint8Array
  byteSize: number
  sha256: string
  input: LumaRawNodeSourceInput
}

export async function loadSourceFile(path: string, cwd: string): Promise<LoadedSource> {
  const absolutePath = resolve(cwd, path)
  let info
  try {
    info = await stat(absolutePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new LmfgError('file.not_found', { message: `Source file not found: ${absolutePath}` })
    }
    throw error
  }
  if (!info.isFile()) {
    throw new LmfgError('args.invalid', { message: `Source path is not a file: ${absolutePath}` })
  }
  const buffer = await readFile(absolutePath)
  const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  const identity = await sourceContentIdFromBytes(bytes)
  const filename = basename(absolutePath)
  return {
    absolutePath,
    filename,
    bytes,
    byteSize: identity.byteSize,
    sha256: identity.sha256,
    input: { data: bytes, name: filename, size: identity.byteSize },
  }
}

export function verifySourceIdentity(source: LoadedSource, expectedSha256: string): void {
  if (source.sha256 === expectedSha256) return
  throw new LmfgError('hash.mismatch', {
    message: `Source bytes changed since the session was created (expected sha256 ${expectedSha256.slice(0, 12)}…, got ${source.sha256.slice(0, 12)}…).`,
    suggestedNextActions: [`lmfg session init --source ${source.absolutePath}`],
    details: { expected_sha256: expectedSha256, actual_sha256: source.sha256 },
  })
}
```

- [x] **Step 7: Run tests to verify they pass, then commit**

Run: `pnpm --filter @lumaforge/lmfg-cli test src/runtime`
Expected: PASS (runtime test needs artifacts; it self-skips otherwise).

```bash
git add packages/lmfg-cli/src/runtime
git commit -m "feat(cli): add Node runtime adapters, capability report, and source identity loader"
```

---

### Task 6: render-engine `RenderParams` additive fields (D10)

**Files:**
- Modify: `packages/render-engine/src/manifest/render-manifest.ts:113-131`
- Modify: `packages/render-engine/src/manifest/index.ts`, `packages/render-engine/src/index.ts` (export `SaturationParams`)
- Test: `packages/render-engine/src/manifest/canonicalize.test.ts`

- [x] **Step 1: Write the failing test** (append to `canonicalize.test.ts`)

```ts
describe('RenderParams additive fields (lmfg)', () => {
  it('seals and verifies manifests carrying temperature, saturation, and raw exposure', () => {
    const manifest = sealRenderManifest({
      ...buildMinimalManifest(),
      render_params: {
        exposure_ev: 0.5,
        tone_curve: { contrast: 10, highlights: -5, shadows: 5, whites: 0, blacks: 0 },
        color_balance: { temperature: 20, tint: -3 },
        saturation: { saturation: 15, vibrance: 30 },
        intensity: 1,
        raw_render_exposure_ev: -0.2177,
        raw_render_exposure_source: 'dng-baseline',
      },
    } as never)
    expect(verifyManifestSha256(manifest)).toBe(true)
    expect(canonicalizeJson(manifest.render_params)).toContain('"raw_render_exposure_source":"dng-baseline"')
  })
})
```

(`buildMinimalManifest` already exists in `dist-bundle.test.ts`; copy it into `canonicalize.test.ts` if it is not already defined there.)

- [x] **Step 2: Run to verify it fails**

Run: `pnpm --filter @lumaforge/render-engine test src/manifest/canonicalize.test.ts`
Expected: FAIL on type/shape (TS excess property) or missing helper.

- [x] **Step 3: Implement**

Replace the `ColorBalanceParams` / `RenderParams` block in `render-manifest.ts` with:

```ts
export interface ColorBalanceParams {
  readonly temp_k?: number
  readonly tint?: number
  /** LumaForge user temperature slider (-100..100); mutually informative with `temp_k`. */
  readonly temperature?: number
}

export interface SaturationParams {
  readonly saturation?: number
  readonly vibrance?: number
}

export type RawRenderExposureSource = 'dng-baseline' | 'image-statistics' | 'identity' | 'user'

export interface RenderParams {
  readonly exposure_ev: number
  readonly tone_curve?: ToneCurveParams
  readonly color_balance?: ColorBalanceParams
  readonly saturation?: SaturationParams
  readonly intensity?: number
  /** Resolved raw-render exposure (EV) applied before user params. */
  readonly raw_render_exposure_ev?: number
  readonly raw_render_exposure_source?: RawRenderExposureSource
}
```

Add `RawRenderExposureSource` and `SaturationParams` to the `export type {...} from './render-manifest'` lists in `manifest/index.ts` and `src/index.ts`.

- [x] **Step 4: Verify and commit**

Run: `pnpm --filter @lumaforge/render-engine typecheck && pnpm --filter @lumaforge/render-engine test && pnpm --filter @lumaforge/render-engine build`
Expected: PASS; dist rebuilt (the CLI typechecks against it).

```bash
git add packages/render-engine/src
git commit -m "feat(render-engine): add additive RenderParams fields for CLI manifests"
```

---

### Task 7: Color graph service — params → graph, descriptor v1, fingerprint, manifest params

**Files:**
- Create: `src/services/color-graph.ts`
- Test: `src/services/color-graph.test.ts`

- [x] **Step 1: Write failing tests**

```ts
// @vitest-environment node
import { generateIdentityLUT, toLUTData } from '@lumaforge/luma-color-runtime'
import { describe, expect, it } from 'vitest'

import { parseRenderParams } from '../schemas/params'
import {
  buildColorGraph, describeColorGraph, fingerprintColorGraph, requireSupportedGraph, resolveExposure, toManifestRenderParams,
} from './color-graph'

const frame = { data: new Uint16Array(4 * 3).fill(30000), width: 2, height: 2 }

describe('resolveExposure', () => {
  it('prefers the DNG baseline in auto mode', () => {
    expect(resolveExposure(parseRenderParams({}), { baselineExposure: -0.25, frame })).toMatchObject({ ev: -0.25, source: 'dng-baseline' })
  })
  it('falls back to image statistics, then identity', () => {
    expect(resolveExposure(parseRenderParams({}), { baselineExposure: undefined, frame }).source).toBe('image-statistics')
    expect(resolveExposure(parseRenderParams({}), { baselineExposure: undefined, frame: null }).source).toBe('identity')
  })
  it('honours an explicit EV', () => {
    expect(resolveExposure(parseRenderParams({ raw_render_exposure: 0.5 }), { baselineExposure: -1, frame })).toEqual({ ev: 0.5, multiplier: Math.pow(2, 0.5), source: 'user' })
  })
})

describe('buildColorGraph + describeColorGraph', () => {
  const exposure = { ev: 0, multiplier: 1, source: 'identity' as const }

  it('produces a supported graph without a LUT and a stable fingerprint', () => {
    const a = requireSupportedGraph(buildColorGraph(parseRenderParams({ contrast: 10 }), null, exposure))
    const b = requireSupportedGraph(buildColorGraph(parseRenderParams({ contrast: 10 }), null, exposure))
    const c = requireSupportedGraph(buildColorGraph(parseRenderParams({ contrast: 11 }), null, exposure))
    expect(a.steps.map((s) => s.kind)).toContain('user-contrast')
    expect(fingerprintColorGraph(describeColorGraph(a))).toBe(fingerprintColorGraph(describeColorGraph(b)))
    expect(fingerprintColorGraph(describeColorGraph(a))).not.toBe(fingerprintColorGraph(describeColorGraph(c)))
  })

  it('replaces LUT tables with a hash and converts typed arrays', () => {
    const lut = toLUTData(generateIdentityLUT(17))
    const graph = requireSupportedGraph(buildColorGraph(parseRenderParams({}), lut, exposure))
    const descriptor = describeColorGraph(graph)
    expect(descriptor.descriptor_version).toBe(1)
    const lutStep = descriptor.steps.find((s) => (s as { kind: string }).kind === 'lut3d') as Record<string, unknown>
    expect(lutStep.data).toBeUndefined()
    expect(lutStep.data_sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(lutStep.data_length).toBe(17 * 17 * 17 * 3)
    const matrixStep = descriptor.steps.find((s) => (s as { kind: string }).kind === 'gamut-to-lut-input') as Record<string, unknown>
    expect(Array.isArray(matrixStep.matrix)).toBe(true)
    expect(JSON.parse(JSON.stringify(descriptor))).toEqual(descriptor)
  })

  it('maps params onto manifest render_params', () => {
    const params = parseRenderParams({ exposure_ev: 1, contrast: 5, temperature: 10, tint: -2, saturation: 3, vibrance: 4, intensity: 0.5 })
    expect(toManifestRenderParams(params, { ev: -0.2, multiplier: 0.87, source: 'dng-baseline' })).toEqual({
      exposure_ev: 1,
      tone_curve: { contrast: 5, highlights: 0, shadows: 0, whites: 0, blacks: 0 },
      color_balance: { temperature: 10, tint: -2 },
      saturation: { saturation: 3, vibrance: 4 },
      intensity: 0.5,
      raw_render_exposure_ev: -0.2,
      raw_render_exposure_source: 'dng-baseline',
    })
  })
})
```

- [x] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @lumaforge/lmfg-cli test src/services/color-graph`
Expected: FAIL — module not found.

- [x] **Step 3: Implement `src/services/color-graph.ts`**

```ts
import type {
  ExportColorGraphDescriptor, ExportColorGraphStep, LUTData, RawRenderExposure, SupportedExportColorGraphDescriptor,
} from '@lumaforge/luma-color-runtime'
import { exposureMultiplierFromEv, resolveExportColorGraph, resolveRawRenderExposure } from '@lumaforge/luma-color-runtime'
import type { ColorGraphIdentity, RenderParams as ManifestRenderParams } from '@lumaforge/render-engine'
import { canonicalizeJson, sha256Hex } from '@lumaforge/render-engine'

import { LmfgError } from '../protocol/errors'
import type { RenderParams } from '../schemas/params'

export type ExposureSourceFrame = { data: Uint16Array; width: number; height: number }

export function resolveExposure(
  params: RenderParams,
  source: { baselineExposure: number | undefined; frame: ExposureSourceFrame | null },
): RawRenderExposure {
  if (params.raw_render_exposure !== 'auto') {
    const ev = params.raw_render_exposure
    return { ev, multiplier: exposureMultiplierFromEv(ev), source: 'user' }
  }
  return resolveRawRenderExposure({ metadata: { baselineExposure: source.baselineExposure }, image: source.frame })
}

export function buildColorGraph(params: RenderParams, lut: LUTData | null, exposure: RawRenderExposure): ExportColorGraphDescriptor {
  return resolveExportColorGraph({
    styleKind: lut ? 'custom' : 'none',
    intensity: params.intensity,
    builtinPreset: null,
    lut,
    rawRenderExposure: exposure,
    userExposureEv: params.exposure_ev,
    userContrast: params.contrast,
    userHighlights: params.highlights,
    userShadows: params.shadows,
    userWhites: params.whites,
    userBlacks: params.blacks,
    userTemperature: params.temperature,
    userTint: params.tint,
    userSaturation: params.saturation,
    userVibrance: params.vibrance,
  })
}

export function requireSupportedGraph(graph: ExportColorGraphDescriptor): SupportedExportColorGraphDescriptor {
  if (graph.supported) return graph
  const unsupportedOutput = /output (?:transfer|range)/i.test(graph.message)
  throw new LmfgError(unsupportedOutput ? 'lut.contract.unsupported_output' : 'lut.contract.incomplete', {
    message: graph.message,
    retryable: true,
    suggestedNextActions: ['lmfg lut contract infer --lut <file.cube>', 'lmfg lut contract validate --lut <file.cube> --contract <contract.json>'],
  })
}

export type ColorGraphDescriptorV1 = {
  descriptor_version: 1
  output_gamut: string
  output_transfer: string
  lut_profile: unknown
  steps: unknown[]
}

function toJsonSafe(value: unknown): unknown {
  if (ArrayBuffer.isView(value)) return Array.from(value as unknown as ArrayLike<number>)
  if (Array.isArray(value)) return value.map(toJsonSafe)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, toJsonSafe(item)]))
  }
  return value
}

function describeStep(step: ExportColorGraphStep): unknown {
  if (step.kind === 'lut3d') {
    const bytes = new Uint8Array(step.data.buffer, step.data.byteOffset, step.data.byteLength)
    return {
      kind: 'lut3d',
      size: step.size,
      domain_min: [...step.domainMin],
      domain_max: [...step.domainMax],
      data_length: step.data.length,
      data_sha256: sha256Hex(bytes),
      data_encoding: 'float32-le',
    }
  }
  return toJsonSafe(step)
}

export function describeColorGraph(graph: SupportedExportColorGraphDescriptor): ColorGraphDescriptorV1 {
  return {
    descriptor_version: 1,
    output_gamut: graph.outputGamut,
    output_transfer: graph.outputTransfer,
    lut_profile: toJsonSafe(graph.lutProfile),
    steps: graph.steps.map(describeStep),
  }
}

const TEXT_ENCODER = new TextEncoder()

export function fingerprintColorGraph(descriptor: ColorGraphDescriptorV1): string {
  return sha256Hex(TEXT_ENCODER.encode(canonicalizeJson(descriptor)))
}

export function toColorGraphIdentity(graph: SupportedExportColorGraphDescriptor): ColorGraphIdentity {
  const descriptor = describeColorGraph(graph)
  return { fingerprint: fingerprintColorGraph(descriptor), descriptor }
}

export function toManifestRenderParams(params: RenderParams, exposure: RawRenderExposure): ManifestRenderParams {
  return {
    exposure_ev: params.exposure_ev,
    tone_curve: { contrast: params.contrast, highlights: params.highlights, shadows: params.shadows, whites: params.whites, blacks: params.blacks },
    color_balance: { temperature: params.temperature, tint: params.tint },
    saturation: { saturation: params.saturation, vibrance: params.vibrance },
    intensity: params.intensity,
    raw_render_exposure_ev: exposure.ev,
    raw_render_exposure_source: exposure.source,
  }
}
```

- [x] **Step 4: Run tests to verify they pass, then commit**

Run: `pnpm --filter @lumaforge/lmfg-cli test src/services/color-graph`
Expected: PASS.

```bash
git add packages/lmfg-cli/src/services/color-graph.ts packages/lmfg-cli/src/services/color-graph.test.ts
git commit -m "feat(cli): resolve color graphs and hashable manifest descriptors from lmfg params"
```

---

### Task 8: LUT service and `lut` commands

**Files:**
- Create: `src/services/lut.ts`, `src/commands/lut.ts`
- Test: `src/services/lut.test.ts` (command-level coverage lands in Task 15 e2e)

- [x] **Step 1: Write failing tests**

```ts
// @vitest-environment node
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { inferContract, loadLutFile, resolveLutContract, validateContract } from './lut'

function cube(lines: string[]): string {
  const size = 2
  const rows: string[] = []
  for (let b = 0; b < size; b += 1) for (let g = 0; g < size; g += 1) for (let r = 0; r < size; r += 1) rows.push(`${r} ${g} ${b}`)
  return [...lines, `LUT_3D_SIZE ${size}`, ...rows].join('\n')
}

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'lmfg-lut-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('lut service', () => {
  it('confirms a contract from LUMAFORGE_ metadata comments', async () => {
    await writeFile(join(dir, 'vlog.cube'), cube(['TITLE "VLog to 709"', '# LUMAFORGE_ROLE=combined-look-output', '# LUMAFORGE_INPUT_PROFILE=panasonic-vgamut-vlog', '# LUMAFORGE_OUTPUT_GAMUT=srgb-rec709', '# LUMAFORGE_OUTPUT_TRANSFER=bt709', '# LUMAFORGE_OUTPUT_RANGE=full']))
    const loaded = await loadLutFile('vlog.cube', dir)
    expect(loaded.sha256).toMatch(/^[0-9a-f]{64}$/)
    const resolved = resolveLutContract(loaded)
    expect(resolved.source).toBe('metadata')
    expect(resolved.identity).toMatchObject({
      kind: 'local-file', filename: 'vlog.cube', sha256: loaded.sha256,
      input_contract: { gamut: 'v-gamut', transfer: 'v-log', range: 'full' },
      output_contract: { gamut: 'srgb-rec709', transfer: 'bt709', range: 'full', role: 'combined-look-output' },
    })
    expect(inferContract(loaded).complete).toBe(true)
  })

  it('reports recommendations and fails closed without a contract', async () => {
    await writeFile(join(dir, 'slog3.cube'), cube(['TITLE "Sony S-Gamut3.Cine S-Log3 to Rec709"']))
    const loaded = await loadLutFile('slog3.cube', dir)
    const inferred = inferContract(loaded)
    expect(inferred.complete).toBe(false)
    expect(inferred.resolution.kind).toBe('recommended')
    expect(inferred.suggested_contracts[0]).toMatchObject({ role: 'combined-look-output', input_profile: 'sony-sgamut3cine-slog3' })
    expect(() => resolveLutContract(loaded)).toThrow(expect.objectContaining({ code: 'lut.contract.incomplete', exitCode: 4 }))
    const resolved = resolveLutContract(loaded, inferred.suggested_contracts[0])
    expect(resolved.source).toBe('params')
    expect(resolved.profile.inputTransfer).toBe('s-log3')
  })

  it('validates explicit contracts and explains issues', async () => {
    await writeFile(join(dir, 'x.cube'), cube(['TITLE "x"']))
    const loaded = await loadLutFile('x.cube', dir)
    const ok = validateContract(loaded, { role: 'display-look', input_gamut: 'srgb-rec709', input_transfer: 'srgb', input_range: 'full' })
    expect(ok.valid).toBe(true)
    expect(ok.export_supported).toBe(true)
    const bad = validateContract(loaded, { role: 'scene-creative', input_gamut: 'v-gamut', input_transfer: 'v-log' })
    expect(bad.valid).toBe(false)
    expect(bad.issues.join(' ')).toMatch(/output/i)
    expect(() => resolveLutContract(loaded, { role: 'scene-creative', input_gamut: 'v-gamut', input_transfer: 'v-log' })).toThrow(expect.objectContaining({ code: 'lut.contract.invalid' }))
  })

  it('rejects non-cube files and parse failures with argument errors', async () => {
    await writeFile(join(dir, 'a.txt'), 'nope')
    await writeFile(join(dir, 'broken.cube'), 'TITLE "b"\nLUT_3D_SIZE 2\n0 0 0')
    await expect(loadLutFile('a.txt', dir)).rejects.toMatchObject({ code: 'args.invalid' })
    await expect(loadLutFile('broken.cube', dir)).rejects.toMatchObject({ code: 'lut.parse_failed', exitCode: 2 })
    await expect(loadLutFile('missing.cube', dir)).rejects.toMatchObject({ code: 'file.not_found' })
  })
})
```

- [x] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @lumaforge/lmfg-cli test src/services/lut`
Expected: FAIL — module not found.

- [x] **Step 3: Implement `src/services/lut.ts`**

```ts
import { readFile, stat } from 'node:fs/promises'
import { basename, resolve } from 'node:path'

import type {
  LUTColorProfile, LUTContractResolution, LUTContractSelection, LUTData, ParsedLUT, StoredLUTContractSelection,
} from '@lumaforge/luma-color-runtime'
import {
  buildStoredContractSelection, contractToLUTColorProfile, getLUTColorProfile, hasCompleteOutputContract, hasDisplayLikeInput,
  isLUTRole, isSupportedLUT, parseCubeLUT, resolveColorGamutId, resolveTransferFunctionId, resolveUnsupportedLUTOutputReason,
  toCompatInputProfile, toLUTData, validateLUT,
} from '@lumaforge/luma-color-runtime'
import type { LutLocalFileIdentity } from '@lumaforge/render-engine'
import { sha256Hex } from '@lumaforge/render-engine'

import { LmfgError } from '../protocol/errors'
import type { LutContractInput, LutReference } from '../schemas/params'
import { LutContractInputSchema } from '../schemas/params'
import type { LutContractInferResult, LutContractValidateResult, LutInspectResult, LutProfileOutput, LutResolutionOutput } from '../schemas/results'

export type LoadedLutFile = {
  absolutePath: string
  filename: string
  byteSize: number
  sha256: string
  content: string
  parsed: ParsedLUT
}

export type ResolvedLut = {
  loaded: LoadedLutFile
  parsed: ParsedLUT
  profile: LUTColorProfile
  source: 'metadata' | 'params'
  lutData: LUTData
  identity: LutLocalFileIdentity
}

const INFER_ACTION = (path: string) => `lmfg lut contract infer --lut ${path}`
const VALIDATE_ACTION = (path: string) => `lmfg lut contract validate --lut ${path} --contract <contract.json>`

export async function loadLutFile(path: string, cwd: string): Promise<LoadedLutFile> {
  const absolutePath = resolve(cwd, path)
  const filename = basename(absolutePath)
  if (!isSupportedLUT(filename)) {
    throw new LmfgError('args.invalid', { message: `Only .cube LUT files are supported: ${filename}` })
  }
  try {
    if (!(await stat(absolutePath)).isFile()) {
      throw new LmfgError('args.invalid', { message: `LUT path is not a file: ${absolutePath}` })
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new LmfgError('file.not_found', { message: `LUT file not found: ${absolutePath}` })
    }
    throw error
  }
  const buffer = await readFile(absolutePath)
  const content = buffer.toString('utf8')
  let parsed: ParsedLUT
  try {
    parsed = parseCubeLUT(content, { sourceName: filename })
  } catch (error) {
    throw new LmfgError('lut.parse_failed', {
      message: `Failed to parse ${filename}: ${error instanceof Error ? error.message : String(error)}`,
      cause: error,
    })
  }
  return {
    absolutePath,
    filename,
    byteSize: buffer.byteLength,
    sha256: sha256Hex(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)),
    content,
    parsed,
  }
}

export function profileToOutput(profile: LUTColorProfile): LutProfileOutput {
  return {
    profile_id: profile.id,
    label: profile.label,
    role: profile.role,
    input_gamut: profile.inputGamut,
    input_transfer: profile.inputTransfer,
    input_range: profile.inputRange,
    output_gamut: profile.outputGamut ?? null,
    output_transfer: profile.outputTransfer ?? null,
    output_range: profile.outputRange ?? null,
  }
}

export function profileToContractInput(profile: LUTColorProfile): LutContractInput {
  const registered = getLUTColorProfile(profile.id)
  return LutContractInputSchema.parse({
    role: profile.role,
    ...(registered ? { input_profile: registered.id } : {}),
    input_gamut: profile.inputGamut,
    input_transfer: profile.inputTransfer,
    input_range: profile.inputRange,
    ...(profile.outputGamut ? { output_gamut: profile.outputGamut } : {}),
    ...(profile.outputTransfer ? { output_transfer: profile.outputTransfer } : {}),
    ...(profile.outputRange ? { output_range: profile.outputRange } : {}),
  })
}

export function resolutionToOutput(resolution: LUTContractResolution): LutResolutionOutput {
  switch (resolution.kind) {
    case 'confirmed':
      return { kind: 'confirmed', confidence: resolution.confidence, profile: profileToOutput(resolution.profile) }
    case 'recommended':
    case 'unsupported-output':
      return { kind: resolution.kind, recommendations: resolution.recommendations.map(profileToOutput) }
    default:
      return { kind: 'unknown' }
  }
}

function contractInputToSelection(input: LutContractInput): LUTContractSelection {
  return {
    inputProfile: input.input_profile,
    role: input.role,
    inputGamut: resolveColorGamutId(input.input_gamut),
    inputTransfer: resolveTransferFunctionId(input.input_transfer),
    inputRange: input.input_range,
    outputGamut: resolveColorGamutId(input.output_gamut),
    outputTransfer: resolveTransferFunctionId(input.output_transfer),
    outputRange: input.output_range,
  }
}

function explainSelectionIssues(input: LutContractInput, selection: LUTContractSelection): string[] {
  const issues: string[] = []
  if (!isLUTRole(input.role)) issues.push(`role "${input.role}" is not supported.`)
  const profile = input.input_profile ? getLUTColorProfile(input.input_profile) : undefined
  if (input.input_profile && !profile) issues.push(`input_profile "${input.input_profile}" is not a known profile id.`)
  const inputGamut = profile?.inputGamut ?? selection.inputGamut
  const inputTransfer = profile?.inputTransfer ?? selection.inputTransfer
  if (!inputGamut) issues.push('input_gamut is missing or unsupported (set input_profile or input_gamut).')
  if (!inputTransfer) issues.push('input_transfer is missing or unsupported (set input_profile or input_transfer).')
  if (input.input_gamut && profile && resolveColorGamutId(input.input_gamut) !== profile.inputGamut) issues.push('input_gamut conflicts with input_profile.')
  if (input.input_transfer && profile && resolveTransferFunctionId(input.input_transfer) !== profile.inputTransfer) issues.push('input_transfer conflicts with input_profile.')
  const outputComplete = hasCompleteOutputContract(selection)
  if (input.role !== 'display-look' && !outputComplete) {
    issues.push(`role "${input.role}" requires output_gamut, output_transfer and output_range.`)
  }
  if (input.role === 'display-look' && inputGamut && inputTransfer && !hasDisplayLikeInput({ inputGamut, inputTransfer })) {
    issues.push('display-look LUTs require a display-like input (srgb-rec709 with srgb, bt709 or gamma24).')
  }
  if (input.role === 'display-look' && (input.output_gamut || input.output_transfer || input.output_range) && !outputComplete) {
    issues.push('display-look output contract must be complete when any output field is given.')
  }
  return issues.length > 0 ? issues : ['The contract is incomplete or inconsistent.']
}

export type AppliedContract =
  | { ok: true; parsed: ParsedLUT; profile: LUTColorProfile }
  | { ok: false; issues: string[] }

export function applyContractSelection(parsed: ParsedLUT, input: LutContractInput): AppliedContract {
  const selection = contractInputToSelection(input)
  const contract: StoredLUTContractSelection | undefined = buildStoredContractSelection(selection)
  if (!contract) return { ok: false, issues: explainSelectionIssues(input, selection) }
  const profileId = contract.inputProfile ?? `${contract.inputGamut}-${contract.inputTransfer}`
  const profile = contractToLUTColorProfile(profileId, contract)
  const profileResolution: LUTContractResolution = { kind: 'confirmed', confidence: 'user', profile }
  return { ok: true, profile, parsed: { ...parsed, profileResolution, inputProfile: toCompatInputProfile(profileResolution) } }
}

function effectiveOutputTransfer(profile: LUTColorProfile): string | undefined {
  return profile.outputTransfer ?? (profile.role === 'display-look' ? profile.inputTransfer : undefined)
}

function explicitRangeOrThrow(range: string | undefined, label: string, path: string): 'full' | 'legal' {
  if (range === 'full' || range === 'legal') return range
  throw new LmfgError('lut.contract.incomplete', {
    message: `${label} range must be explicit ("full" or "legal") before rendering.`,
    retryable: true,
    suggestedNextActions: [VALIDATE_ACTION(path)],
  })
}

export function toLutIdentity(loaded: LoadedLutFile, profile: LUTColorProfile): LutLocalFileIdentity {
  const outputTransfer = effectiveOutputTransfer(profile)
  if (!outputTransfer) {
    throw new LmfgError('lut.contract.incomplete', {
      message: 'Choose a LUT output contract before rendering.',
      retryable: true,
      suggestedNextActions: [INFER_ACTION(loaded.absolutePath)],
    })
  }
  return {
    kind: 'local-file',
    filename: loaded.filename,
    sha256: loaded.sha256,
    input_contract: {
      gamut: profile.inputGamut,
      transfer: profile.inputTransfer,
      range: explicitRangeOrThrow(profile.inputRange, 'LUT input', loaded.absolutePath),
    },
    output_contract: {
      gamut: profile.outputGamut ?? profile.inputGamut,
      transfer: outputTransfer,
      range: explicitRangeOrThrow(profile.outputRange ?? (profile.role === 'display-look' ? 'full' : undefined), 'LUT output', loaded.absolutePath),
      role: profile.role,
    },
  }
}

export function resolveLutContract(loaded: LoadedLutFile, contractInput?: LutContractInput): ResolvedLut {
  let parsed = loaded.parsed
  let profile: LUTColorProfile
  let source: ResolvedLut['source']
  if (contractInput) {
    const applied = applyContractSelection(loaded.parsed, contractInput)
    if (!applied.ok) {
      throw new LmfgError('lut.contract.invalid', {
        message: `LUT contract for ${loaded.filename} is invalid: ${applied.issues.join(' ')}`,
        retryable: true,
        suggestedNextActions: [INFER_ACTION(loaded.absolutePath)],
        details: { issues: applied.issues },
      })
    }
    parsed = applied.parsed
    profile = applied.profile
    source = 'params'
  } else {
    const resolution = loaded.parsed.profileResolution
    if (resolution.kind === 'confirmed') {
      profile = resolution.profile
      source = 'metadata'
    } else if (resolution.kind === 'unsupported-output') {
      throw new LmfgError('lut.contract.unsupported_output', {
        message: `${loaded.filename} declares an output space that cannot be rendered to sRGB JPEG.`,
        details: { resolution: resolutionToOutput(resolution) },
      })
    } else {
      throw new LmfgError('lut.contract.incomplete', {
        message: `${loaded.filename} has no confirmed color contract. Pass params.lut.contract (or --contract).`,
        retryable: true,
        suggestedNextActions: [INFER_ACTION(loaded.absolutePath)],
        details: { resolution: resolutionToOutput(resolution) },
      })
    }
  }
  const unsupportedReason = resolveUnsupportedLUTOutputReason(profile)
  if (unsupportedReason) {
    throw new LmfgError(/transfer is not supported/i.test(unsupportedReason) ? 'lut.contract.unsupported_output' : 'lut.contract.incomplete', {
      message: unsupportedReason,
      retryable: true,
      suggestedNextActions: [VALIDATE_ACTION(loaded.absolutePath)],
    })
  }
  const identity = toLutIdentity(loaded, profile)
  return { loaded, parsed, profile, source, lutData: toLUTData(parsed), identity }
}

export async function resolveLutForParams(reference: LutReference | null, cwd: string): Promise<ResolvedLut | null> {
  if (!reference) return null
  const loaded = await loadLutFile(reference.path, cwd)
  return resolveLutContract(loaded, reference.contract)
}

export function inspectLut(loaded: LoadedLutFile): LutInspectResult {
  const validation = validateLUT(loaded.parsed)
  return {
    path: loaded.absolutePath,
    filename: loaded.filename,
    sha256: loaded.sha256,
    byte_size: loaded.byteSize,
    title: loaded.parsed.title,
    size: loaded.parsed.size,
    domain_min: loaded.parsed.domainMin,
    domain_max: loaded.parsed.domainMax,
    comments: loaded.parsed.comments,
    fingerprint: loaded.parsed.fingerprint,
    valid: validation.valid,
    validation_errors: validation.errors,
    resolution: resolutionToOutput(loaded.parsed.profileResolution),
  }
}

export function inferContract(loaded: LoadedLutFile): LutContractInferResult {
  const resolution = loaded.parsed.profileResolution
  const base = { path: loaded.absolutePath, sha256: loaded.sha256, resolution: resolutionToOutput(resolution) }
  if (resolution.kind === 'confirmed') {
    const contract = profileToContractInput(resolution.profile)
    return { ...base, complete: true, contract, suggested_contracts: [contract], message: `Contract confirmed from ${resolution.confidence} metadata.` }
  }
  if (resolution.kind === 'recommended') {
    return {
      ...base, complete: false, contract: null,
      suggested_contracts: resolution.recommendations.map(profileToContractInput),
      message: 'Pass one of suggested_contracts as params.lut.contract (or --contract) after confirming the camera log profile.',
    }
  }
  if (resolution.kind === 'unsupported-output') {
    return {
      ...base, complete: false, contract: null,
      suggested_contracts: resolution.recommendations.map(profileToContractInput),
      message: 'This LUT appears to target a log/technical output space; only display-referred outputs can be exported.',
    }
  }
  return { ...base, complete: false, contract: null, suggested_contracts: [], message: 'No profile hints were found; specify the contract explicitly.' }
}

export function validateContract(loaded: LoadedLutFile, input: LutContractInput): LutContractValidateResult {
  const applied = applyContractSelection(loaded.parsed, input)
  if (!applied.ok) {
    return { path: loaded.absolutePath, sha256: loaded.sha256, valid: false, issues: applied.issues, contract: input, profile: null, export_supported: false, export_reason: applied.issues[0] ?? null }
  }
  let exportReason: string | null = resolveUnsupportedLUTOutputReason(applied.profile) ?? null
  if (!exportReason) {
    try {
      toLutIdentity(loaded, applied.profile)
    } catch (error) {
      exportReason = error instanceof Error ? error.message : String(error)
    }
  }
  return {
    path: loaded.absolutePath, sha256: loaded.sha256, valid: true, issues: [],
    contract: profileToContractInput(applied.profile), profile: profileToOutput(applied.profile),
    export_supported: exportReason === null, export_reason: exportReason,
  }
}
```

- [x] **Step 4: Implement `src/commands/lut.ts`**

```ts
import type { Command } from 'commander'

import { LutContractInputSchema } from '../schemas/params'
import { inferContract, inspectLut, loadLutFile, validateContract } from '../services/lut'
import { readJson } from '../workspace/atomic-fs'
import type { CommandHost } from './context'
import { runCommand } from './context'

export function registerLutCommands(program: Command, host: CommandHost): void {
  const lut = program.command('lut').description('Inspect .cube LUTs and resolve their color contracts')

  lut
    .command('inspect')
    .argument('<file>', '.cube LUT file')
    .description('Parse a LUT and report its metadata, validity, and contract resolution')
    .action(async function (this: Command, file: string) {
      const ctx = host.context(this)
      host.setExitCode(
        await runCommand(ctx, { schema: 'lmfg.lut.inspect.v1', command: 'lut.inspect' }, async () => inspectLut(await loadLutFile(file, ctx.cwd))),
      )
    })

  const contract = lut.command('contract').description('Infer or validate LUT color contracts')

  contract
    .command('infer')
    .requiredOption('--lut <file>', '.cube LUT file')
    .description('Infer the LUT input/output contract from metadata and naming hints')
    .action(async function (this: Command, options: { lut: string }) {
      const ctx = host.context(this)
      host.setExitCode(
        await runCommand(ctx, { schema: 'lmfg.lut.contract.infer.v1', command: 'lut.contract.infer' }, async () => inferContract(await loadLutFile(options.lut, ctx.cwd))),
      )
    })

  contract
    .command('validate')
    .requiredOption('--lut <file>', '.cube LUT file')
    .requiredOption('--contract <file>', 'contract JSON file (lmfg.contract.v1)')
    .description('Validate an explicit contract against a LUT and report export support')
    .action(async function (this: Command, options: { lut: string; contract: string }) {
      const ctx = host.context(this)
      host.setExitCode(
        await runCommand(ctx, { schema: 'lmfg.lut.contract.validate.v1', command: 'lut.contract.validate' }, async () => {
          const loaded = await loadLutFile(options.lut, ctx.cwd)
          const input = LutContractInputSchema.parse(await readJson(ctx.resolvePath(options.contract)))
          return validateContract(loaded, input)
        }),
      )
    })
}
```

- [x] **Step 5: Run tests, then commit**

Run: `pnpm --filter @lumaforge/lmfg-cli test src/services/lut && pnpm --filter @lumaforge/lmfg-cli typecheck`
Expected: PASS (typecheck of `commands/lut.ts` requires Task 9's `context.ts`; commit both together if executing sequentially).

```bash
git add packages/lmfg-cli/src/services/lut.ts packages/lmfg-cli/src/services/lut.test.ts packages/lmfg-cli/src/commands/lut.ts
git commit -m "feat(cli): add LUT contract inference, validation, and lut commands"
```

---

### Task 9: CLI entry — global options, command context, introspection commands

**Files:**
- Create: `src/commands/context.ts`, `src/commands/introspection.ts`
- Modify: `src/cli.ts`, `src/index.ts`, `src/cli.test.ts`

- [x] **Step 1: Extend the failing test `src/cli.test.ts`**

```ts
// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { runCli } from './cli'

function io() {
  const out: string[] = []
  const err: string[] = []
  return { out, err, io: { stdout: (s: string) => out.push(s), stderr: (s: string) => err.push(s), cwd: process.cwd() } }
}

describe('runCli', () => {
  it('version returns a success envelope', async () => {
    const c = io()
    expect(await runCli(['version'], c.io)).toBe(0)
    const envelope = JSON.parse(c.out.join(''))
    expect(envelope).toMatchObject({ schema: 'lmfg.version.v1', ok: true })
    expect(envelope.result.lmfg).toMatch(/^\d+\.\d+\.\d+/)
    expect(envelope.result.runtime_versions.render_engine).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('capabilities reports the cpu tier', async () => {
    const c = io()
    expect(await runCli(['capabilities', '--json'], c.io)).toBe(0)
    expect(JSON.parse(c.out.join('')).result.active_tier).toBe('cpu_wasm')
  })

  it('schema list/show work and unknown ids fail with exit 2', async () => {
    const list = io()
    expect(await runCli(['schema', 'list'], list.io)).toBe(0)
    expect(JSON.parse(list.out.join('')).result.schemas.length).toBeGreaterThan(20)
    const show = io()
    expect(await runCli(['schema', 'show', 'lmfg.params.v1'], show.io)).toBe(0)
    expect(JSON.parse(show.out.join('')).result.json_schema.$id).toBe('lmfg.params.v1')
    const missing = io()
    expect(await runCli(['schema', 'show', 'lmfg.nope.v1'], missing.io)).toBe(2)
    expect(JSON.parse(missing.out.join(''))).toMatchObject({ ok: false, error: { code: 'args.invalid' } })
  })

  it('unknown commands and bad options produce args.invalid envelopes', async () => {
    const c = io()
    expect(await runCli(['frobnicate'], c.io)).toBe(2)
    expect(JSON.parse(c.out.join(''))).toMatchObject({ schema: 'lmfg.error.v1', ok: false, error: { code: 'args.invalid' } })
    const bad = io()
    expect(await runCli(['version', '--tier', 'gpu'], bad.io)).toBe(2)
  })

  it('ndjson emit wraps the result in a completed event', async () => {
    const c = io()
    expect(await runCli(['version', '--emit', 'ndjson'], c.io)).toBe(0)
    const line = JSON.parse(c.out.join('').trim())
    expect(line).toMatchObject({ event: 'completed', ok: true, result_schema: 'lmfg.version.v1' })
  })

  it('help exits 0 without an envelope', async () => {
    const c = io()
    expect(await runCli(['--help'], c.io)).toBe(0)
    expect(c.out.join('')).toMatch(/Usage: lmfg/)
  })
})
```

- [x] **Step 2: Run to verify it fails**

Run: `pnpm --filter @lumaforge/lmfg-cli test src/cli.test.ts`
Expected: FAIL.

- [x] **Step 3: Implement `src/commands/context.ts`**

```ts
import { resolve } from 'node:path'
import process from 'node:process'

import type { Command } from 'commander'

import { successEnvelope } from '../protocol/envelope'
import { LmfgError, toLmfgError } from '../protocol/errors'
import type { EmitMode } from '../protocol/output'
import { Output } from '../protocol/output'
import type { RenderTier } from '../runtime/capability'
import type { MemoryProfile } from '../runtime/versions'
import { resolveWorkspaceRoot } from '../workspace/paths'

export type CliIo = {
  stdout: (chunk: string) => void
  stderr: (chunk: string) => void
  cwd: string
}

export type GlobalOptions = {
  workspace?: string
  session?: string
  tier: RenderTier
  emit: EmitMode
  json?: boolean
  quiet: boolean
  color: boolean
  dryRun: boolean
  yes: boolean
  timeout?: number
  memoryProfile: MemoryProfile
}

export type CommandContext = {
  cwd: string
  options: GlobalOptions
  output: Output
  workspaceRoot: string
  signal: AbortSignal
  timedOut: () => boolean
  resolvePath: (path: string) => string
  requireSession: () => string
  dispose: () => void
}

export type CommandHost = {
  io: CliIo
  setExitCode: (code: number) => void
  context: (command: Command) => CommandContext
}

export function createCommandContext(io: CliIo, options: GlobalOptions): CommandContext {
  const controller = new AbortController()
  let timedOut = false
  const timer = options.timeout
    ? setTimeout(() => {
        timedOut = true
        controller.abort(new Error(`Timed out after ${options.timeout} ms.`))
      }, options.timeout)
    : null
  timer?.unref()
  return {
    cwd: io.cwd,
    options,
    output: new Output({ emit: options.emit, quiet: options.quiet, color: options.color, stdout: io.stdout, stderr: io.stderr }),
    workspaceRoot: resolveWorkspaceRoot(io.cwd, options.workspace),
    signal: controller.signal,
    timedOut: () => timedOut,
    resolvePath: (path) => resolve(io.cwd, path),
    requireSession: () => {
      if (!options.session) {
        throw new LmfgError('args.invalid', { message: 'A session id is required (--session <id>).', suggestedNextActions: ['lmfg session list'] })
      }
      return options.session
    },
    dispose: () => {
      if (timer) clearTimeout(timer)
    },
  }
}

export type CommandDescriptor = { schema: string; command: string }

export async function runCommand<T>(
  ctx: CommandContext,
  descriptor: CommandDescriptor,
  run: (ctx: CommandContext) => Promise<T>,
  dryRun?: (ctx: CommandContext) => Promise<Record<string, unknown>>,
): Promise<number> {
  try {
    if (ctx.options.dryRun && dryRun) {
      const plan = await dryRun(ctx)
      ctx.output.result(successEnvelope('lmfg.dry-run.v1', { dry_run: true, command: descriptor.command, plan }))
      return 0
    }
    const result = await run(ctx)
    ctx.output.result(successEnvelope(descriptor.schema, result))
    return 0
  } catch (error) {
    let mapped = toLmfgError(error)
    if (ctx.timedOut()) {
      mapped = new LmfgError('timeout', { message: `Command timed out after ${ctx.options.timeout} ms.`, retryable: true, cause: error })
    }
    ctx.output.error(mapped)
    ctx.output.log(`error ${mapped.code}: ${mapped.message}`)
    return mapped.exitCode
  } finally {
    ctx.dispose()
  }
}

export function defaultIo(): CliIo {
  return {
    stdout: (chunk) => process.stdout.write(chunk),
    stderr: (chunk) => process.stderr.write(chunk),
    cwd: process.cwd(),
  }
}
```

- [x] **Step 4: Implement `src/commands/introspection.ts`**

```ts
import process from 'node:process'

import type { Command } from 'commander'

import { LmfgError } from '../protocol/errors'
import { detectCapabilities } from '../runtime/capability'
import { LMFG_VERSION, resolveRuntimeVersions } from '../runtime/versions'
import { listSchemas, showSchema } from '../schemas/registry'
import type { VersionResult } from '../schemas/results'
import type { CommandHost } from './context'
import { runCommand } from './context'

export function registerIntrospectionCommands(program: Command, host: CommandHost): void {
  program
    .command('version')
    .description('Print lmfg and runtime versions')
    .action(async function (this: Command) {
      const ctx = host.context(this)
      host.setExitCode(
        await runCommand(ctx, { schema: 'lmfg.version.v1', command: 'version' }, async (): Promise<VersionResult> => ({
          lmfg: LMFG_VERSION,
          node: process.version,
          platform: process.platform,
          arch: process.arch,
          runtime_versions: resolveRuntimeVersions(ctx.options.memoryProfile),
        })),
      )
    })

  program
    .command('capabilities')
    .description('Report available render tiers, runtime versions, and limits')
    .action(async function (this: Command) {
      const ctx = host.context(this)
      host.setExitCode(
        await runCommand(ctx, { schema: 'lmfg.capabilities.v1', command: 'capabilities' }, async () =>
          detectCapabilities({ memoryProfile: ctx.options.memoryProfile }),
        ),
      )
    })

  const schema = program.command('schema').description('List or show lmfg JSON schemas')

  schema
    .command('list')
    .description('List schema ids')
    .action(async function (this: Command) {
      const ctx = host.context(this)
      host.setExitCode(await runCommand(ctx, { schema: 'lmfg.schema.list.v1', command: 'schema.list' }, async () => ({ schemas: listSchemas() })))
    })

  schema
    .command('show')
    .argument('<schema-id>', 'schema id, e.g. lmfg.params.v1')
    .description('Show a schema as JSON Schema (draft 2020-12)')
    .action(async function (this: Command, schemaId: string) {
      const ctx = host.context(this)
      host.setExitCode(
        await runCommand(ctx, { schema: 'lmfg.schema.show.v1', command: 'schema.show' }, async () => {
          const shown = showSchema(schemaId)
          if (!shown) {
            throw new LmfgError('args.invalid', { message: `Unknown schema id "${schemaId}".`, suggestedNextActions: ['lmfg schema list'] })
          }
          return shown
        }),
      )
    })
}
```

- [x] **Step 5: Implement `src/cli.ts` and `src/index.ts`**

`src/cli.ts`:

```ts
import { Command, CommanderError, InvalidArgumentError, Option } from 'commander'

import { LmfgError } from '../src/protocol/errors'
import { LMFG_VERSION } from './runtime/versions'
import { registerCompareCommands } from './commands/compare'
import type { CliIo, CommandHost, GlobalOptions } from './commands/context'
import { createCommandContext, defaultIo } from './commands/context'
import { registerInspectCommand } from './commands/inspect'
import { registerIntrospectionCommands } from './commands/introspection'
import { registerLutCommands } from './commands/lut'
import { registerManifestCommands } from './commands/manifest'
import { registerMetricsCommands } from './commands/metrics'
import { registerRenderCommands } from './commands/render'
import { registerSessionCommands } from './commands/session'

function parsePositiveInt(value: string): number {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) throw new InvalidArgumentError('Expected a positive integer.')
  return parsed
}

export function createProgram(io: CliIo, setExitCode: (code: number) => void): Command {
  const program = new Command()
  program
    .name('lmfg')
    .description('Agent-friendly, reproducible RAW/LUT rendering CLI for LumaForge')
    .version(LMFG_VERSION, '-V, --version-string', 'print the lmfg version string')
    .option('--workspace <dir>', 'artifact root (default: .lmfg)')
    .option('--session <id>', 'session id')
    .addOption(new Option('--tier <tier>', 'render tier').choices(['cpu', 'browser']).default('cpu'))
    .addOption(new Option('--emit <mode>', 'stdout format').choices(['json', 'ndjson']).default('json'))
    .option('--json', 'single JSON result on stdout (default)')
    .option('--quiet', 'suppress stderr diagnostics', false)
    .option('--no-color', 'disable ANSI colors')
    .option('--dry-run', 'validate inputs and report the plan without rendering or writing', false)
    .option('--yes', 'non-interactive; assume yes', false)
    .option('--timeout <ms>', 'per-command timeout in milliseconds', parsePositiveInt)
    .addOption(new Option('--memory-profile <profile>', 'native memory profile').choices(['desktop', 'low-memory']).default('desktop'))
    .exitOverride()
    .configureOutput({ writeOut: io.stdout, writeErr: io.stderr })
    .showHelpAfterError(false)

  const host: CommandHost = {
    io,
    setExitCode,
    context: (command) => createCommandContext(io, command.optsWithGlobals() as GlobalOptions),
  }

  registerIntrospectionCommands(program, host)
  registerSessionCommands(program, host)
  registerInspectCommand(program, host)
  registerLutCommands(program, host)
  registerRenderCommands(program, host)
  registerCompareCommands(program, host)
  registerMetricsCommands(program, host)
  registerManifestCommands(program, host)
  return program
}

export async function runCli(argv: readonly string[], io: CliIo = defaultIo()): Promise<number> {
  let exitCode = 0
  const program = createProgram(io, (code) => {
    exitCode = code
  })
  try {
    await program.parseAsync([...argv], { from: 'user' })
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.exitCode === 0) return 0
      const mapped = new LmfgError('args.invalid', { message: error.message.replace(/^error: /, '').trim(), suggestedNextActions: ['lmfg --help'] })
      io.stdout(`${JSON.stringify(mapped.toEnvelope())}\n`)
      return mapped.exitCode
    }
    throw error
  }
  return exitCode
}
```

(Import paths: `LmfgError` comes from `./protocol/errors` — fix the relative path shown above to `./protocol/errors`.)

`src/index.ts`:

```ts
export { createProgram, runCli } from './cli'
export type { CliIo } from './commands/context'
export { EXIT_CODES } from './protocol/exit-codes'
export { LmfgError } from './protocol/errors'
export type { LmfgErrorCode } from './protocol/errors'
export { listSchemas, showSchema } from './schemas/registry'
```

Until Tasks 10–14 land, register only the modules that exist (comment out the others) so `cli.test.ts` can go green early; re-enable each as its task lands.

- [x] **Step 6: Run tests, lint, typecheck; commit**

Run: `pnpm --filter @lumaforge/lmfg-cli test src/cli.test.ts && pnpm --filter @lumaforge/lmfg-cli typecheck && pnpm exec eslint "packages/lmfg-cli/src/**/*.ts"`
Expected: PASS.

```bash
git add packages/lmfg-cli/src
git commit -m "feat(cli): wire the lmfg commander program with global options and introspection commands"
```

---

### Task 10: Inspect service, session commands, inspect command

**Files:**
- Create: `src/services/inspect.ts`, `src/commands/session.ts`, `src/commands/inspect.ts`
- Modify: `src/runtime/source-loader.ts` (add `loadSessionSource`), `src/workspace/atomic-fs.ts` (add `listFiles`), `src/schemas/results.ts` (`embedded_preview.uri` nullable)
- Test: `src/services/inspect.test.ts`, `src/runtime/source-loader.test.ts` (extend)

- [x] **Step 1: Write failing tests**

Append to `src/runtime/source-loader.test.ts`:

```ts
import { loadSessionSource } from './source-loader'

describe('loadSessionSource', () => {
  it('loads the session source and verifies its identity', async () => {
    const file = join(dir, 'c.dng')
    await writeFile(file, Buffer.from('c'))
    const source = await loadSourceFile(file, dir)
    const record = { source: { path: file, filename: 'c.dng', byte_size: 1, sha256: source.sha256 } }
    expect((await loadSessionSource(record as never)).sha256).toBe(source.sha256)
    await expect(loadSessionSource({ source: { ...record.source, sha256: '0'.repeat(64) } } as never)).rejects.toMatchObject({ code: 'hash.mismatch' })
  })
})
```

`src/services/inspect.test.ts` (runs only with the fixture; helper from Task 15 is inlined here to avoid a forward dependency):

```ts
// @vitest-environment node
import { existsSync } from 'node:fs'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { detectCapabilities } from '../runtime/capability'
import { createLmfgRuntime } from '../runtime/node-runtime'
import { loadSourceFile } from '../runtime/source-loader'
import { inspectSource } from './inspect'

const FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), '../../../luma-raw-runtime/fixtures/.cache/public/raw-pixls-iphone-se.dng')
const ready = existsSync(FIXTURE) && detectCapabilities({ memoryProfile: 'desktop' }).render_tiers.cpu_wasm.available
const d = ready ? describe : describe.skip

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'lmfg-inspect-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

d('inspectSource', () => {
  it('reports metadata, capability, exposure, and writes the embedded preview', async () => {
    const runtime = createLmfgRuntime({ memoryProfile: 'desktop' })
    try {
      const source = await loadSourceFile(FIXTURE, dir)
      const previewPath = join(dir, 'embedded-preview.jpg')
      const result = await inspectSource({ runtime, source, sessionId: null, embeddedPreviewPath: previewPath })
      expect(result.metadata.make).toMatch(/apple/i)
      expect(result.decoded_dimensions).toEqual({ width: 4032, height: 3024 })
      expect(result.export_capability).toMatchObject({ supported: true, strategy: 'libraw-processed-window' })
      expect(result.raw_render_exposure.source).toBe('dng-baseline')
      expect(result.embedded_preview?.uri).toMatch(/^file:\/\//)
      expect((await stat(previewPath)).size).toBeGreaterThan(1000)
    } finally {
      runtime.dispose()
    }
  }, 60_000)
})
```

- [x] **Step 2: Run to verify failure**

Run: `pnpm --filter @lumaforge/lmfg-cli test src/services/inspect src/runtime/source-loader`
Expected: FAIL — missing exports.

- [x] **Step 3: Small additions**

`src/runtime/source-loader.ts`, append:

```ts
import type { SessionRecord } from '../schemas/results'

export async function loadSessionSource(session: Pick<SessionRecord, 'source'>): Promise<LoadedSource> {
  const source = await loadSourceFile(session.source.path, '/')
  verifySourceIdentity(source, session.source.sha256)
  return source
}
```

`src/workspace/atomic-fs.ts`, append:

```ts
export async function listFiles(dir: string, suffix?: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isFile() && (!suffix || entry.name.endsWith(suffix)))
      .map((entry) => entry.name)
      .sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}
```

`src/schemas/results.ts`: change `embedded_preview` `uri: z.string()` to `uri: z.string().nullable()`.

- [x] **Step 4: Implement `src/services/inspect.ts`**

```ts
import type { LumaEmbeddedPreview, LumaRawExportCapability } from '@lumaforge/luma-raw-runtime'
import { QUICK_PREVIEW_MAX_PIXELS } from '@lumaforge/render-engine/preview'

import type { LmfgRuntime } from '../runtime/node-runtime'
import type { LoadedSource } from '../runtime/source-loader'
import { parseRenderParams } from '../schemas/params'
import type { InspectResult } from '../schemas/results'
import { writeFileAtomic } from '../workspace/atomic-fs'
import { toFileUri } from '../workspace/paths'
import { resolveExposure } from './color-graph'

export type InspectInput = {
  runtime: LmfgRuntime
  source: LoadedSource
  sessionId: string | null
  embeddedPreviewPath: string | null
  signal?: AbortSignal
}

function nullable<T>(value: T | undefined): T | null {
  return value === undefined ? null : value
}

export function decodedDimensions(capability: LumaRawExportCapability, probe: { width?: number; height?: number }) {
  if (capability.width > 0 && capability.height > 0) return { width: capability.width, height: capability.height }
  return { width: probe.width ?? 0, height: probe.height ?? 0 }
}

export async function inspectSource(input: InspectInput): Promise<InspectResult> {
  const timings: Record<string, number> = {}
  const started = performance.now()
  const raw = await input.runtime.raw()
  const session = await raw.openSession(input.source.input, { maxOutputPixels: QUICK_PREVIEW_MAX_PIXELS }, input.signal)
  try {
    const probe = session.probe
    timings.open_ms = performance.now() - started

    let embedded: LumaEmbeddedPreview | null = null
    const embeddedStart = performance.now()
    try {
      embedded = await session.extractEmbeddedPreview(input.signal)
    } catch {
      embedded = null
    }
    timings.embedded_preview_ms = performance.now() - embeddedStart

    const capabilityStart = performance.now()
    const capability = await session.probeExportCapability(input.signal)
    timings.export_capability_ms = performance.now() - capabilityStart

    const decodeStart = performance.now()
    const frame = await session.decodeQuick({ maxOutputPixels: QUICK_PREVIEW_MAX_PIXELS }, input.signal)
    timings.quick_decode_ms = performance.now() - decodeStart
    const exposure = resolveExposure(parseRenderParams({}), {
      baselineExposure: probe.baselineExposure,
      frame: { data: frame.data, width: frame.width, height: frame.height },
    })

    let embeddedUri: string | null = null
    if (embedded && input.embeddedPreviewPath) {
      await writeFileAtomic(input.embeddedPreviewPath, embedded.data)
      embeddedUri = toFileUri(input.embeddedPreviewPath)
    }

    timings.total_ms = performance.now() - started
    return {
      session_id: input.sessionId,
      source: { path: input.source.absolutePath, filename: input.source.filename, byte_size: input.source.byteSize, sha256: input.source.sha256 },
      metadata: {
        make: nullable(probe.make), model: nullable(probe.model), lens: nullable(probe.lens),
        iso: nullable(probe.iso), aperture: nullable(probe.aperture), focal_length: nullable(probe.focalLength), shutter: nullable(probe.shutter),
        timestamp: nullable(probe.timestamp), orientation: nullable(probe.orientation),
        width: nullable(probe.width), height: nullable(probe.height), raw_width: nullable(probe.rawWidth), raw_height: nullable(probe.rawHeight),
        baseline_exposure: nullable(probe.baselineExposure),
        support_level: probe.supportLevel,
      },
      decoded_dimensions: decodedDimensions(capability, probe),
      embedded_preview: embedded
        ? { width: embedded.width, height: embedded.height, mime_type: embedded.mimeType, byte_size: embedded.data.byteLength, uri: embeddedUri }
        : null,
      export_capability: {
        supported: capability.supported,
        strategy: capability.strategy ?? null,
        width: capability.width,
        height: capability.height,
        reasons: [...capability.reasons],
      },
      raw_render_exposure: exposure,
      timings_ms: timings,
    }
  } finally {
    session.dispose()
  }
}
```

- [x] **Step 5: Implement `src/commands/session.ts`**

```ts
import type { Command } from 'commander'

import { loadSourceFile } from '../runtime/source-loader'
import type { SessionStatusResult } from '../schemas/results'
import { fileExists, listFiles, readJsonOrNull } from '../workspace/atomic-fs'
import type { IterationRecord } from '../workspace/iteration-store'
import { workspacePaths, toFileUri } from '../workspace/paths'
import { createSessionStore } from '../workspace/session-store'
import type { CommandHost } from './context'
import { runCommand } from './context'

export function registerSessionCommands(program: Command, host: CommandHost): void {
  const session = program.command('session').description('Create and inspect .lmfg sessions')

  session
    .command('init')
    .requiredOption('--source <file>', 'RAW source file')
    .description('Create a session for a RAW file (computes its full-file sha256)')
    .action(async function (this: Command, options: { source: string }) {
      const ctx = host.context(this)
      host.setExitCode(
        await runCommand(
          ctx,
          { schema: 'lmfg.session.v1', command: 'session.init' },
          async () => {
            const source = await loadSourceFile(options.source, ctx.cwd)
            const store = createSessionStore(ctx.workspaceRoot)
            const record = await store.init({ sourcePath: source.absolutePath, sha256: source.sha256, byteSize: source.byteSize })
            ctx.output.log(`session ${record.id} created in ${ctx.workspaceRoot}`)
            return record
          },
          async () => {
            const source = await loadSourceFile(options.source, ctx.cwd)
            return { workspace_root: ctx.workspaceRoot, source: { path: source.absolutePath, sha256: source.sha256, byte_size: source.byteSize } }
          },
        ),
      )
    })

  session
    .command('status')
    .description('Show a session record with its iterations, previews, and exports')
    .action(async function (this: Command) {
      const ctx = host.context(this)
      host.setExitCode(
        await runCommand(ctx, { schema: 'lmfg.session.status.v1', command: 'session.status' }, async (): Promise<SessionStatusResult> => {
          const id = ctx.requireSession()
          const root = ctx.workspaceRoot
          const record = await createSessionStore(root).load(id)
          const iterationIds = await listFiles(workspacePaths.iterations(root, id)).then(() => []) // directories only below
          const { listDirs } = await import('../workspace/atomic-fs')
          const iterations: SessionStatusResult['iterations'] = []
          for (const iterationId of await listDirs(workspacePaths.iterations(root, id))) {
            const plan = await readJsonOrNull<IterationRecord>(workspacePaths.iterationPlanFile(root, id, iterationId))
            if (!plan) continue
            iterations.push({
              id: iterationId,
              created_at: plan.created_at,
              kind: plan.kind,
              candidate_count: plan.candidates.length,
              contact_sheet: await fileExists(workspacePaths.contactSheetFile(root, id, iterationId)),
            })
          }
          void iterationIds
          const previews = (await listFiles(workspacePaths.previews(root, id), '.jpg')).map((name) => name.replace(/\.jpg$/, ''))
          const exports = []
          for (const name of await listFiles(workspacePaths.exports(root, id), '.jpg')) {
            const base = name.replace(/\.jpg$/, '')
            exports.push({ name: base, output_uri: toFileUri(workspacePaths.exportFile(root, id, base)), manifest_uri: toFileUri(workspacePaths.exportManifestFile(root, id, base)) })
          }
          return {
            ...record,
            session_dir: workspacePaths.session(root, id),
            source_present: await fileExists(record.source.path),
            iterations,
            previews,
            exports,
          }
        }),
      )
    })

  session
    .command('list')
    .description('List sessions in the workspace')
    .action(async function (this: Command) {
      const ctx = host.context(this)
      host.setExitCode(
        await runCommand(ctx, { schema: 'lmfg.session.list.v1', command: 'session.list' }, async () => ({
          workspace_root: ctx.workspaceRoot,
          sessions: await createSessionStore(ctx.workspaceRoot).list(),
        })),
      )
    })
}
```

(When implementing, drop the `iterationIds`/dynamic-import lines and import `listDirs` statically at the top; they are shown only to make the data flow explicit.)

- [x] **Step 6: Implement `src/commands/inspect.ts`**

```ts
import type { Command } from 'commander'

import { assertTierAvailable } from '../runtime/capability'
import { createLmfgRuntime } from '../runtime/node-runtime'
import { loadSessionSource, loadSourceFile } from '../runtime/source-loader'
import { inspectSource } from '../services/inspect'
import { writeJsonAtomic } from '../workspace/atomic-fs'
import { workspacePaths } from '../workspace/paths'
import { createSessionStore } from '../workspace/session-store'
import type { CommandHost } from './context'
import { runCommand } from './context'

export function registerInspectCommand(program: Command, host: CommandHost): void {
  program
    .command('inspect')
    .argument('[file]', 'RAW file (omit to inspect the --session source)')
    .description('Probe a RAW file: metadata, embedded preview, export capability, render exposure')
    .action(async function (this: Command, file: string | undefined) {
      const ctx = host.context(this)
      host.setExitCode(
        await runCommand(
          ctx,
          { schema: 'lmfg.inspect.v1', command: 'inspect' },
          async () => {
            assertTierAvailable(ctx.options.tier)
            const runtime = createLmfgRuntime({ memoryProfile: ctx.options.memoryProfile })
            try {
              if (file) {
                const source = await loadSourceFile(file, ctx.cwd)
                return await inspectSource({ runtime, source, sessionId: null, embeddedPreviewPath: null, signal: ctx.signal })
              }
              const id = ctx.requireSession()
              const store = createSessionStore(ctx.workspaceRoot)
              const record = await store.load(id)
              const source = await loadSessionSource(record)
              const result = await inspectSource({
                runtime, source, sessionId: id,
                embeddedPreviewPath: workspacePaths.embeddedPreviewFile(ctx.workspaceRoot, id),
                signal: ctx.signal,
              })
              await writeJsonAtomic(workspacePaths.inspectFile(ctx.workspaceRoot, id), { schema: 'lmfg.inspect.v1', ...result })
              await store.update(id, (rec) => ({ ...rec, status: 'inspected', decoded_dimensions: result.decoded_dimensions }))
              return result
            } finally {
              runtime.dispose()
            }
          },
          async () => {
            const source = file ? await loadSourceFile(file, ctx.cwd) : await loadSessionSource(await createSessionStore(ctx.workspaceRoot).load(ctx.requireSession()))
            return { source: { path: source.absolutePath, sha256: source.sha256, byte_size: source.byteSize }, tier: ctx.options.tier }
          },
        ),
      )
    })
}
```

- [x] **Step 7: Enable the modules in `cli.ts`, run tests, commit**

Run: `pnpm --filter @lumaforge/lmfg-cli test && pnpm --filter @lumaforge/lmfg-cli typecheck`
Expected: PASS.

```bash
git add packages/lmfg-cli/src
git commit -m "feat(cli): add session init/status/list and inspect commands"
```

---

### Task 11: Manifest service and `manifest verify/show`

**Files:**
- Create: `src/services/manifest.ts`, `src/commands/manifest.ts`
- Test: `src/services/manifest.test.ts`

- [x] **Step 1: Write failing tests**

```ts
// @vitest-environment node
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { resolveRenderEnvironment } from '../runtime/versions'
import { parseRenderParams } from '../schemas/params'
import { buildColorGraph, requireSupportedGraph } from './color-graph'
import { buildRenderManifest, percentToQuality, qualityToPercent, verifyManifestFile } from './manifest'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'lmfg-manifest-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const environment = resolveRenderEnvironment('desktop')
const exposure = { ev: 0, multiplier: 1, source: 'identity' as const }
const source = { sha256: 'a'.repeat(64), byte_size: 10, filename: 'x.dng', decoded_dimensions: { width: 4, height: 2 } }

function build(kind: 'preview' | 'candidate' | 'export' = 'preview') {
  const params = parseRenderParams({ contrast: 5 })
  return buildRenderManifest({
    kind, source, lut: null, graph: requireSupportedGraph(buildColorGraph(params, null, exposure)), params, exposure,
    policy: { kind: 'preview-quick', row_slice: 32, concurrency: 1 }, environment,
    output: { width: 4, height: 2, quality: 85, filename: 'p.jpg', sha256: 'b'.repeat(64) },
    parentManifestSha256: null, producedAt: new Date('2026-09-05T00:00:00Z'),
  })
}

describe('manifest service', () => {
  it('builds a sealed manifest with a color-graph fingerprint', () => {
    const manifest = build()
    expect(manifest.manifest_version).toBe(1)
    expect(manifest.manifest_sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(manifest.color_graph.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(manifest.render_params.tone_curve?.contrast).toBe(5)
    expect(manifest.produced_at).toBe('2026-09-05T00:00:00.000Z')
  })

  it('verifies files, detects tampering, and warns on environment drift', async () => {
    const manifest = build('export')
    const file = join(dir, 'm.json')
    await writeFile(file, JSON.stringify(manifest))
    const ok = await verifyManifestFile(file, { environment })
    expect(ok.valid).toBe(true)
    expect(ok.environment_match).toBe(true)
    const tampered = { ...manifest, render_params: { ...manifest.render_params, exposure_ev: 9 } }
    await writeFile(file, JSON.stringify(tampered))
    const bad = await verifyManifestFile(file, { environment })
    expect(bad.valid).toBe(false)
    expect(bad.issues[0]).toMatch(/manifest_sha256/)
    await writeFile(file, JSON.stringify(manifest))
    const drift = await verifyManifestFile(file, { environment: { ...environment, render_engine: '9.9.9' } })
    expect(drift.valid).toBe(true)
    expect(drift.environment_match).toBe(false)
    expect(drift.warnings.join(' ')).toMatch(/render_engine/)
  })

  it('converts quality between percent and unit scale', () => {
    expect(qualityToPercent(0.92)).toBe(92)
    expect(percentToQuality(85)).toBe(0.85)
  })
})
```

- [x] **Step 2: Run to verify failure**

Run: `pnpm --filter @lumaforge/lmfg-cli test src/services/manifest`
Expected: FAIL.

- [x] **Step 3: Implement `src/services/manifest.ts`**

```ts
import { readFile } from 'node:fs/promises'

import type { RawRenderExposure, SupportedExportColorGraphDescriptor } from '@lumaforge/luma-color-runtime'
import type { LutIdentity, PolicyChoice, RenderEnvironment, RenderManifest, RenderManifestKind, SourceRawIdentity } from '@lumaforge/render-engine'
import { sealRenderManifest, verifyManifestSha256 } from '@lumaforge/render-engine'

import { LmfgError } from '../protocol/errors'
import type { LoadedSource } from '../runtime/source-loader'
import type { RenderParams } from '../schemas/params'
import { toColorGraphIdentity, toManifestRenderParams } from './color-graph'

export type BuildManifestInput = {
  kind: RenderManifestKind
  source: SourceRawIdentity
  lut: LutIdentity | null
  graph: SupportedExportColorGraphDescriptor
  params: RenderParams
  exposure: RawRenderExposure
  policy: PolicyChoice
  environment: RenderEnvironment
  output: { width: number; height: number; quality: number; filename: string; sha256: string }
  parentManifestSha256: string | null
  producedAt?: Date
}

export function qualityToPercent(quality: number): number {
  return Math.round(quality * 100)
}

export function percentToQuality(percent: number): number {
  return percent / 100
}

export function toSourceIdentity(source: LoadedSource, dims: { width: number; height: number }): SourceRawIdentity {
  return { sha256: source.sha256, byte_size: source.byteSize, filename: source.filename, decoded_dimensions: dims }
}

export function buildRenderManifest(input: BuildManifestInput): RenderManifest {
  return sealRenderManifest({
    manifest_version: 1,
    kind: input.kind,
    produced_at: (input.producedAt ?? new Date()).toISOString(),
    parent_manifest_sha256: input.parentManifestSha256,
    source_raw: input.source,
    calibration: null,
    lut: input.lut,
    color_graph: toColorGraphIdentity(input.graph),
    render_params: toManifestRenderParams(input.params, input.exposure),
    policy: input.policy,
    environment: input.environment,
    output: {
      format: 'jpeg',
      dimensions: { width: input.output.width, height: input.output.height },
      color_space: 'srgb',
      quality: input.output.quality,
      filename: input.output.filename,
      sha256: input.output.sha256,
    },
  })
}

export type ManifestVerification = {
  valid: boolean
  issues: string[]
  warnings: string[]
  environment_match: boolean | null
  manifest: RenderManifest | null
  raw: Record<string, unknown> | null
}

const REQUIRED_KEYS = ['manifest_version', 'kind', 'produced_at', 'parent_manifest_sha256', 'source_raw', 'calibration', 'lut', 'color_graph', 'render_params', 'policy', 'environment', 'output', 'manifest_sha256'] as const
const KINDS = new Set(['preview', 'candidate', 'export'])

export async function verifyManifestFile(path: string, options: { environment: RenderEnvironment }): Promise<ManifestVerification> {
  const issues: string[] = []
  const warnings: string[] = []
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new LmfgError('file.not_found', { message: `Manifest not found: ${path}` })
    }
    return { valid: false, issues: ['Manifest is not valid JSON.'], warnings, environment_match: null, manifest: null, raw: null }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { valid: false, issues: ['Manifest must be a JSON object.'], warnings, environment_match: null, manifest: null, raw: null }
  }
  for (const key of REQUIRED_KEYS) if (!(key in raw)) issues.push(`Missing required field "${key}".`)
  if (!verifyManifestSha256(raw)) issues.push('manifest_sha256 does not match the canonical content (tampered or corrupted).')
  if (raw.manifest_version !== 1) issues.push(`Unsupported manifest_version ${String(raw.manifest_version)}; this lmfg reads version 1.`)
  if (!KINDS.has(String(raw.kind))) issues.push(`Unknown manifest kind "${String(raw.kind)}".`)

  let environmentMatch: boolean | null = null
  const environment = raw.environment as Partial<RenderEnvironment> | undefined
  if (environment && typeof environment === 'object') {
    environmentMatch = true
    for (const key of ['render_engine', 'luma_color_runtime', 'luma_raw_runtime', 'luma_jpeg_runtime'] as const) {
      if (environment[key] !== options.environment[key]) {
        environmentMatch = false
        warnings.push(`environment.${key} is ${String(environment[key])}; current runtime is ${options.environment[key]}.`)
      }
    }
    if (environment.native_artifacts?.build_id !== options.environment.native_artifacts.build_id) {
      environmentMatch = false
      warnings.push(`environment.native_artifacts.build_id differs from the current artifacts (${options.environment.native_artifacts.build_id}).`)
    }
  }

  const valid = issues.length === 0
  return { valid, issues, warnings, environment_match: environmentMatch, manifest: valid ? (raw as unknown as RenderManifest) : null, raw }
}

export async function requireVerifiedManifest(path: string, environment: RenderEnvironment): Promise<{ manifest: RenderManifest; warnings: string[] }> {
  const verification = await verifyManifestFile(path, { environment })
  if (!verification.valid || !verification.manifest) {
    throw new LmfgError('manifest.invalid', {
      message: `Manifest ${path} failed verification: ${verification.issues.join(' ')}`,
      details: { issues: verification.issues, warnings: verification.warnings },
    })
  }
  return { manifest: verification.manifest, warnings: verification.warnings }
}
```

- [x] **Step 4: Implement `src/commands/manifest.ts`**

```ts
import type { Command } from 'commander'

import { LmfgError } from '../protocol/errors'
import { resolveRenderEnvironment } from '../runtime/versions'
import { requireVerifiedManifest, verifyManifestFile } from '../services/manifest'
import type { CommandHost } from './context'
import { runCommand } from './context'

export function registerManifestCommands(program: Command, host: CommandHost): void {
  const manifest = program.command('manifest').description('Verify and display render manifests')

  manifest
    .command('verify')
    .argument('<file>', 'manifest JSON file')
    .description('Recompute the canonical hash and check the manifest contract')
    .action(async function (this: Command, file: string) {
      const ctx = host.context(this)
      host.setExitCode(
        await runCommand(ctx, { schema: 'lmfg.manifest.verify.v1', command: 'manifest.verify' }, async () => {
          const path = ctx.resolvePath(file)
          const verification = await verifyManifestFile(path, { environment: resolveRenderEnvironment(ctx.options.memoryProfile) })
          const result = {
            path,
            valid: verification.valid,
            manifest_sha256: typeof verification.raw?.manifest_sha256 === 'string' ? (verification.raw.manifest_sha256 as string) : null,
            kind: typeof verification.raw?.kind === 'string' ? (verification.raw.kind as string) : null,
            issues: verification.issues,
            warnings: verification.warnings,
            environment_match: verification.environment_match,
          }
          if (!verification.valid) {
            throw new LmfgError('manifest.invalid', { message: `Manifest failed verification: ${verification.issues.join(' ')}`, details: result })
          }
          return result
        }),
      )
    })

  manifest
    .command('show')
    .argument('<file>', 'manifest JSON file')
    .description('Print a verified manifest')
    .action(async function (this: Command, file: string) {
      const ctx = host.context(this)
      host.setExitCode(
        await runCommand(ctx, { schema: 'lmfg.manifest.show.v1', command: 'manifest.show' }, async () => {
          const path = ctx.resolvePath(file)
          const { manifest: verified, warnings } = await requireVerifiedManifest(path, resolveRenderEnvironment(ctx.options.memoryProfile))
          return { path, verified: true, warnings, manifest: verified as unknown as Record<string, unknown> }
        }),
      )
    })
}
```

- [x] **Step 5: Run tests, commit**

Run: `pnpm --filter @lumaforge/lmfg-cli test src/services/manifest && pnpm --filter @lumaforge/lmfg-cli typecheck`
Expected: PASS.

```bash
git add packages/lmfg-cli/src/services/manifest.ts packages/lmfg-cli/src/services/manifest.test.ts packages/lmfg-cli/src/commands/manifest.ts packages/lmfg-cli/src/cli.ts
git commit -m "feat(cli): build sealed render manifests and add manifest verify/show"
```

---

### Task 12: Preview service and `render preview`

**Files:**
- Create: `src/services/preview.ts`, `src/commands/render-shared.ts`, `src/commands/render.ts`
- Test: `src/services/preview.test.ts` (fixture-gated), command coverage in Task 15

- [x] **Step 1: Write the failing test**

```ts
// @vitest-environment node
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { detectCapabilities } from '../runtime/capability'
import { createLmfgRuntime } from '../runtime/node-runtime'
import { loadSourceFile } from '../runtime/source-loader'
import { parseRenderParams } from '../schemas/params'
import { renderPreview } from './preview'

const FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), '../../../luma-raw-runtime/fixtures/.cache/public/raw-pixls-iphone-se.dng')
const ready = existsSync(FIXTURE) && detectCapabilities({ memoryProfile: 'desktop' }).render_tiers.cpu_wasm.available
const d = ready ? describe : describe.skip

d('renderPreview', () => {
  it('decodes a quick frame, renders through the CPU graph, and encodes a JPEG', async () => {
    const runtime = createLmfgRuntime({ memoryProfile: 'desktop' })
    try {
      const source = await loadSourceFile(FIXTURE, '/')
      const result = await renderPreview({ runtime, source, params: parseRenderParams({ contrast: 20 }), lut: null, maxPixels: 500_000, quality: 0.8 })
      expect(result.frame.decode).toBe('quick')
      expect(result.frame.width * result.frame.height).toBeLessThanOrEqual(500_000)
      expect(result.rendered.jpeg[0]).toBe(0xff)
      expect(result.rendered.jpeg[1]).toBe(0xd8)
      expect(result.rendered.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(result.exposure.source).toBe('dng-baseline')
      expect(result.rendered.rgba.length).toBe(result.frame.width * result.frame.height * 4)
    } finally {
      runtime.dispose()
    }
  }, 60_000)
})
```

- [x] **Step 2: Run to verify failure**

Run: `pnpm --filter @lumaforge/lmfg-cli test src/services/preview`
Expected: FAIL.

- [x] **Step 3: Implement `src/services/preview.ts`**

```ts
import type { RawRenderExposure, SupportedExportColorGraphDescriptor } from '@lumaforge/luma-color-runtime'
import type { LumaJpegNodeRuntime } from '@lumaforge/luma-jpeg-runtime/node'
import type { LumaRawDecodeSession, LumaRawProbe } from '@lumaforge/luma-raw-runtime'
import { sha256Hex } from '@lumaforge/render-engine'
import { BOUNDED_HQ_PREVIEW_MAX_PIXELS, encodePreviewFrameToJpeg, QUICK_PREVIEW_MAX_PIXELS, renderCpuPreviewFrame } from '@lumaforge/render-engine/preview'

import type { LmfgRuntime } from '../runtime/node-runtime'
import type { LoadedSource } from '../runtime/source-loader'
import type { RenderParams } from '../schemas/params'
import { buildColorGraph, requireSupportedGraph, resolveExposure } from './color-graph'
import type { ResolvedLut } from './lut'

export type DecodedFrame = { data: Uint16Array; width: number; height: number; decode: 'quick' | 'bounded-hq' }

export function clampMaxPixels(maxPixels: number | undefined): number {
  if (!maxPixels || !Number.isFinite(maxPixels) || maxPixels <= 0) return QUICK_PREVIEW_MAX_PIXELS
  return Math.min(Math.floor(maxPixels), BOUNDED_HQ_PREVIEW_MAX_PIXELS)
}

export async function decodeFrame(session: LumaRawDecodeSession, maxPixels: number, signal?: AbortSignal): Promise<DecodedFrame> {
  if (maxPixels <= QUICK_PREVIEW_MAX_PIXELS) {
    const frame = await session.decodeQuick({ maxOutputPixels: maxPixels }, signal)
    return { data: frame.data, width: frame.width, height: frame.height, decode: 'quick' }
  }
  const frame = await session.decodeBoundedHq({ maxOutputPixels: maxPixels }, signal)
  return { data: frame.data, width: frame.width, height: frame.height, decode: 'bounded-hq' }
}

export type RenderedFrame = {
  rgba: Uint8ClampedArray
  width: number
  height: number
  jpeg: Uint8Array
  sha256: string
  timings: { render_ms: number; encode_ms: number }
}

export async function renderFrameToJpeg(input: {
  frame: Pick<DecodedFrame, 'data' | 'width' | 'height'>
  graph: SupportedExportColorGraphDescriptor
  jpegRuntime: LumaJpegNodeRuntime
  quality: number
}): Promise<RenderedFrame> {
  const renderStart = performance.now()
  const rgba = renderCpuPreviewFrame({ data: input.frame.data, width: input.frame.width, height: input.frame.height, graph: input.graph })
  const render_ms = performance.now() - renderStart
  const encodeStart = performance.now()
  const jpeg = (await encodePreviewFrameToJpeg((options) => input.jpegRuntime.createEncoder(options), {
    rgba, width: input.frame.width, height: input.frame.height, quality: input.quality,
  })) as Uint8Array
  return { rgba, width: input.frame.width, height: input.frame.height, jpeg, sha256: sha256Hex(jpeg), timings: { render_ms, encode_ms: performance.now() - encodeStart } }
}

export type PreviewRenderInput = {
  runtime: LmfgRuntime
  source: LoadedSource
  params: RenderParams
  lut: ResolvedLut | null
  maxPixels: number
  quality: number
  signal?: AbortSignal
}

export type PreviewRenderResult = {
  probe: LumaRawProbe
  frame: DecodedFrame
  exposure: RawRenderExposure
  graph: SupportedExportColorGraphDescriptor
  rendered: RenderedFrame
  timings: Record<string, number>
}

export async function renderPreview(input: PreviewRenderInput): Promise<PreviewRenderResult> {
  const timings: Record<string, number> = {}
  const total = performance.now()
  const raw = await input.runtime.raw()
  const maxPixels = clampMaxPixels(input.maxPixels)
  const session = await raw.openSession(input.source.input, { maxOutputPixels: Math.min(maxPixels, QUICK_PREVIEW_MAX_PIXELS) }, input.signal)
  try {
    const decodeStart = performance.now()
    const frame = await decodeFrame(session, maxPixels, input.signal)
    timings.decode_ms = performance.now() - decodeStart
    const exposure = resolveExposure(input.params, { baselineExposure: session.probe.baselineExposure, frame })
    const graph = requireSupportedGraph(buildColorGraph(input.params, input.lut?.lutData ?? null, exposure))
    const rendered = await renderFrameToJpeg({ frame, graph, jpegRuntime: await input.runtime.jpeg(), quality: input.quality })
    timings.render_ms = rendered.timings.render_ms
    timings.encode_ms = rendered.timings.encode_ms
    timings.total_ms = performance.now() - total
    return { probe: session.probe, frame, exposure, graph, rendered, timings }
  } finally {
    session.dispose()
  }
}
```

- [x] **Step 4: Implement `src/commands/render-shared.ts`**

```ts
import { InvalidArgumentError } from 'commander'

import { assertTierAvailable } from '../runtime/capability'
import type { LmfgRuntime } from '../runtime/node-runtime'
import { createLmfgRuntime } from '../runtime/node-runtime'
import type { LoadedSource } from '../runtime/source-loader'
import { loadSessionSource } from '../runtime/source-loader'
import type { RenderEnvironment } from '@lumaforge/render-engine'
import { resolveRenderEnvironment } from '../runtime/versions'
import type { RenderParams } from '../schemas/params'
import { parseRenderParams } from '../schemas/params'
import type { SessionRecord } from '../schemas/results'
import type { ResolvedLut } from '../services/lut'
import { resolveLutForParams } from '../services/lut'
import { readJson } from '../workspace/atomic-fs'
import type { SessionStore } from '../workspace/session-store'
import { createSessionStore } from '../workspace/session-store'
import type { CommandContext } from './context'

export function parseQualityPercent(value: string): number {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) throw new InvalidArgumentError('Expected an integer between 1 and 100.')
  return parsed
}

export function parsePositiveInteger(value: string): number {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isInteger(parsed) || parsed <= 0) throw new InvalidArgumentError('Expected a positive integer.')
  return parsed
}

export async function loadParamsFile(ctx: CommandContext, file: string | undefined): Promise<RenderParams> {
  return parseRenderParams(file ? await readJson(ctx.resolvePath(file)) : {})
}

export type RenderSessionContext = {
  store: SessionStore
  record: SessionRecord
  source: LoadedSource
  environment: RenderEnvironment
}

export async function openRenderSession(ctx: CommandContext): Promise<RenderSessionContext> {
  assertTierAvailable(ctx.options.tier)
  const store = createSessionStore(ctx.workspaceRoot)
  const record = await store.load(ctx.requireSession())
  const source = await loadSessionSource(record)
  return { store, record, source, environment: resolveRenderEnvironment(ctx.options.memoryProfile) }
}

export async function resolveParamsAndLut(ctx: CommandContext, params: RenderParams): Promise<{ params: RenderParams; lut: ResolvedLut | null }> {
  return { params, lut: await resolveLutForParams(params.lut, ctx.cwd) }
}

export async function withRuntime<T>(ctx: CommandContext, run: (runtime: LmfgRuntime) => Promise<T>): Promise<T> {
  const runtime = createLmfgRuntime({ memoryProfile: ctx.options.memoryProfile })
  try {
    return await run(runtime)
  } finally {
    runtime.dispose()
  }
}
```

- [x] **Step 5: Implement `src/commands/render.ts` (preview only; candidate/sweep/export are added in Tasks 13–14)**

```ts
import type { Command } from 'commander'

import { formatPreviewId } from '../workspace/ids'
import { writeFileAtomic, writeJsonAtomic } from '../workspace/atomic-fs'
import { toFileUri, workspacePaths } from '../workspace/paths'
import { buildRenderManifest, percentToQuality, toSourceIdentity } from '../services/manifest'
import { clampMaxPixels, renderPreview } from '../services/preview'
import type { PreviewResult } from '../schemas/results'
import type { CommandHost } from './context'
import { runCommand } from './context'
import { loadParamsFile, openRenderSession, parsePositiveInteger, parseQualityPercent, resolveParamsAndLut, withRuntime } from './render-shared'

export function registerRenderCommands(program: Command, host: CommandHost): void {
  const render = program.command('render').description('Render previews, candidates, sweeps, and full-resolution exports')

  render
    .command('preview')
    .description('Render one CPU preview for a params file and write it into the session')
    .option('--params <file>', 'params JSON (lmfg.params.v1); defaults apply when omitted')
    .option('--max-pixels <n>', 'decode budget in pixels (quick ≤ 2.5 MP, bounded HQ up to 12 MP)', parsePositiveInteger)
    .option('--quality <n>', 'JPEG quality 1-100', parseQualityPercent, 85)
    .action(async function (this: Command, options: { params?: string; maxPixels?: number; quality: number }) {
      const ctx = host.context(this)
      host.setExitCode(
        await runCommand(
          ctx,
          { schema: 'lmfg.render.preview.v1', command: 'render.preview' },
          async (): Promise<PreviewResult> => {
            const { store, record, source, environment } = await openRenderSession(ctx)
            const { params, lut } = await resolveParamsAndLut(ctx, await loadParamsFile(ctx, options.params))
            const maxPixels = clampMaxPixels(options.maxPixels)
            return withRuntime(ctx, async (runtime) => {
              const result = await renderPreview({ runtime, source, params, lut, maxPixels, quality: percentToQuality(options.quality), signal: ctx.signal })
              const previewId = formatPreviewId(await store.allocate(record.id, 'previews'))
              const root = ctx.workspaceRoot
              const outputPath = workspacePaths.previewFile(root, record.id, previewId)
              const manifestPath = workspacePaths.previewManifestFile(root, record.id, previewId)
              const manifest = buildRenderManifest({
                kind: 'preview',
                source: toSourceIdentity(source, record.decoded_dimensions ?? { width: result.probe.width ?? result.frame.width, height: result.probe.height ?? result.frame.height }),
                lut: lut?.identity ?? null,
                graph: result.graph,
                params,
                exposure: result.exposure,
                policy: { kind: result.frame.decode === 'quick' ? 'preview-quick' : 'preview-bounded-hq', row_slice: 32, concurrency: 1 },
                environment,
                output: { width: result.frame.width, height: result.frame.height, quality: options.quality, filename: `${previewId}.jpg`, sha256: result.rendered.sha256 },
                parentManifestSha256: null,
              })
              await writeFileAtomic(outputPath, result.rendered.jpeg)
              await writeJsonAtomic(manifestPath, manifest)
              ctx.output.event({ event: 'artifact.ready', role: 'preview', uri: toFileUri(outputPath) })
              return {
                session_id: record.id,
                preview_id: previewId,
                output: { uri: toFileUri(outputPath), path: outputPath, width: result.frame.width, height: result.frame.height, byte_size: result.rendered.jpeg.byteLength, sha256: result.rendered.sha256, quality: options.quality },
                manifest_uri: toFileUri(manifestPath),
                manifest_sha256: manifest.manifest_sha256,
                decode: result.frame.decode,
                raw_render_exposure: result.exposure,
                color_graph_fingerprint: manifest.color_graph.fingerprint,
                timings_ms: result.timings,
              }
            })
          },
          async () => {
            const { record } = await openRenderSession(ctx)
            const { params, lut } = await resolveParamsAndLut(ctx, await loadParamsFile(ctx, options.params))
            return { session_id: record.id, params, lut: lut?.identity ?? null, max_pixels: clampMaxPixels(options.maxPixels), quality: options.quality }
          },
        ),
      )
    })
}
```

- [x] **Step 6: Run, lint, commit**

Run: `pnpm --filter @lumaforge/lmfg-cli test && pnpm --filter @lumaforge/lmfg-cli typecheck && pnpm exec eslint "packages/lmfg-cli/src/**/*.ts"`
Expected: PASS.

```bash
git add packages/lmfg-cli/src
git commit -m "feat(cli): add CPU preview rendering and render preview command"
```

---

### Task 13: Metrics, contact sheet, iteration runner, `render candidate/sweep`, `compare sheet`, `metrics compute`

**Files:**
- Create: `src/services/metrics.ts`, `src/services/contact-sheet.ts`, `src/services/iteration.ts`, `src/commands/compare.ts`, `src/commands/metrics.ts`
- Modify: `src/commands/render.ts` (add `candidate`, `sweep`)
- Test: `src/services/metrics.test.ts`, `src/services/contact-sheet.test.ts`, `src/services/iteration.test.ts` (fixture-gated)

- [x] **Step 1: Write failing tests**

`src/services/metrics.test.ts`:

```ts
// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { computeImageMetrics } from './metrics'

function solid(width: number, height: number, [r, g, b]: [number, number, number]) {
  const rgba = new Uint8ClampedArray(width * height * 4)
  for (let p = 0; p < width * height; p += 1) rgba.set([r, g, b, 255], p * 4)
  return rgba
}

describe('computeImageMetrics', () => {
  it('measures white as clipped highlights with zero saturation', () => {
    const m = computeImageMetrics(solid(8, 4, [255, 255, 255]), 8, 4)
    expect(m.schema).toBe('lmfg.metrics.v1')
    expect(m.luma.mean).toBeCloseTo(1, 5)
    expect(m.luma.clipped_highlight_ratio).toBe(1)
    expect(m.luma.clipped_shadow_ratio).toBe(0)
    expect(m.chroma.mean_saturation).toBe(0)
    expect(m.histogram.luma.reduce((a, b) => a + b, 0)).toBe(m.sampled_pixels)
  })

  it('measures black as clipped shadows and red as saturated', () => {
    expect(computeImageMetrics(solid(4, 4, [0, 0, 0]), 4, 4).luma.clipped_shadow_ratio).toBe(1)
    const red = computeImageMetrics(solid(4, 4, [255, 0, 0]), 4, 4)
    expect(red.chroma.mean_saturation).toBe(1)
    expect(red.chroma.colorfulness).toBeGreaterThan(50)
    expect(red.approximate).toBe(false)
  })

  it('subsamples large images and flags approximate results', () => {
    const m = computeImageMetrics(solid(1000, 1000, [128, 128, 128]), 1000, 1000, { maxSamples: 1000, approximate: true })
    expect(m.sampled_pixels).toBeLessThanOrEqual(1001)
    expect(m.luma.p50).toBeCloseTo(128 / 255, 3)
    expect(m.approximate).toBe(true)
  })
})
```

`src/services/contact-sheet.test.ts`:

```ts
// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { buildContactSheet, downsampleRgba, fitTileSize } from './contact-sheet'

describe('contact sheet helpers', () => {
  it('fits tiles preserving aspect ratio and never upsamples', () => {
    expect(fitTileSize(4000, 3000, 320)).toEqual({ width: 320, height: 240 })
    expect(fitTileSize(100, 50, 320)).toEqual({ width: 100, height: 50 })
  })

  it('box-averages when downsampling', () => {
    const src = new Uint8ClampedArray([
      0, 0, 0, 255, 100, 100, 100, 255,
      200, 200, 200, 255, 100, 100, 100, 255,
    ])
    const dst = downsampleRgba(src, 2, 2, 1, 1)
    expect([...dst]).toEqual([100, 100, 100, 255])
  })

  it('lays tiles out on a grid and reports their positions', () => {
    const tile = (v: number) => ({ id: `cand_000${v}`, rgba: new Uint8ClampedArray([v, v, v, 255, v, v, v, 255]), width: 2, height: 1 })
    const built = buildContactSheet({ tiles: [tile(1), tile(2), tile(3)], cols: 2, gap: 1 })
    expect(built.rows).toBe(2)
    expect(built.sheet.width).toBe(5)
    expect(built.sheet.height).toBe(3)
    expect(built.map.map((t) => [t.candidate_id, t.x, t.y])).toEqual([['cand_0001', 0, 0], ['cand_0002', 3, 0], ['cand_0003', 0, 2]])
    expect(built.sheet.rgba[(0 * 5 + 3) * 4]).toBe(2)
  })
})
```

`src/services/iteration.test.ts` (fixture-gated, exercises the runner end to end):

```ts
// @vitest-environment node
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Output } from '../protocol/output'
import { detectCapabilities } from '../runtime/capability'
import { createLmfgRuntime } from '../runtime/node-runtime'
import { loadSourceFile } from '../runtime/source-loader'
import { resolveRenderEnvironment } from '../runtime/versions'
import { expandSweepPlan } from '../schemas/plan'
import { createIterationStore } from '../workspace/iteration-store'
import { createSessionStore } from '../workspace/session-store'
import { runIteration } from './iteration'

const FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), '../../../luma-raw-runtime/fixtures/.cache/public/raw-pixls-iphone-se.dng')
const ready = existsSync(FIXTURE) && detectCapabilities({ memoryProfile: 'desktop' }).render_tiers.cpu_wasm.available
const d = ready ? describe : describe.skip

let root: string
beforeEach(async () => { root = join(await mkdtemp(join(tmpdir(), 'lmfg-iter-')), '.lmfg') })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

d('runIteration', () => {
  it('renders a sweep with events, manifests, metrics, tiles, and a contact sheet', async () => {
    const runtime = createLmfgRuntime({ memoryProfile: 'desktop' })
    const events: string[] = []
    try {
      const source = await loadSourceFile(FIXTURE, '/')
      const store = createSessionStore(root)
      const record = await store.init({ sourcePath: source.absolutePath, sha256: source.sha256, byteSize: source.byteSize })
      const output = new Output({ emit: 'ndjson', quiet: true, color: false, stdout: (s) => events.push(s), stderr: () => {} })
      const result = await runIteration({
        runtime, source, record, store, iterationStore: createIterationStore(root, record.id),
        environment: resolveRenderEnvironment('desktop'), output, cwd: root,
        plan: expandSweepPlan({ axes: { exposure_ev: [-1, 1], contrast: [0, 30] } }),
        options: { maxPixels: 300_000, quality: 80, contactSheet: true, sheetOptions: { cols: 2, tile_width: 160 } },
      })
      expect(result.iteration_id).toBe('iter_0001')
      expect(result.candidates).toHaveLength(4)
      expect(result.contact_sheet).toMatchObject({ cols: 2, rows: 2, tile_width: 160 })
      expect(new Set(result.candidates.map((c) => c.manifest_sha256)).size).toBe(4)
      const manifest = JSON.parse(await readFile(join(root, 'sessions', record.id, 'iterations', 'iter_0001', 'candidates', 'cand_0002', 'manifest.json'), 'utf8'))
      expect(manifest.kind).toBe('candidate')
      expect(manifest.render_params).toMatchObject({ exposure_ev: -1, tone_curve: { contrast: 30 } })
      const lines = events.join('').trim().split('\n').map((line) => JSON.parse(line))
      expect(lines.filter((l) => l.event === 'candidate.ready')).toHaveLength(4)
      expect(lines.some((l) => l.event === 'artifact.ready' && l.role === 'contact-sheet')).toBe(true)
      expect((await readFile(join(root, 'sessions', record.id, 'iterations', 'iter_0001', 'events.ndjson'), 'utf8')).trim().split('\n').length).toBeGreaterThanOrEqual(6)
    } finally {
      runtime.dispose()
    }
  }, 120_000)
})
```

- [x] **Step 2: Run to verify failure**

Run: `pnpm --filter @lumaforge/lmfg-cli test src/services/metrics src/services/contact-sheet src/services/iteration`
Expected: FAIL.

- [x] **Step 3: Implement `src/services/metrics.ts`**

```ts
import type { Metrics } from '../schemas/results'

const HISTOGRAM_BINS = 16
const CLIP_HIGH = 250 / 255
const CLIP_LOW = 5 / 255

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}

function percentile(sorted: Float32Array, p: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)))
  return sorted[index]
}

export function computeImageMetrics(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  options: { maxSamples?: number; approximate?: boolean } = {},
): Metrics {
  const pixels = width * height
  const maxSamples = options.maxSamples ?? 250_000
  const step = Math.max(1, Math.floor(pixels / maxSamples))
  const sampleCount = Math.floor((pixels - 1) / step) + 1
  const luma = new Float32Array(sampleCount)
  const histogram = new Array<number>(HISTOGRAM_BINS).fill(0)
  let clippedHigh = 0
  let clippedLow = 0
  let saturationSum = 0
  let rgSum = 0
  let ybSum = 0
  let rgSq = 0
  let ybSq = 0
  let lumaSum = 0

  let sample = 0
  for (let p = 0; p < pixels; p += step, sample += 1) {
    const o = p * 4
    const r = rgba[o] / 255
    const g = rgba[o + 1] / 255
    const b = rgba[o + 2] / 255
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b
    luma[sample] = y
    lumaSum += y
    histogram[Math.min(HISTOGRAM_BINS - 1, Math.floor(y * HISTOGRAM_BINS))] += 1
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    if (max >= CLIP_HIGH) clippedHigh += 1
    if (max <= CLIP_LOW) clippedLow += 1
    saturationSum += max > 0 ? (max - min) / max : 0
    const rg = (r - g) * 255
    const yb = (0.5 * (r + g) - b) * 255
    rgSum += rg
    ybSum += yb
    rgSq += rg * rg
    ybSq += yb * yb
  }

  const n = Math.max(1, sampleCount)
  const rgMean = rgSum / n
  const ybMean = ybSum / n
  const rgStd = Math.sqrt(Math.max(0, rgSq / n - rgMean * rgMean))
  const ybStd = Math.sqrt(Math.max(0, ybSq / n - ybMean * ybMean))
  const colorfulness = Math.sqrt(rgStd * rgStd + ybStd * ybStd) + 0.3 * Math.sqrt(rgMean * rgMean + ybMean * ybMean)
  const sorted = luma.slice().sort()

  return {
    schema: 'lmfg.metrics.v1',
    width,
    height,
    sampled_pixels: sampleCount,
    luma: {
      mean: round(lumaSum / n),
      p1: round(percentile(sorted, 0.01)),
      p50: round(percentile(sorted, 0.5)),
      p99: round(percentile(sorted, 0.99)),
      clipped_highlight_ratio: round(clippedHigh / n),
      clipped_shadow_ratio: round(clippedLow / n),
    },
    chroma: { mean_saturation: round(saturationSum / n), colorfulness: round(colorfulness) },
    histogram: { bins: HISTOGRAM_BINS, luma: histogram },
    approximate: options.approximate ?? false,
  }
}
```

- [x] **Step 4: Implement `src/services/contact-sheet.ts`**

```ts
import type { ContactSheet } from '@lumaforge/render-engine/preview'
import { composeContactSheet } from '@lumaforge/render-engine/preview'

import { LmfgError } from '../protocol/errors'

export function fitTileSize(srcWidth: number, srcHeight: number, tileWidth: number): { width: number; height: number } {
  const width = Math.max(1, Math.min(srcWidth, Math.floor(tileWidth)))
  const height = Math.max(1, Math.round((srcHeight * width) / srcWidth))
  return { width, height }
}

/** Area-averaging box filter. Never upsamples: callers pass dst ≤ src. */
export function downsampleRgba(src: Uint8ClampedArray | Uint8Array, srcWidth: number, srcHeight: number, dstWidth: number, dstHeight: number): Uint8ClampedArray {
  const dst = new Uint8ClampedArray(dstWidth * dstHeight * 4)
  for (let y = 0; y < dstHeight; y += 1) {
    const y0 = Math.floor((y * srcHeight) / dstHeight)
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * srcHeight) / dstHeight))
    for (let x = 0; x < dstWidth; x += 1) {
      const x0 = Math.floor((x * srcWidth) / dstWidth)
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * srcWidth) / dstWidth))
      let r = 0, g = 0, b = 0, count = 0
      for (let sy = y0; sy < y1; sy += 1) {
        for (let sx = x0; sx < x1; sx += 1) {
          const o = (sy * srcWidth + sx) * 4
          r += src[o]
          g += src[o + 1]
          b += src[o + 2]
          count += 1
        }
      }
      const d = (y * dstWidth + x) * 4
      dst[d] = Math.round(r / count)
      dst[d + 1] = Math.round(g / count)
      dst[d + 2] = Math.round(b / count)
      dst[d + 3] = 255
    }
  }
  return dst
}

export type SheetTile = { id: string; rgba: Uint8ClampedArray; width: number; height: number }

export type BuiltContactSheet = {
  sheet: ContactSheet
  rows: number
  cols: number
  gap: number
  tileWidth: number
  tileHeight: number
  map: Array<{ candidate_id: string; index: number; x: number; y: number; width: number; height: number }>
}

export function buildContactSheet(input: { tiles: SheetTile[]; cols: number; gap?: number; rows?: number }): BuiltContactSheet {
  const { tiles } = input
  if (tiles.length === 0) throw new LmfgError('args.invalid', { message: 'A contact sheet needs at least one tile.' })
  const cols = Math.max(1, Math.floor(input.cols))
  const rows = input.rows ?? Math.ceil(tiles.length / cols)
  if (cols * rows < tiles.length) {
    throw new LmfgError('args.invalid', { message: `Layout ${cols}x${rows} has ${cols * rows} cells but ${tiles.length} tiles were requested.` })
  }
  const gap = Math.max(0, Math.floor(input.gap ?? 4))
  const tileWidth = tiles[0].width
  const tileHeight = tiles[0].height
  if (tiles.some((tile) => tile.width !== tileWidth || tile.height !== tileHeight)) {
    throw new LmfgError('internal', { message: 'Contact sheet tiles must share one size.' })
  }
  const sheet = composeContactSheet({ tiles, cols, rows, tileWidth, tileHeight, gap })
  const map = tiles.map((tile, index) => ({
    candidate_id: tile.id,
    index,
    x: (index % cols) * (tileWidth + gap),
    y: Math.floor(index / cols) * (tileHeight + gap),
    width: tileWidth,
    height: tileHeight,
  }))
  return { sheet, rows, cols, gap, tileWidth, tileHeight, map }
}
```

- [x] **Step 5: Implement `src/services/iteration.ts`**

```ts
import type { RawRenderExposure } from '@lumaforge/luma-color-runtime'
import type { RenderEnvironment } from '@lumaforge/render-engine'
import { sha256Hex } from '@lumaforge/render-engine'
import type { CandidateParams } from '@lumaforge/render-engine/preview'
import { candidateRender, encodePreviewFrameToJpeg, QUICK_PREVIEW_MAX_PIXELS } from '@lumaforge/render-engine/preview'

import type { Output } from '../protocol/output'
import type { LmfgRuntime } from '../runtime/node-runtime'
import type { LoadedSource } from '../runtime/source-loader'
import type { ContactSheetOptions, NormalizedPlan } from '../schemas/plan'
import type { CandidateSummary, IterationResult, SessionRecord } from '../schemas/results'
import type { IterationStore } from '../workspace/iteration-store'
import { formatIterationId } from '../workspace/ids'
import { toFileUri } from '../workspace/paths'
import type { SessionStore } from '../workspace/session-store'
import { buildColorGraph, requireSupportedGraph, resolveExposure } from './color-graph'
import { buildContactSheet, downsampleRgba, fitTileSize } from './contact-sheet'
import type { ResolvedLut } from './lut'
import { resolveLutForParams } from './lut'
import { buildRenderManifest, percentToQuality, toSourceIdentity } from './manifest'
import { computeImageMetrics } from './metrics'
import { clampMaxPixels, decodeFrame } from './preview'

export type IterationRunInput = {
  runtime: LmfgRuntime
  source: LoadedSource
  record: SessionRecord
  store: SessionStore
  iterationStore: IterationStore
  environment: RenderEnvironment
  output: Output
  cwd: string
  signal?: AbortSignal
  plan: NormalizedPlan
  options: { maxPixels: number; quality: number; contactSheet: boolean; sheetOptions: ContactSheetOptions | null }
}

const DEFAULT_TILE_WIDTH = 320
const DEFAULT_GAP = 4

export async function runIteration(input: IterationRunInput): Promise<IterationResult> {
  const timings: Record<string, number> = {}
  const total = performance.now()
  const { plan, record, output } = input

  // Fail closed before touching the RAW: every candidate LUT contract must resolve.
  const lutCache = new Map<string, ResolvedLut | null>()
  const luts: Array<ResolvedLut | null> = []
  for (const candidate of plan.candidates) {
    const key = candidate.params.lut ? JSON.stringify(candidate.params.lut) : 'none'
    if (!lutCache.has(key)) lutCache.set(key, await resolveLutForParams(candidate.params.lut, input.cwd))
    luts.push(lutCache.get(key) ?? null)
  }

  const sheetOptions = input.options.contactSheet
    ? { cols: input.options.sheetOptions?.cols ?? Math.ceil(Math.sqrt(plan.candidates.length)), tile_width: input.options.sheetOptions?.tile_width ?? DEFAULT_TILE_WIDTH, gap: input.options.sheetOptions?.gap ?? DEFAULT_GAP }
    : null
  const iterationId = formatIterationId(await input.store.allocate(record.id, 'iterations'))
  const iterationDir = await input.iterationStore.create({
    schema: 'lmfg.iteration.v1',
    id: iterationId,
    session_id: record.id,
    created_at: new Date().toISOString(),
    kind: plan.kind,
    base: plan.base,
    candidates: plan.candidates.map((candidate) => ({ id: candidate.id, tag: candidate.tag, params: candidate.params })),
    options: { max_pixels: input.options.maxPixels, quality: input.options.quality, contact_sheet: sheetOptions },
  })

  const emit = async (event: Record<string, unknown> & { event: string }) => {
    output.event(event)
    await input.iterationStore.appendEvent(iterationId, event)
  }
  await emit({ event: 'started', command: `render.${plan.kind}`, session_id: record.id, iteration_id: iterationId, total: plan.candidates.length })

  const raw = await input.runtime.raw()
  const jpeg = await input.runtime.jpeg()
  const maxPixels = clampMaxPixels(input.options.maxPixels)
  const session = await raw.openSession(input.source.input, { maxOutputPixels: Math.min(maxPixels, QUICK_PREVIEW_MAX_PIXELS) }, input.signal)
  try {
    const decodeStart = performance.now()
    const frame = await decodeFrame(session, maxPixels, input.signal)
    timings.decode_ms = performance.now() - decodeStart
    const sourceIdentity = toSourceIdentity(input.source, record.decoded_dimensions ?? { width: session.probe.width ?? frame.width, height: session.probe.height ?? frame.height })

    const exposures: RawRenderExposure[] = []
    const renderParams: CandidateParams[] = plan.candidates.map((candidate, index) => {
      const exposure = resolveExposure(candidate.params, { baselineExposure: session.probe.baselineExposure, frame })
      exposures.push(exposure)
      const graph = requireSupportedGraph(buildColorGraph(candidate.params, luts[index]?.lutData ?? null, exposure))
      return { graph, quality: percentToQuality(input.options.quality), tag: candidate.id }
    })

    const tileSize = fitTileSize(frame.width, frame.height, sheetOptions?.tile_width ?? DEFAULT_TILE_WIDTH)
    const tiles: Array<{ id: string; rgba: Uint8ClampedArray; width: number; height: number }> = []
    const summaries: CandidateSummary[] = []
    const renderStart = performance.now()
    let index = 0
    for await (const result of candidateRender({ source: frame, params: renderParams, maxConcurrent: 1, createEncoder: (options) => jpeg.createEncoder(options), signal: input.signal })) {
      const candidate = plan.candidates[result.index]
      const bytes = result.outputBytes as Uint8Array
      const sha256 = sha256Hex(bytes)
      const metrics = computeImageMetrics(result.rgba, result.width, result.height)
      const tile = { id: candidate.id, rgba: downsampleRgba(result.rgba, result.width, result.height, tileSize.width, tileSize.height), width: tileSize.width, height: tileSize.height }
      tiles[result.index] = tile
      const manifest = buildRenderManifest({
        kind: 'candidate',
        source: sourceIdentity,
        lut: luts[result.index]?.identity ?? null,
        graph: renderParams[result.index].graph,
        params: candidate.params,
        exposure: exposures[result.index],
        policy: { kind: 'candidate', row_slice: 32, concurrency: 1 },
        environment: input.environment,
        output: { width: result.width, height: result.height, quality: input.options.quality, filename: 'preview.jpg', sha256 },
        parentManifestSha256: null,
      })
      const paths = await input.iterationStore.writeCandidate(iterationId, candidate.id, { previewJpeg: bytes, manifest, metrics, tile, params: candidate.params })
      const summary: CandidateSummary = {
        id: candidate.id, index: result.index, tag: candidate.tag,
        preview_uri: toFileUri(paths.preview), manifest_uri: toFileUri(paths.manifest), manifest_sha256: manifest.manifest_sha256,
        metrics_uri: toFileUri(paths.metrics), width: result.width, height: result.height, byte_size: bytes.byteLength, sha256,
      }
      summaries[result.index] = summary
      index += 1
      await emit({ event: 'candidate.ready', candidate_id: candidate.id, index: result.index + 1, total: plan.candidates.length, preview_uri: summary.preview_uri, manifest_sha256: manifest.manifest_sha256 })
    }
    timings.render_ms = performance.now() - renderStart
    void index

    let contactSheet: IterationResult['contact_sheet'] = null
    if (sheetOptions) {
      const sheetStart = performance.now()
      const built = buildContactSheet({ tiles, cols: sheetOptions.cols, gap: sheetOptions.gap })
      const sheetJpeg = (await encodePreviewFrameToJpeg((options) => jpeg.createEncoder(options), { rgba: built.sheet.rgba, width: built.sheet.width, height: built.sheet.height, quality: 0.85 })) as Uint8Array
      const written = await input.iterationStore.writeContactSheet(iterationId, {
        jpeg: sheetJpeg,
        map: { schema: 'lmfg.contact-sheet-map.v1', iteration_id: iterationId, cols: built.cols, rows: built.rows, tile_width: built.tileWidth, tile_height: built.tileHeight, gap: built.gap, width: built.sheet.width, height: built.sheet.height, tiles: built.map },
      })
      contactSheet = { uri: toFileUri(written.sheet), map_uri: toFileUri(written.map), width: built.sheet.width, height: built.sheet.height, cols: built.cols, rows: built.rows, tile_width: built.tileWidth, tile_height: built.tileHeight }
      timings.contact_sheet_ms = performance.now() - sheetStart
      await emit({ event: 'artifact.ready', role: 'contact-sheet', uri: contactSheet.uri, map_uri: contactSheet.map_uri })
    }

    timings.total_ms = performance.now() - total
    await emit({ event: 'iteration.completed', iteration_id: iterationId, candidate_count: summaries.length })
    return {
      session_id: record.id,
      iteration_id: iterationId,
      iteration_dir: iterationDir,
      kind: plan.kind,
      candidate_count: summaries.length,
      candidates: summaries,
      contact_sheet: contactSheet,
      decode: frame.decode,
      raw_render_exposure: exposures[0],
      timings_ms: timings,
    }
  } finally {
    session.dispose()
  }
}
```

- [x] **Step 6: Add `candidate` and `sweep` to `src/commands/render.ts`**

```ts
import { expandSweepPlan, normalizeCandidatePlan } from '../schemas/plan'
import type { NormalizedPlan } from '../schemas/plan'
import { runIteration } from '../services/iteration'
import { createIterationStore } from '../workspace/iteration-store'
import { readJson } from '../workspace/atomic-fs'

type IterationOptions = { plan: string; maxPixels?: number; quality: number; contactSheet?: boolean; sheetCols?: number; tileWidth?: number }

function registerIteration(render: Command, host: CommandHost, kind: 'candidate' | 'sweep') {
  render
    .command(kind)
    .description(kind === 'candidate' ? 'Render an explicit list of candidates from a plan file' : 'Expand parameter axes into a candidate sweep and render it')
    .requiredOption('--plan <file>', kind === 'candidate' ? 'plan JSON (lmfg.plan.v1)' : 'sweep JSON (lmfg.sweep.v1)')
    .option('--max-pixels <n>', 'decode budget in pixels', parsePositiveInteger)
    .option('--quality <n>', 'JPEG quality 1-100', parseQualityPercent, 85)
    .option('--contact-sheet', 'compose a contact sheet of every candidate')
    .option('--sheet-cols <n>', 'contact sheet columns', parsePositiveInteger)
    .option('--tile-width <n>', 'contact sheet tile width in pixels', parsePositiveInteger)
    .action(async function (this: Command, options: IterationOptions) {
      const ctx = host.context(this)
      const loadPlan = async (): Promise<NormalizedPlan> => {
        const json = await readJson(ctx.resolvePath(options.plan))
        return kind === 'candidate' ? normalizeCandidatePlan(json) : expandSweepPlan(json)
      }
      host.setExitCode(
        await runCommand(
          ctx,
          { schema: `lmfg.render.${kind}.v1`, command: `render.${kind}` },
          async () => {
            const { store, record, source, environment } = await openRenderSession(ctx)
            const plan = await loadPlan()
            const sheetOptions = { ...(plan.contactSheet ?? {}), ...(options.sheetCols ? { cols: options.sheetCols } : {}), ...(options.tileWidth ? { tile_width: options.tileWidth } : {}) }
            return withRuntime(ctx, (runtime) =>
              runIteration({
                runtime, source, record, store, iterationStore: createIterationStore(ctx.workspaceRoot, record.id), environment, output: ctx.output, cwd: ctx.cwd, signal: ctx.signal, plan,
                options: { maxPixels: clampMaxPixels(options.maxPixels), quality: options.quality, contactSheet: Boolean(options.contactSheet || plan.contactSheet), sheetOptions },
              }),
            )
          },
          async () => {
            const { record } = await openRenderSession(ctx)
            const plan = await loadPlan()
            for (const candidate of plan.candidates) await resolveLutForParams(candidate.params.lut, ctx.cwd)
            return { session_id: record.id, kind, candidate_count: plan.candidates.length, candidates: plan.candidates.map((c) => ({ id: c.id, tag: c.tag })), max_pixels: clampMaxPixels(options.maxPixels), quality: options.quality }
          },
        ),
      )
    })
}
```

Call `registerIteration(render, host, 'candidate')` and `registerIteration(render, host, 'sweep')` inside `registerRenderCommands` after `preview`; import `resolveLutForParams` from `../services/lut`.

- [x] **Step 7: Implement `src/commands/compare.ts` and `src/commands/metrics.ts`**

`compare.ts`:

```ts
import type { Command } from 'commander'
import { InvalidArgumentError } from 'commander'

import { encodePreviewFrameToJpeg } from '@lumaforge/render-engine/preview'

import { buildContactSheet } from '../services/contact-sheet'
import type { CompareSheetResult } from '../schemas/results'
import { createIterationStore } from '../workspace/iteration-store'
import { toFileUri } from '../workspace/paths'
import type { CommandHost } from './context'
import { runCommand } from './context'
import { openRenderSession, withRuntime } from './render-shared'

function parseLayout(value: string): { cols: number; rows: number } {
  const match = /^(\d+)x(\d+)$/i.exec(value.trim())
  if (!match) throw new InvalidArgumentError('Expected <cols>x<rows>, e.g. 4x3.')
  const cols = Number.parseInt(match[1], 10)
  const rows = Number.parseInt(match[2], 10)
  if (cols < 1 || rows < 1) throw new InvalidArgumentError('Layout dimensions must be positive.')
  return { cols, rows }
}

export function registerCompareCommands(program: Command, host: CommandHost): void {
  const compare = program.command('compare').description('Compose comparison artifacts from rendered candidates')
  compare
    .command('sheet')
    .description('Recompose a contact sheet for an iteration from its stored candidate tiles')
    .requiredOption('--iteration <id>', 'iteration id, e.g. iter_0001')
    .option('--layout <colsxrows>', 'grid layout, e.g. 3x2 (default: near-square)', parseLayout)
    .option('--gap <n>', 'gap between tiles in pixels', (v) => Number.parseInt(v, 10), 4)
    .option('--name <name>', 'artifact base name (default: contact-sheet or contact-sheet-<layout>)')
    .action(async function (this: Command, options: { iteration: string; layout?: { cols: number; rows: number }; gap: number; name?: string }) {
      const ctx = host.context(this)
      host.setExitCode(
        await runCommand(ctx, { schema: 'lmfg.compare.sheet.v1', command: 'compare.sheet' }, async (): Promise<CompareSheetResult> => {
          const { record } = await openRenderSession(ctx)
          const iterationStore = createIterationStore(ctx.workspaceRoot, record.id)
          const iteration = await iterationStore.read(options.iteration)
          const tiles = []
          for (const candidate of iteration.candidates) {
            const tile = await iterationStore.readCandidateTile(iteration.id, candidate.id)
            tiles.push({ id: candidate.id, ...tile })
          }
          const cols = options.layout?.cols ?? Math.ceil(Math.sqrt(tiles.length))
          const built = buildContactSheet({ tiles, cols, rows: options.layout?.rows, gap: options.gap })
          const name = options.name ?? (options.layout ? `contact-sheet-${built.cols}x${built.rows}` : 'contact-sheet')
          return withRuntime(ctx, async (runtime) => {
            const jpegRuntime = await runtime.jpeg()
            const jpeg = (await encodePreviewFrameToJpeg((o) => jpegRuntime.createEncoder(o), { rgba: built.sheet.rgba, width: built.sheet.width, height: built.sheet.height, quality: 0.85 })) as Uint8Array
            const written = await iterationStore.writeContactSheet(iteration.id, {
              name,
              jpeg,
              map: { schema: 'lmfg.contact-sheet-map.v1', iteration_id: iteration.id, cols: built.cols, rows: built.rows, tile_width: built.tileWidth, tile_height: built.tileHeight, gap: built.gap, width: built.sheet.width, height: built.sheet.height, tiles: built.map },
            })
            ctx.output.event({ event: 'artifact.ready', role: 'contact-sheet', uri: toFileUri(written.sheet) })
            return {
              session_id: record.id,
              iteration_id: iteration.id,
              contact_sheet: { uri: toFileUri(written.sheet), map_uri: toFileUri(written.map), width: built.sheet.width, height: built.sheet.height, cols: built.cols, rows: built.rows, tile_width: built.tileWidth, tile_height: built.tileHeight },
              tiles: built.map,
            }
          })
        }),
      )
    })
}
```

`metrics.ts`:

```ts
import type { Command } from 'commander'

import { computeImageMetrics } from '../services/metrics'
import type { MetricsResult } from '../schemas/results'
import { writeJsonAtomic } from '../workspace/atomic-fs'
import { createIterationStore } from '../workspace/iteration-store'
import { toFileUri } from '../workspace/paths'
import { createSessionStore } from '../workspace/session-store'
import type { CommandHost } from './context'
import { runCommand } from './context'

export function registerMetricsCommands(program: Command, host: CommandHost): void {
  const metrics = program.command('metrics').description('Image statistics for rendered candidates')
  metrics
    .command('compute')
    .description('Return stored metrics for a candidate (recomputed from its tile when missing)')
    .requiredOption('--iteration <id>', 'iteration id')
    .requiredOption('--candidate <id>', 'candidate id')
    .action(async function (this: Command, options: { iteration: string; candidate: string }) {
      const ctx = host.context(this)
      host.setExitCode(
        await runCommand(ctx, { schema: 'lmfg.metrics.compute.v1', command: 'metrics.compute' }, async (): Promise<MetricsResult> => {
          const record = await createSessionStore(ctx.workspaceRoot).load(ctx.requireSession())
          const iterationStore = createIterationStore(ctx.workspaceRoot, record.id)
          await iterationStore.read(options.iteration)
          const paths = iterationStore.candidatePaths(options.iteration, options.candidate)
          let stored = await iterationStore.readCandidateMetrics(options.iteration, options.candidate)
          if (!stored) {
            const tile = await iterationStore.readCandidateTile(options.iteration, options.candidate)
            stored = computeImageMetrics(tile.rgba, tile.width, tile.height, { approximate: true })
            await writeJsonAtomic(paths.metrics, stored)
          }
          return { session_id: record.id, iteration_id: options.iteration, candidate_id: options.candidate, metrics_uri: toFileUri(paths.metrics), metrics: stored }
        }),
      )
    })
}
```

- [x] **Step 8: Run tests, lint, typecheck; commit**

Run: `pnpm --filter @lumaforge/lmfg-cli test && pnpm --filter @lumaforge/lmfg-cli typecheck && pnpm exec eslint "packages/lmfg-cli/src/**/*.ts"`
Expected: PASS (iteration test ≈ 10 s).

```bash
git add packages/lmfg-cli/src
git commit -m "feat(cli): add candidate sweeps, contact sheets, metrics, and compare commands"
```

---

### Task 14: Fail-closed full-resolution export and `render export`

**Files:**
- Create: `src/services/export.ts`
- Modify: `src/commands/render.ts` (add `export`)
- Test: `src/services/export.test.ts` (fixture-gated)

- [x] **Step 1: Write the failing test**

```ts
// @vitest-environment node
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { detectCapabilities } from '../runtime/capability'
import { createLmfgRuntime } from '../runtime/node-runtime'
import { loadSourceFile } from '../runtime/source-loader'
import { parseRenderParams } from '../schemas/params'
import { assertJpegBytes, runFullResolutionExport } from './export'

const FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), '../../../luma-raw-runtime/fixtures/.cache/public/raw-pixls-iphone-se.dng')
const ready = existsSync(FIXTURE) && detectCapabilities({ memoryProfile: 'desktop' }).render_tiers.cpu_wasm.available
const d = ready ? describe : describe.skip

describe('assertJpegBytes', () => {
  it('accepts SOI..EOI and refuses anything else', () => {
    expect(() => assertJpegBytes(new Uint8Array([0xff, 0xd8, 0, 0xff, 0xd9]))).not.toThrow()
    expect(() => assertJpegBytes(new Uint8Array([1, 2, 3]))).toThrow(expect.objectContaining({ code: 'export.refused', exitCode: 8 }))
    expect(() => assertJpegBytes(new Uint8Array())).toThrow(expect.objectContaining({ code: 'export.refused' }))
  })
})

d('runFullResolutionExport', () => {
  it('exports the full-resolution JPEG with EXIF and progress', async () => {
    const runtime = createLmfgRuntime({ memoryProfile: 'desktop' })
    const progress: number[] = []
    try {
      const source = await loadSourceFile(FIXTURE, '/')
      const result = await runFullResolutionExport({
        runtime, source, params: parseRenderParams({ exposure_ev: 0.3 }), lut: null, exposure: null, quality: 90, preferredRows: 512,
        onProgress: (p) => progress.push(p.progress),
      })
      expect(result.width).toBe(4032)
      expect(result.height).toBe(3024)
      expect(result.jpeg.byteLength).toBeGreaterThan(1_000_000)
      expect(result.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(result.strips).toBeGreaterThan(1)
      expect(progress.at(-1)).toBe(99)
      expect(result.exposure.source).toBe('dng-baseline')
      // EXIF APP1 segment present right after SOI (or after APP0)
      const head = Buffer.from(result.jpeg.subarray(0, 64)).toString('latin1')
      expect(head).toContain('Exif')
    } finally {
      runtime.dispose()
    }
  }, 120_000)
})
```

- [x] **Step 2: Run to verify failure**

Run: `pnpm --filter @lumaforge/lmfg-cli test src/services/export`
Expected: FAIL.

- [x] **Step 3: Implement `src/services/export.ts`**

```ts
import type { RawRenderExposure, SupportedExportColorGraphDescriptor } from '@lumaforge/luma-color-runtime'
import { exposureMultiplierFromEv } from '@lumaforge/luma-color-runtime'
import type { LumaRawExportCapability } from '@lumaforge/luma-raw-runtime'
import type { RenderManifest } from '@lumaforge/render-engine'
import { sha256Hex } from '@lumaforge/render-engine'
import type { FullResolutionExportProgress } from '@lumaforge/render-engine/export'
import { createNodeJpegRowSink, preserveJpegMetadataBytes, runFullResolutionJpegExport } from '@lumaforge/render-engine/export'
import { QUICK_PREVIEW_MAX_PIXELS } from '@lumaforge/render-engine/preview'

import { LmfgError } from '../protocol/errors'
import type { LmfgRuntime } from '../runtime/node-runtime'
import type { LoadedSource } from '../runtime/source-loader'
import type { RenderParams } from '../schemas/params'
import { buildColorGraph, requireSupportedGraph, resolveExposure } from './color-graph'
import type { ResolvedLut } from './lut'
import { percentToQuality } from './manifest'

export const DEFAULT_EXPORT_STRIP_ROWS = 512

export function assertJpegBytes(bytes: Uint8Array): void {
  const ok = bytes.byteLength >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[bytes.byteLength - 2] === 0xff && bytes[bytes.byteLength - 1] === 0xd9
  if (!ok) {
    throw new LmfgError('export.refused', { message: 'The export produced an incomplete JPEG stream; refusing to write it.', retryable: true })
  }
}

export function exposureFromManifest(manifest: RenderManifest): RawRenderExposure | null {
  const ev = manifest.render_params.raw_render_exposure_ev
  const source = manifest.render_params.raw_render_exposure_source
  if (typeof ev !== 'number' || !source) return null
  return { ev, multiplier: exposureMultiplierFromEv(ev), source }
}

function requireExportCapability(capability: LumaRawExportCapability): LumaRawExportCapability {
  if (capability.supported && capability.width > 0 && capability.height > 0) return capability
  throw new LmfgError('source.export_unsupported', {
    message: `This RAW cannot be exported at full resolution (${capability.reasons.join(', ') || 'unsupported source'}).`,
    details: { reasons: capability.reasons, strategy: capability.strategy ?? null },
    suggestedNextActions: ['lmfg inspect --session <id>'],
  })
}

export type ExportRunInput = {
  runtime: LmfgRuntime
  source: LoadedSource
  params: RenderParams
  lut: ResolvedLut | null
  /** Pre-resolved exposure (from a candidate manifest) or `null` to resolve from the quick frame. */
  exposure: RawRenderExposure | null
  quality: number
  preferredRows?: number
  signal?: AbortSignal
  onProgress?: (progress: FullResolutionExportProgress) => void
}

export type ExportRunResult = {
  jpeg: Uint8Array
  sha256: string
  width: number
  height: number
  graph: SupportedExportColorGraphDescriptor
  exposure: RawRenderExposure
  strips: number
  timings: Record<string, number>
}

export async function runFullResolutionExport(input: ExportRunInput): Promise<ExportRunResult> {
  const timings: Record<string, number> = {}
  const total = performance.now()
  const raw = await input.runtime.raw()
  const jpegRuntime = await input.runtime.jpeg()
  const session = await raw.openSession(input.source.input, { maxOutputPixels: QUICK_PREVIEW_MAX_PIXELS }, input.signal)
  try {
    const capability = requireExportCapability(await session.probeExportCapability(input.signal))
    let exposure = input.exposure
    if (!exposure) {
      const frame = await session.decodeQuick({ maxOutputPixels: QUICK_PREVIEW_MAX_PIXELS }, input.signal)
      exposure = resolveExposure(input.params, { baselineExposure: session.probe.baselineExposure, frame })
    }
    const graph = requireSupportedGraph(buildColorGraph(input.params, input.lut?.lutData ?? null, exposure))

    let strips = 0
    const exportStart = performance.now()
    await session.beginProcessedWindowExport?.(input.signal)
    let output
    try {
      output = await runFullResolutionJpegExport({
        capability,
        graph,
        readProcessedWindow: session.readProcessedWindow,
        quality: percentToQuality(input.quality),
        preferredRows: input.preferredRows ?? DEFAULT_EXPORT_STRIP_ROWS,
        concurrency: 1,
        jpegSink: createNodeJpegRowSink(jpegRuntime),
        signal: input.signal,
        onProgress: (progress) => {
          strips = progress.totalStrips
          input.onProgress?.(progress)
        },
      })
    } finally {
      await session.endProcessedWindowExport?.().catch(() => undefined)
    }
    timings.export_ms = performance.now() - exportStart
    if (output.kind !== 'bytes') {
      throw new LmfgError('export.refused', { message: `Unexpected export output kind "${output.kind}".` })
    }
    const jpeg = preserveJpegMetadataBytes({ jpeg: output.bytes, metadata: session.probe, width: capability.width, height: capability.height })
    assertJpegBytes(jpeg)
    timings.total_ms = performance.now() - total
    return { jpeg, sha256: sha256Hex(jpeg), width: capability.width, height: capability.height, graph, exposure, strips, timings }
  } finally {
    session.dispose()
  }
}
```

- [x] **Step 4: Add `export` to `src/commands/render.ts`**

```ts
import { verifyManifestSha256 } from '@lumaforge/render-engine'

import { LmfgError } from '../protocol/errors'
import { exposureFromManifest, runFullResolutionExport } from '../services/export'
import { requireVerifiedManifest } from '../services/manifest'
import { fileExists } from '../workspace/atomic-fs'
import type { ExportResult } from '../schemas/results'

type ExportOptions = { iteration?: string; candidate?: string; params?: string; quality: number; output: string; preferredRows?: number }

render
  .command('export')
  .description('Full-resolution JPEG export; refuses to write anything it cannot prove reproducible')
  .option('--iteration <id>', 'iteration containing --candidate')
  .option('--candidate <id>', 'candidate whose params, LUT, and exposure are exported (chains manifests)')
  .option('--params <file>', 'params JSON when not exporting a candidate')
  .option('--quality <n>', 'JPEG quality 1-100', parseQualityPercent, 92)
  .option('--output <name>', 'artifact base name under exports/', 'final')
  .option('--preferred-rows <n>', 'strip height in rows', parsePositiveInteger)
  .action(async function (this: Command, options: ExportOptions) {
    const ctx = host.context(this)
    const resolveInputs = async () => {
      if (options.candidate && !options.iteration) {
        throw new LmfgError('args.invalid', { message: '--candidate requires --iteration.' })
      }
      const session = await openRenderSession(ctx).catch((error: unknown) => {
        const mapped = error instanceof LmfgError && error.code === 'hash.mismatch'
          ? new LmfgError('export.refused', { message: `Export refused: ${error.message}`, details: error.details, suggestedNextActions: error.suggestedNextActions })
          : error
        throw mapped
      })
      const { record, environment } = session
      let params
      let parent: string | null = null
      let exposure = null
      let lutSha: string | null = null
      if (options.candidate && options.iteration) {
        const iterationStore = createIterationStore(ctx.workspaceRoot, record.id)
        const paths = iterationStore.candidatePaths(options.iteration, options.candidate)
        const { manifest } = await requireVerifiedManifest(paths.manifest, environment)
        params = await iterationStore.readCandidateParams(options.iteration, options.candidate)
        parent = manifest.manifest_sha256
        exposure = exposureFromManifest(manifest)
        lutSha = manifest.lut?.sha256 ?? null
      } else {
        params = await loadParamsFile(ctx, options.params)
      }
      const { lut } = await resolveParamsAndLut(ctx, params)
      if (lutSha && lut && lut.identity.sha256 !== lutSha) {
        throw new LmfgError('export.refused', { message: 'The LUT file changed since the candidate was rendered; export refused.', details: { expected_sha256: lutSha, actual_sha256: lut.identity.sha256 } })
      }
      const outputPath = workspacePaths.exportFile(ctx.workspaceRoot, record.id, options.output)
      if ((await fileExists(outputPath)) && !ctx.options.yes) {
        throw new LmfgError('args.invalid', { message: `${outputPath} already exists; pass --yes to overwrite or --output <name>.` })
      }
      return { ...session, params, lut, parent, exposure, outputPath }
    }
    host.setExitCode(
      await runCommand(
        ctx,
        { schema: 'lmfg.render.export.v1', command: 'render.export' },
        async (): Promise<ExportResult> => {
          const { store, record, source, environment, params, lut, parent, exposure, outputPath } = await resolveInputs()
          ctx.output.event({ event: 'started', command: 'render.export', session_id: record.id })
          return withRuntime(ctx, async (runtime) => {
            const result = await runFullResolutionExport({
              runtime, source, params, lut, exposure, quality: options.quality, preferredRows: options.preferredRows, signal: ctx.signal,
              onProgress: (progress) => ctx.output.event({ event: 'export.progress', completed_strips: progress.completedStrips, total_strips: progress.totalStrips, progress: progress.progress }),
            })
            const manifestPath = workspacePaths.exportManifestFile(ctx.workspaceRoot, record.id, options.output)
            const manifest = buildRenderManifest({
              kind: 'export',
              source: toSourceIdentity(source, { width: result.width, height: result.height }),
              lut: lut?.identity ?? null,
              graph: result.graph,
              params,
              exposure: result.exposure,
              policy: { kind: 'export-full', row_slice: options.preferredRows ?? 512, concurrency: 1 },
              environment,
              output: { width: result.width, height: result.height, quality: options.quality, filename: `${options.output}.jpg`, sha256: result.sha256 },
              parentManifestSha256: parent,
            })
            if (!verifyManifestSha256(manifest)) {
              throw new LmfgError('export.refused', { message: 'Export manifest failed self-verification; nothing was written.' })
            }
            await writeFileAtomic(outputPath, result.jpeg)
            await writeJsonAtomic(manifestPath, manifest)
            await store.allocate(record.id, 'exports')
            ctx.output.event({ event: 'artifact.ready', role: 'export', uri: toFileUri(outputPath), manifest_sha256: manifest.manifest_sha256 })
            return {
              session_id: record.id,
              output: { uri: toFileUri(outputPath), path: outputPath, width: result.width, height: result.height, byte_size: result.jpeg.byteLength, sha256: result.sha256, quality: options.quality },
              manifest_uri: toFileUri(manifestPath),
              manifest_sha256: manifest.manifest_sha256,
              parent_manifest_sha256: parent,
              color_graph_fingerprint: manifest.color_graph.fingerprint,
              raw_render_exposure: result.exposure,
              strips: result.strips,
              timings_ms: result.timings,
            }
          })
        },
        async () => {
          const { record, params, lut, parent, outputPath } = await resolveInputs()
          return { session_id: record.id, params, lut: lut?.identity ?? null, parent_manifest_sha256: parent, output_path: outputPath, quality: options.quality }
        },
      ),
    )
  })
```

- [x] **Step 5: Run tests, lint, typecheck; commit**

Run: `pnpm --filter @lumaforge/lmfg-cli test && pnpm --filter @lumaforge/lmfg-cli typecheck && pnpm exec eslint "packages/lmfg-cli/src/**/*.ts"`
Expected: PASS (export test ≈ 4 s).

```bash
git add packages/lmfg-cli/src
git commit -m "feat(cli): add fail-closed full-resolution export with manifest chaining"
```

---

### Task 15: End-to-end agent loop test and packaged-bin smoke

**Files:**
- Create: `src/e2e/fixture.ts`, `src/e2e/cli.e2e.test.ts`, `src/e2e/bin.dist.test.ts`

- [x] **Step 1: Write the harness `src/e2e/fixture.ts`**

```ts
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe } from 'vitest'

import { runCli } from '../cli'
import { detectCapabilities } from '../runtime/capability'

export const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const FIXTURE_PATH = resolve(PACKAGE_DIR, '../luma-raw-runtime/fixtures/.cache/public/raw-pixls-iphone-se.dng')
export const fixtureReady = existsSync(FIXTURE_PATH) && detectCapabilities({ memoryProfile: 'desktop' }).render_tiers.cpu_wasm.available
export const describeWithFixture = fixtureReady ? describe : describe.skip

export type CliRun = {
  code: number
  stdout: string
  stderr: string
  /** Parsed JSON envelope (json mode) or the last NDJSON line (ndjson mode). */
  envelope: Record<string, unknown> & { ok?: boolean; result?: Record<string, unknown>; error?: Record<string, unknown> }
  lines: Array<Record<string, unknown>>
}

export function createCliHarness(cwd: string) {
  return {
    async run(...argv: string[]): Promise<CliRun> {
      const out: string[] = []
      const err: string[] = []
      const code = await runCli(argv, { stdout: (s) => out.push(s), stderr: (s) => err.push(s), cwd })
      const stdout = out.join('')
      const lines = stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
      return { code, stdout, stderr: err.join(''), envelope: (lines.at(-1) ?? {}) as CliRun['envelope'], lines }
    },
  }
}

export function identityCube(comments: string[]): string {
  const rows: string[] = []
  for (let b = 0; b < 2; b += 1) for (let g = 0; g < 2; g += 1) for (let r = 0; r < 2; r += 1) rows.push(`${r} ${g} ${b}`)
  return ['TITLE "Identity"', ...comments.map((c) => `# ${c}`), 'LUT_3D_SIZE 2', ...rows].join('\n')
}
```

- [x] **Step 2: Write `src/e2e/cli.e2e.test.ts`**

```ts
// @vitest-environment node
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, expect, it } from 'vitest'

import { createCliHarness, describeWithFixture, FIXTURE_PATH, identityCube } from './fixture'

let cwd: string
let cli: ReturnType<typeof createCliHarness>
let sessionId = ''

beforeAll(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'lmfg-e2e-'))
  cli = createCliHarness(cwd)
  await writeFile(join(cwd, 'display.cube'), identityCube(['LUMAFORGE_ROLE=display-look', 'LUMAFORGE_INPUT_PROFILE=display-srgb']))
  await writeFile(join(cwd, 'mystery.cube'), identityCube(['Sony S-Gamut3.Cine S-Log3 to Rec709']))
  await writeFile(join(cwd, 'params.json'), JSON.stringify({ contrast: 20, lut: { path: 'display.cube' } }))
  await writeFile(join(cwd, 'sweep.json'), JSON.stringify({ base: { lut: { path: 'display.cube' } }, axes: { exposure_ev: [-0.5, 0.5], temperature: [-20, 20] } }))
})

afterAll(async () => {
  await rm(cwd, { recursive: true, force: true })
})

describeWithFixture('lmfg agent loop', () => {
  it('session init → inspect → status', async () => {
    const init = await cli.run('session', 'init', '--source', FIXTURE_PATH)
    expect(init.code, init.stdout).toBe(0)
    sessionId = init.envelope.result!.id as string
    expect(sessionId).toMatch(/^sess_/)

    const inspect = await cli.run('inspect', '--session', sessionId)
    expect(inspect.code, inspect.stdout).toBe(0)
    expect((inspect.envelope.result!.metadata as { make: string }).make).toMatch(/apple/i)
    expect(existsSync(join(cwd, '.lmfg', 'sessions', sessionId, 'source', 'embedded-preview.jpg'))).toBe(true)

    const status = await cli.run('session', 'status', '--session', sessionId)
    expect(status.code).toBe(0)
    expect(status.envelope.result).toMatchObject({ status: 'inspected', decoded_dimensions: { width: 4032, height: 3024 } })
    const list = await cli.run('session', 'list')
    expect((list.envelope.result!.sessions as unknown[]).length).toBe(1)
  }, 60_000)

  it('lut inspect / contract infer / validate', async () => {
    const confirmed = await cli.run('lut', 'contract', 'infer', '--lut', 'display.cube')
    expect(confirmed.code).toBe(0)
    expect(confirmed.envelope.result).toMatchObject({ complete: true })

    const mystery = await cli.run('lut', 'contract', 'infer', '--lut', 'mystery.cube')
    expect(mystery.code).toBe(0)
    expect(mystery.envelope.result).toMatchObject({ complete: false })
    const suggested = (mystery.envelope.result!.suggested_contracts as unknown[])[0]
    await writeFile(join(cwd, 'contract.json'), JSON.stringify(suggested))
    const validate = await cli.run('lut', 'contract', 'validate', '--lut', 'mystery.cube', '--contract', 'contract.json')
    expect(validate.code).toBe(0)
    expect(validate.envelope.result).toMatchObject({ valid: true, export_supported: true })
    const inspect = await cli.run('lut', 'inspect', 'display.cube')
    expect(inspect.envelope.result).toMatchObject({ valid: false })
  })

  it('render preview writes a verifiable manifest', async () => {
    const preview = await cli.run('render', 'preview', '--session', sessionId, '--params', 'params.json', '--max-pixels', '400000')
    expect(preview.code, preview.stdout).toBe(0)
    const result = preview.envelope.result!
    expect(result.decode).toBe('quick')
    const verify = await cli.run('manifest', 'verify', fileURLToPath(result.manifest_uri as string))
    expect(verify.code, verify.stdout).toBe(0)
    expect(verify.envelope.result).toMatchObject({ valid: true, kind: 'preview', environment_match: true })
  }, 60_000)

  it('render sweep streams NDJSON and produces a contact sheet; compare and metrics work', async () => {
    const sweep = await cli.run('render', 'sweep', '--session', sessionId, '--plan', 'sweep.json', '--contact-sheet', '--max-pixels', '300000', '--emit', 'ndjson')
    expect(sweep.code, sweep.stdout).toBe(0)
    expect(sweep.lines[0]).toMatchObject({ event: 'started', schema: 'lmfg.event.v1' })
    expect(sweep.lines.filter((l) => l.event === 'candidate.ready')).toHaveLength(4)
    expect(sweep.envelope).toMatchObject({ event: 'completed', ok: true, result_schema: 'lmfg.render.sweep.v1' })
    const result = sweep.envelope.result!
    expect(result.iteration_id).toBe('iter_0001')
    expect(result.contact_sheet).not.toBeNull()

    const sheet = await cli.run('compare', 'sheet', '--session', sessionId, '--iteration', 'iter_0001', '--layout', '4x1')
    expect(sheet.code, sheet.stdout).toBe(0)
    expect(sheet.envelope.result).toMatchObject({ contact_sheet: { cols: 4, rows: 1 } })

    const metrics = await cli.run('metrics', 'compute', '--session', sessionId, '--iteration', 'iter_0001', '--candidate', 'cand_0001')
    expect(metrics.code).toBe(0)
    expect((metrics.envelope.result!.metrics as { schema: string }).schema).toBe('lmfg.metrics.v1')
  }, 120_000)

  it('render export chains the candidate manifest and refuses unsafe rewrites', async () => {
    const candidateManifest = JSON.parse(await readFile(join(cwd, '.lmfg', 'sessions', sessionId, 'iterations', 'iter_0001', 'candidates', 'cand_0002', 'manifest.json'), 'utf8'))
    const exported = await cli.run('render', 'export', '--session', sessionId, '--iteration', 'iter_0001', '--candidate', 'cand_0002')
    expect(exported.code, exported.stdout).toBe(0)
    const result = exported.envelope.result!
    expect(result.parent_manifest_sha256).toBe(candidateManifest.manifest_sha256)
    expect((result.output as { width: number }).width).toBe(4032)
    const verify = await cli.run('manifest', 'verify', fileURLToPath(result.manifest_uri as string))
    expect(verify.code).toBe(0)
    const show = await cli.run('manifest', 'show', fileURLToPath(result.manifest_uri as string))
    expect((show.envelope.result!.manifest as { kind: string }).kind).toBe('export')

    const again = await cli.run('render', 'export', '--session', sessionId, '--params', 'params.json')
    expect(again.code).toBe(2)
    expect(again.envelope.error).toMatchObject({ code: 'args.invalid' })

    const tampered = fileURLToPath(result.manifest_uri as string)
    const manifest = JSON.parse(await readFile(tampered, 'utf8'))
    manifest.render_params.exposure_ev = 3
    await writeFile(tampered, JSON.stringify(manifest))
    const broken = await cli.run('manifest', 'verify', tampered)
    expect(broken.code).toBe(1)
    expect(broken.envelope.error).toMatchObject({ code: 'manifest.invalid' })
  }, 120_000)

  it('fails closed with spec exit codes', async () => {
    const browser = await cli.run('render', 'preview', '--session', sessionId, '--tier', 'browser')
    expect(browser.code).toBe(3)
    expect(browser.envelope.error).toMatchObject({ code: 'tier.unavailable' })

    await writeFile(join(cwd, 'needs-contract.json'), JSON.stringify({ lut: { path: 'mystery.cube' } }))
    const incomplete = await cli.run('render', 'preview', '--session', sessionId, '--params', 'needs-contract.json')
    expect(incomplete.code).toBe(4)
    expect(incomplete.envelope.error).toMatchObject({ code: 'lut.contract.incomplete' })
    expect((incomplete.envelope.error!.suggested_next_actions as string[])[0]).toMatch(/lut contract infer/)

    const missing = await cli.run('session', 'init', '--source', 'nope.dng')
    expect(missing.code).toBe(2)

    const dry = await cli.run('render', 'export', '--session', sessionId, '--params', 'params.json', '--output', 'dry', '--dry-run')
    expect(dry.code).toBe(0)
    expect(dry.envelope).toMatchObject({ schema: 'lmfg.dry-run.v1', result: { dry_run: true, command: 'render.export' } })
    expect(existsSync(join(cwd, '.lmfg', 'sessions', sessionId, 'exports', 'dry.jpg'))).toBe(false)

    const timeout = await cli.run('render', 'export', '--session', sessionId, '--params', 'params.json', '--output', 'slow', '--timeout', '1')
    expect(timeout.code).toBe(9)
    expect(timeout.envelope.error).toMatchObject({ code: 'timeout' })
  }, 120_000)
})
```

- [x] **Step 3: Write `src/e2e/bin.dist.test.ts`**

```ts
// @vitest-environment node
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'

import { PACKAGE_DIR } from './fixture'

const exec = promisify(execFile)
const BIN = join(PACKAGE_DIR, 'bin', 'lmfg.mjs')
const DIST_AVAILABLE = existsSync(join(PACKAGE_DIR, 'dist', 'cli.js'))
const d = DIST_AVAILABLE ? describe : describe.skip

d('packaged bin', () => {
  it('runs version and capabilities from dist', async () => {
    const version = await exec(process.execPath, [BIN, 'version'], { cwd: PACKAGE_DIR })
    expect(JSON.parse(version.stdout)).toMatchObject({ schema: 'lmfg.version.v1', ok: true })
    const caps = await exec(process.execPath, [BIN, 'capabilities', '--quiet'], { cwd: PACKAGE_DIR })
    expect(JSON.parse(caps.stdout).result.active_tier).toBe('cpu_wasm')
  })

  it('exits 2 on unknown commands', async () => {
    await expect(exec(process.execPath, [BIN, 'nope'], { cwd: PACKAGE_DIR })).rejects.toMatchObject({ code: 2 })
  })
})

if (!DIST_AVAILABLE) {
  describe('packaged bin — SKIPPED', () => {
    it('dist missing; run `pnpm --filter @lumaforge/lmfg-cli build` first', () => {
      expect(DIST_AVAILABLE).toBe(false)
    })
  })
}
```

- [x] **Step 4: Build, run everything, commit**

Run: `pnpm --filter @lumaforge/lmfg-cli build && pnpm --filter @lumaforge/lmfg-cli test && pnpm --filter @lumaforge/lmfg-cli typecheck && pnpm exec eslint "packages/lmfg-cli/src/**/*.ts" "packages/lmfg-cli/*.ts"`
Expected: all PASS; e2e suite ≈ 25 s.

```bash
git add packages/lmfg-cli/src/e2e
git commit -m "test(cli): add end-to-end agent loop and packaged bin smoke tests"
```

---

### Task 16: CI job and root verification wiring

**Files:**
- Modify: `.github/workflows/build.yml`
- Modify: `package.json` (root `test:cli` already added in Task 1; add `cli:build`)

- [x] **Step 1: Extend the `changes` job**

Add output `cli: ${{ steps.detect.outputs.cli }}`, then in the detect script:

```bash
          cli_paths='^(packages/lmfg-cli/|packages/render-engine/|packages/luma-(color|jpeg|raw)-runtime/|packages/luma-native-artifacts/|scripts/native-runtime/)'
```

Initialize `cli=false`, set `cli=true` inside `force_all`, and add `if matches "$cli_paths"; then cli=true; fi` in the else branch; append `echo "cli=$cli" >> "$GITHUB_OUTPUT"`.

- [x] **Step 2: Add the `cli` job (after `runtime`)**

```yaml
  cli:
    needs: changes
    if: ${{ needs.changes.outputs.cli == 'true' }}
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - name: Use Node.js
        uses: actions/setup-node@v4
        with:
          node-version: lts/*

      - name: Setup pnpm
        uses: pnpm/action-setup@v4
        with:
          run_install: false

      - name: Configure pnpm store
        run: pnpm config set store-dir ~/.pnpm-store

      - name: Cache pnpm store
        uses: actions/cache@v4
        with:
          path: ~/.pnpm-store
          key: ${{ runner.os }}-pnpm-${{ hashFiles('pnpm-lock.yaml') }}
          restore-keys: |
            ${{ runner.os }}-pnpm-

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Prepare prebuilt native assets
        run: LUMAFORGE_NATIVE_RUNTIME_MODE=prebuilt pnpm native:prepare

      - name: Build runtime packages and render engine
        run: pnpm cli:build:deps

      - name: Typecheck and build lmfg CLI
        run: pnpm --filter @lumaforge/lmfg-cli typecheck && pnpm --filter @lumaforge/lmfg-cli build

      - name: Fetch public RAW smoke fixture
        run: pnpm --filter @lumaforge/luma-raw-runtime fixtures:fetch-public

      - name: Test lmfg CLI
        run: pnpm --filter @lumaforge/lmfg-cli test

      - name: Smoke the packaged CLI
        run: |
          node packages/lmfg-cli/bin/lmfg.mjs capabilities --quiet
          pnpm --filter @lumaforge/render-engine exec npm pack --dry-run
          pnpm --filter @lumaforge/lmfg-cli pack:dry-run
```

Update the final gate job: `needs: [changes, app, runtime, native, cli]`, add `CLI_RESULT: ${{ needs.cli.result }}` and include `"$CLI_RESULT"` in the loop.

- [x] **Step 3: Root scripts**

```json
    "cli:build:deps": "pnpm --filter @lumaforge/luma-color-runtime build && pnpm --filter @lumaforge/luma-jpeg-runtime build && pnpm --filter @lumaforge/luma-raw-runtime build && pnpm --filter @lumaforge/render-engine build",
    "cli:build": "pnpm cli:build:deps && pnpm --filter @lumaforge/lmfg-cli build",
```

- [x] **Step 4: Verify the workflow parses and commit**

Run: `node -e "require('node:fs').readFileSync('.github/workflows/build.yml','utf8')" && pnpm exec eslint "*.{js,mjs,cjs,ts}" && pnpm cli:build`
Expected: exit 0.

```bash
git add .github/workflows/build.yml package.json
git commit -m "ci: add lmfg CLI build, test, and pack gate"
```

---

### Task 17: Documentation, project map, spec status, release checklist

**Files:**
- Create: `packages/lmfg-cli/README.md`, `packages/lmfg-cli/LICENSE` (copy of root `LICENSE`)
- Modify: `AGENTS.md`, `README.md`, `docs/specs/2026-06-23-lmfg-cli-tier0-1-design.md`

- [x] **Step 1: Write `packages/lmfg-cli/README.md`**

````markdown
# @lumaforge/lmfg-cli

`lmfg` is the agent-friendly, reproducible RAW/LUT rendering CLI for LumaForge.
It drives the same headless engine the browser app uses
(`@lumaforge/render-engine` over the `luma-raw`, `luma-color`, and `luma-jpeg`
runtimes) from Node.js, and records every render in a sealed `RenderManifest`.

This release ships the **cpu-wasm tier**: in-process WebAssembly decode, CPU
color pipeline, and the authoritative full-resolution JPEG export. The
browser bridge tier (WebGL2 via Playwright) is not included; `lmfg
capabilities` reports it as unavailable and `--tier browser` exits with code 3.

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
| `render preview --params` | One CPU preview (quick ≤ 2.5 MP or bounded HQ up to 12 MP) |
| `render candidate --plan`, `render sweep --plan` | Multi-candidate iterations with per-candidate manifests, metrics, and tiles |
| `compare sheet --iteration --layout <cols>x<rows>` | Recompose contact sheets from stored tiles |
| `metrics compute --iteration --candidate` | Luma/chroma statistics for a candidate |
| `render export (--iteration --candidate | --params)` | Full-resolution JPEG; refuses when reproducibility cannot be proven |
| `manifest verify <file>`, `manifest show <file>` | Canonical-hash verification and display |

Global flags: `--workspace <dir>` (default `.lmfg`), `--session <id>`,
`--tier cpu|browser`, `--emit json|ndjson`, `--json`, `--quiet`, `--no-color`,
`--dry-run`, `--yes`, `--timeout <ms>`, `--memory-profile desktop|low-memory`.

## Params, plans, sweeps, contracts

`lmfg schema show lmfg.params.v1` prints the authoritative schema. Example:

```json
{
  "exposure_ev": 0.3, "contrast": 15, "highlights": -20, "shadows": 10,
  "whites": 0, "blacks": 0, "temperature": 5, "tint": 0,
  "saturation": 0, "vibrance": 10, "intensity": 1,
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

LUTs whose contract cannot be confirmed from `LUMAFORGE_*` comments must carry
an explicit `contract`; `lut contract infer` returns ready-to-use
`suggested_contracts`. Rendering never guesses a log/gamut contract.

## Workspace layout

```
.lmfg/sessions/sess_<timestamp>_<id>/
  session.json
  source/{source.identity.json, inspect.json, embedded-preview.jpg}
  previews/prev_0001.jpg, prev_0001.manifest.json
  iterations/iter_0001/{plan.json, events.ndjson, contact-sheet.jpg, contact-sheet.map.json}
  iterations/iter_0001/candidates/cand_0001/{preview.jpg, manifest.json, metrics.json, params.json, tile.rgba, tile.json}
  exports/final.jpg, final.manifest.json
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
| 8 | export refused (cannot prove reproducibility) |
| 9 | cancelled / timed out |
| 10 | internal bug |

## Releasing

1. `pnpm cli:build && pnpm --filter @lumaforge/lmfg-cli test`
2. `pnpm --filter @lumaforge/render-engine exec npm pack --dry-run` and
   `pnpm --filter @lumaforge/lmfg-cli pack:dry-run` — both must succeed.
3. Publish `@lumaforge/render-engine` first (it is a `workspace:*` dependency),
   then `@lumaforge/lmfg-cli`. The runtime packages and
   `@lumaforge/luma-native-artifacts` are already published.
````

- [x] **Step 2: `AGENTS.md` (and therefore `CLAUDE.md`)**

Under "Current Architecture", after the `packages/luma-native-artifacts` bullet, add:

```markdown
- `packages/lmfg-cli` is the `lmfg` agent-facing CLI (cpu-wasm tier). It
  composes `@lumaforge/render-engine` and the Node entries of the RAW/JPEG
  runtimes; `src/services/*` holds the domain logic (LUT contracts, color graph
  descriptors, preview, iterations, fail-closed export, manifests),
  `src/commands/*` are thin protocol adapters, and `src/protocol/*` owns the
  JSON/NDJSON envelope and spec exit codes. The browser bridge tier is not
  shipped; keep `capabilities` honest about it.
```

Under "Verification" progressive list, add:

```markdown
  - CLI changes under `packages/lmfg-cli`: run `pnpm cli:build` once, then
    `pnpm --filter @lumaforge/lmfg-cli typecheck` and `pnpm test:cli`. The e2e
    suite needs the public DNG fixture
    (`pnpm --filter @lumaforge/luma-raw-runtime fixtures:fetch-public`).
```

- [x] **Step 3: Root `README.md`**

Add under "## Architecture" (end of section):

```markdown
### Command line: `lmfg`

`packages/lmfg-cli` ships `lmfg`, a Node.js CLI for agents and scripts that
runs the same RAW → look → export pipeline headlessly with sealed render
manifests. See `packages/lmfg-cli/README.md` for the agent loop, JSON protocol,
and exit codes. Build it with `pnpm cli:build`.
```

- [x] **Step 4: Spec status**

Insert after the title of `docs/specs/2026-06-23-lmfg-cli-tier0-1-design.md`:

```markdown
- Status: Tier 0 (cpu-wasm) implemented per
  `docs/plans/2026-09-05-lmfg-cli-tier0-release-plan.md`; Tier 1 (browser
  bridge, §6) deferred. `capabilities` reports the browser tier as
  unavailable. JSON is the default stdout format (`--json` is a no-op).
```

- [x] **Step 5: LICENSE copy, final verification, commit**

Run:

```bash
cp LICENSE packages/lmfg-cli/LICENSE
pnpm lint:check
pnpm test:runtime
pnpm cli:build
pnpm --filter @lumaforge/lmfg-cli test
pnpm --filter @lumaforge/lmfg-cli pack:dry-run
pnpm --filter @lumaforge/render-engine exec npm pack --dry-run
pnpm test:run
LUMAFORGE_NATIVE_RUNTIME_MODE=prebuilt pnpm build
```

Expected: all exit 0; `npm pack --dry-run` lists `bin/lmfg.mjs`, `dist/cli.js`, `dist/index.js`, `dist/src/**/*.d.ts`, `README.md`, `LICENSE`.

```bash
git add packages/lmfg-cli/README.md packages/lmfg-cli/LICENSE AGENTS.md README.md docs/specs/2026-06-23-lmfg-cli-tier0-1-design.md
git commit -m "docs(cli): document lmfg usage, protocol, and release checklist"
```

---

## Self-review

**Spec coverage (§3 command surface → task):** introspection (§3.1) → Task 9; session (§3.2) → Task 10; inspect (§3.3) → Task 10; LUT contract (§3.4) → Task 8; render preview/candidate/sweep/export (§3.5) → Tasks 12, 13, 14; compare sheet + metrics (§3.6) → Task 13; manifest verify/show (§3.7) → Task 11. Protocol §4.1–4.4 → Task 2 (`--emit ndjson` events in Tasks 12–14). Workspace §5 → Task 4 (`luts/cache` is not created: LUTs are referenced by path and hashed, never cached). Render harness §6 → deferred (D1). Capabilities §7 → Task 5. Global flags §8 → Task 9 (`--tier browser` → exit 3; `--dry-run` handled per command; `--yes` gates export overwrite; `--timeout` → exit 9). Milestones M0–M5 map to Tasks 1–2/9, 4/10, 8, 7/11/12, 13/14, 15/16.

**Deviations from the spec, stated:** JSON is the default output (D2); candidate concurrency is 1 (D4); `metrics compute` and `render export --candidate` require `--iteration` because candidate ids repeat per iteration; `manifest verify` exits 1 on an invalid manifest so shell chains stop.

**Placeholder scan:** no TBD/TODO; every code step carries the code. Task 10 Step 5 and Task 9 Step 5 carry explicit "when implementing" notes for two import/ordering details instead of leaving gaps.

**Type consistency:** `LmfgError(code, { message, retryable, suggestedNextActions, details, cause })` is used uniformly; `runCommand(ctx, { schema, command }, run, dryRun)` matches every command module; `SessionStore.allocate(id, 'previews'|'iterations'|'exports')` is used by preview, iteration, and export; `IterationStore.candidatePaths/writeCandidate/readCandidateTile/readCandidateParams/readCandidateMetrics/writeContactSheet/read/appendEvent` are used by Tasks 13–14 with the signatures defined in Task 4; `ResolvedLut.identity.sha256` is the LUT file hash used by both manifests and the export guard; `RenderParams` (schema) vs `ManifestRenderParams` (engine) are always converted through `toManifestRenderParams`.

---

## Execution notes (2026-09-05)

All 17 tasks were executed on branch `feat/lmfg-cli-tier0` and fast-forwarded
into `main`. Deviations from the plan text, all deliberate:

1. `dist` has a single `index.js` entry and `bin/lmfg.mjs` imports
   `../dist/index.js`; the two-entry build duplicated the program into a
   `cli2.js` chunk.
2. `runFullResolutionExport` resolves the raw-render exposure with a throwaway
   `raw.decodeQuick(...)` before opening the export session. Running a quick
   decode on the same session makes LibRaw processed-window reads fail
   (`RAW runtime request failed`), so preview and export never share a session.
3. `computeImageMetrics` initialises the histogram with a loop; `eslint --fix`
   rewrote `Array.from({ length }, () => 0)` into an `unknown[]`. Run
   `typecheck` after lint, not before.
4. `describeWithFixture` carries an explicit `typeof describe` annotation so
   declaration emit stays portable.
5. `@lumaforge/render-engine` `typecheck` has a pre-existing failure in
   `src/export/jpeg/jpeg-metadata.test.ts` (BlobPart typing) that predates this
   work; its `build` (which excludes tests) passes and is what the CLI consumes.

Verification evidence at closeout: package suite 25 files / 78 tests (real
fixture end-to-end loop included); root `pnpm test:run` 257 files / 2085 tests;
`pnpm test:runtime` green; `pnpm lint:check` clean;
`LUMAFORGE_NATIVE_RUNTIME_MODE=prebuilt pnpm build` OK; `npm pack --dry-run` OK
for `render-engine` (96 files) and `lmfg-cli` (bin, dist, README, LICENSE).

Release blocker unchanged (D12): publish `@lumaforge/render-engine` before
`@lumaforge/lmfg-cli`.
