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
npm install -g @lumaforge/lmfg-mcp   # installs @lumaforge/lmfg-cli as a dependency
lmfg-mcp --cwd /path/to/project      # serves tools on stdio
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

| Tool | CLI command | Notes |
|---|---|---|
| `lmfg_version`, `lmfg_capabilities` | `version`, `capabilities` | |
| `lmfg_schema_list`, `lmfg_schema_show` | `schema list`, `schema show <id>` | JSON Schema for params, plans, objectives, results |
| `lmfg_session_init`, `lmfg_session_status`, `lmfg_session_list` | `session …` | `session_init` takes a RAW path |
| `lmfg_inspect` | `inspect [file]` | |
| `lmfg_lut_inspect`, `lmfg_lut_contract_infer`, `lmfg_lut_contract_validate` | `lut …` | `contract` is passed inline as an object |
| `lmfg_lut_fetch` | `lut fetch` | network stays off unless `allow_network: true` |
| `lmfg_render_preview` | `render preview` | `params` is an inline `lmfg.params.v1` object |
| `lmfg_render_candidate`, `lmfg_render_sweep` | `render candidate\|sweep` | `plan` inline; `concurrency` `auto` or 1-64 |
| `lmfg_render_export` | `render export` | fails closed like the CLI; `yes` overwrites |
| `lmfg_render_replay` | `render replay` | reports `reproduced` |
| `lmfg_compare_sheet` | `compare sheet` | |
| `lmfg_metrics_compute`, `lmfg_metrics_compare`, `lmfg_metrics_rank` | `metrics …` | `objective` inline (`lmfg.objective.v1`) |
| `lmfg_manifest_verify`, `lmfg_manifest_show` | `manifest …` | |

Every result of these tools is `{ schema, ok, result | error, exit_code }`.
Failures set `isError: true` and keep the CLI error code (for example
`export.refused`, `lut.contract.incomplete`, `replay.mismatch`) so an agent can
branch on it. Progress events (`--emit ndjson`) are not streamed through MCP;
long renders simply return when done, and `timeout_ms` maps to the CLI
`--timeout`.

## Image tools

These two tools have no CLI command. They read files from the session
workspace that earlier tools wrote, verify them, and return
`{ schema, ok, result | error }` (no `exit_code`) together with an image.

| Tool | Returns | Notes |
|---|---|---|
| `lmfg_image_read` | JPEG of one session preview, candidate, or contact sheet, plus its SHA-256, source identity, dimensions, and the contact-sheet tile-to-candidate map | schema `lmfg.image.read.v1`; refuses with `image.refused`; at most 8 MiB and 16 MP |
| `lmfg_export_detail` | Lossless 1:1 PNG of a region of an existing full-resolution export, after verifying its sealed manifest, source identity, dimensions, and JPEG hash | schema `lmfg.export.detail.v1`; refuses with `export_detail.refused`; source at most 120 MP / 512 MiB, region at most 2 MP, PNG at most 8 MiB; writes the PNG and a receipt under the session's `exports/details` |

They view pixels that already exist: neither renders new RAW pixels nor
enlarges a preview.

### What they verify

Both tools read the workspace through the layout and record schemas
`@lumaforge/lmfg-cli` exports, so they accept the records the CLI itself
accepts and nothing looser:

- `session.json`, an iteration `plan.json`, and a contact-sheet map must pass
  the CLI's `SessionRecordSchema`, `IterationRecordSchema`, and
  `ContactSheetMapSchema` in full, plan params included (`lmfg.params.v1`),
  and every identifier they name, like every identifier in a request, must be
  a single portable path segment.
- Every manifest must pass the render-engine `parseRenderManifest`:
  `manifest_sha256` over the whole file, then the complete `RenderManifest`
  v1 structure.
- `lmfg_export_detail` opens `exports/<export_name>.jpg` and its manifest,
  requires a full-resolution export (kind `export`, policy `export-full`),
  and accepts the recorded output dimensions only when they are the size the
  export delivers: the decoded source frame, or, for a manifest that records
  a Transform geometry, the frame the render-engine export planner derives
  from that source, which the recorded geometry output must also state.

Compatibility: earlier development builds of this server checked only the
fields each tool read, and `lmfg_export_detail` refused any export whose
output size differed from the decoded source frame. A record or manifest the
CLI would refuse is now refused here too (`image.refused`,
`export_detail.refused`), and an export whose recorded geometry changes the
frame size opens once its dimensions agree with that plan.

## Development

```bash
pnpm cli:build                                   # builds runtimes, render engine, CLI, and this server
pnpm --filter @lumaforge/lmfg-mcp typecheck
LMFG_REQUIRE_FIXTURE=1 pnpm --filter @lumaforge/lmfg-mcp test   # unit + stdio e2e against the built bin
```
