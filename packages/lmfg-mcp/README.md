# @lumaforge/lmfg-mcp

MCP (Model Context Protocol) server that exposes the [`lmfg`](../lmfg-cli/README.md)
RAW/LUT rendering CLI as tools over stdio. Most tools are thin wrappers: each
maps to one CLI command, runs it in-process, and returns the CLI's JSON
envelope unchanged as structured content, so exit codes, error codes, fail-closed
export rules, and manifests are exactly those of the CLI. Two MCP-only tools
return image content for artifacts the CLI already wrote; see
[Image tools](#image-tools).

## Install and run

```bash
npm install -g @lumaforge/lmfg-mcp # installs @lumaforge/lmfg-cli as a dependency
lmfg-mcp --cwd /path/to/project    # serves tools on stdio
```

Claude Code / Claude Desktop style configuration:

```json
{
  "mcpServers": {
    "lmfg": { "command": "lmfg-mcp", "args": ["--cwd", "/path/to/project"] }
  }
}
```

`--cwd` sets the directory relative paths resolve against and where the
`.lmfg` workspace lives by default; tools that touch the workspace also
accept `workspace`.

## Tools

| Tool                                                                        | CLI command                       | Notes                                              |
| --------------------------------------------------------------------------- | --------------------------------- | -------------------------------------------------- |
| `lmfg_version`, `lmfg_capabilities`                                         | `version`, `capabilities`         |                                                    |
| `lmfg_schema_list`, `lmfg_schema_show`                                      | `schema list`, `schema show <id>` | JSON Schema for params, plans, objectives, results |
| `lmfg_session_init`, `lmfg_session_status`, `lmfg_session_list`             | `session …`                       | `session_init` takes a RAW path                    |
| `lmfg_inspect`                                                              | `inspect [file]`                  |                                                    |
| `lmfg_lut_inspect`, `lmfg_lut_contract_infer`, `lmfg_lut_contract_validate` | `lut …`                           | `contract` is passed inline as an object           |
| `lmfg_lut_fetch`                                                            | `lut fetch`                       | network stays off unless `allow_network: true`     |
| `lmfg_render_preview`                                                       | `render preview`                  | `params` is an inline `lmfg.params.v1` object      |
| `lmfg_render_candidate`, `lmfg_render_sweep`                                | `render candidate\|sweep`         | `plan` inline; `concurrency` `auto` or 1-64        |
| `lmfg_render_export`                                                        | `render export`                   | fails closed like the CLI; `yes` overwrites        |
| `lmfg_render_replay`                                                        | `render replay`                   | reports `reproduced`                               |
| `lmfg_compare_sheet`                                                        | `compare sheet`                   |                                                    |
| `lmfg_metrics_compute`, `lmfg_metrics_compare`, `lmfg_metrics_rank`         | `metrics …`                       | `objective` inline (`lmfg.objective.v1`)           |
| `lmfg_manifest_verify`, `lmfg_manifest_show`                                | `manifest …`                      |                                                    |

Every result of these tools is `{ schema, ok, result | error, exit_code }`.
Failures set `isError: true` and keep the CLI error code (for example
`export.refused`, `lut.contract.incomplete`, `replay.mismatch`,
`manifest.invalid`) and its `details`, including `cleanup_failures`, so an
agent can branch on it. Progress events (`--emit ndjson`) are not streamed
through MCP; long renders simply return when done, and `timeout_ms` maps to
the CLI `--timeout`.

### Input validation

Arguments are checked twice, in order. The MCP SDK first validates them
against the tool's input schema; a call that fails it returns an
input-validation error (`isError: true` with the SDK's text message, such as
`MCP error -32602: Input validation error: ...`, and no `lmfg` envelope or
structured content), and the CLI never runs. The schemas of the CLI-backed
tools check types and the syntax of a few fields (a lowercase hex `sha256`, a
`<cols>x<rows>` layout); they pass identifiers such as `session`,
`iteration`, `candidate`, and `name` through as strings. The CLI then applies
its own checks, including the portable path-segment rule its workspace layout
applies to every identifier it joins into a path (see the `lmfg` README), and
reports a failure as an ordinary envelope such as `args.invalid` (exit 2).

## Image tools

These two tools have no CLI command. They read files from the session
workspace that earlier tools wrote, verify them, and return
`{ schema, ok, result | error }` (no `exit_code`) together with an image.

| Tool                 | Returns                                                                                                                                              | Notes                                                                                                                                                                                                             |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lmfg_image_read`    | JPEG of one session preview, candidate, or contact sheet, plus its SHA-256, source identity, dimensions, and the contact-sheet tile-to-candidate map | schema `lmfg.image.read.v1`; refuses with `image.refused`; at most 8 MiB and 16 MP                                                                                                                                |
| `lmfg_export_detail` | Lossless 1:1 PNG of a region of an existing full-resolution export, after verifying its sealed manifest, source identity, dimensions, and JPEG hash  | schema `lmfg.export.detail.v1`; refuses with `export_detail.refused`; source at most 120 MP / 512 MiB, region at most 2 MP, PNG at most 8 MiB; writes the PNG and a receipt under the session's `exports/details` |

They view pixels that already exist: neither renders new RAW pixels nor
enlarges a preview.

### What they verify

Both tools read the workspace through the layout and record schemas
`@lumaforge/lmfg-cli` exports, so they accept the records the CLI itself
accepts and nothing looser:

- Request identifiers pass two checks in turn. The tool's input schema
  requires each `session`, `preview_id`, `iteration_id`, `candidate_id`,
  contact-sheet `name`, and `export_name` to start with an ASCII letter or
  digit and continue with letters, digits, `_`, or `-` (`export_name` and the
  export tool's `session` also allow `.`), at most 96 characters; a value
  that fails it is an input-validation error before the tool runs. The CLI's
  `workspacePaths` then holds every identifier to the full portable
  path-segment rule, which also refuses what that syntax lets through: a
  Windows device name such as `con`, and, where dots are allowed, a trailing
  dot or a device name with an extension such as `nul.txt`. That refusal is
  `image.refused` or `export_detail.refused`.
- `session.json`, an iteration `plan.json`, and a contact-sheet map must pass
  the CLI's `SessionRecordSchema`, `IterationRecordSchema`, and
  `ContactSheetMapSchema` in full, plan params included (`lmfg.params.v1`).
  The plan and map schemas hold the identifiers they name to the portable
  path-segment rule, and the session record's `id` must equal the requested
  session.
- Every manifest must pass the render-engine `parseRenderManifest`:
  `manifest_sha256` over the whole file, then the complete `RenderManifest`
  v1 structure as the current writers record it. A manifest `lmfg` 0.1.0
  wrote (color-graph descriptor version 1) is refused.
- `lmfg_export_detail` opens `exports/<export_name>.jpg` and its manifest,
  requires a full-resolution export (kind `export`, policy `export-full`),
  and accepts the recorded output dimensions only when they are the size the
  export delivers: the decoded source frame, or, for a manifest that records
  a Transform geometry, the frame the render-engine export planner derives
  from that source, which the recorded geometry output must also state.

## Development

```bash
pnpm cli:build # builds runtimes, render engine, CLI, and this server
pnpm --filter @lumaforge/lmfg-mcp typecheck
LMFG_REQUIRE_FIXTURE=1 pnpm --filter @lumaforge/lmfg-mcp test # unit + stdio e2e against the built bin
```

The stdio e2e runs the built server against the built CLI and skips when
either build is missing; `LMFG_REQUIRE_FIXTURE=1` makes that a failure. Tools that decode
RAW files need the native artifacts in `packages/luma-native-artifacts` (see
the `lmfg` README's Install section).
