# @lumaforge/lmfg-mcp

MCP (Model Context Protocol) server that exposes the [`lmfg`](../lmfg-cli/README.md)
RAW/LUT rendering CLI as tools over stdio. It is a thin wrapper: every tool
maps to one CLI command, runs it in-process, and returns the CLI's JSON
envelope unchanged as structured content, so exit codes, error codes, fail-closed
export rules, and manifests are exactly those of the CLI.

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
`.lmfg` workspace lives by default; every tool also accepts `workspace`.

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

Every result is `{ schema, ok, result | error, exit_code }`. Failures set
`isError: true` and keep the CLI error code (for example `export.refused`,
`lut.contract.incomplete`, `replay.mismatch`) so an agent can branch on it.
Progress events (`--emit ndjson`) are not streamed through MCP; long renders
simply return when done, and `timeout_ms` maps to the CLI `--timeout`.

## Development

```bash
pnpm cli:build                                   # builds runtimes, render engine, CLI, and this server
pnpm --filter @lumaforge/lmfg-mcp typecheck
LMFG_REQUIRE_FIXTURE=1 pnpm --filter @lumaforge/lmfg-mcp test   # unit + stdio e2e against the built bin
```
