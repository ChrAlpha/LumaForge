// @vitest-environment node
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const BIN = join(PACKAGE_DIR, 'bin', 'lmfg-mcp.mjs')
const DIST = join(PACKAGE_DIR, 'dist', 'index.js')
const CLI_DIST = join(PACKAGE_DIR, '..', 'lmfg-cli', 'dist', 'index.js')

const distReady = existsSync(DIST) && existsSync(CLI_DIST)
if (!distReady && process.env.LMFG_REQUIRE_FIXTURE === '1') {
  throw new Error(
    `LMFG_REQUIRE_FIXTURE is set but the MCP e2e needs built packages: run pnpm cli:build (missing ${
      existsSync(DIST) ? CLI_DIST : DIST
    }).`,
  )
}
const describeWithDist = distReady ? describe : describe.skip

describeWithDist('lmfg-mcp over stdio', () => {
  let cwd: string
  let client: Client
  let transport: StdioClientTransport

  beforeAll(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'lmfg-mcp-e2e-'))
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [BIN, '--cwd', cwd],
      stderr: 'pipe',
    })
    client = new Client({ name: 'lmfg-mcp-e2e', version: '0.0.0' })
    await client.connect(transport)
  })

  afterAll(async () => {
    await client.close()
    await rm(cwd, { recursive: true, force: true })
  })

  it('lists every CLI command as a tool with an input schema', async () => {
    const { tools } = await client.listTools()
    const names = tools.map((tool) => tool.name).sort()
    expect(names).toEqual(
      expect.arrayContaining([
        'lmfg_version',
        'lmfg_capabilities',
        'lmfg_session_init',
        'lmfg_render_preview',
        'lmfg_render_sweep',
        'lmfg_render_export',
        'lmfg_render_replay',
        'lmfg_metrics_rank',
        'lmfg_manifest_verify',
      ]),
    )
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe('object')
      expect(tool.description).toContain('lmfg')
    }
  })

  it('runs a successful tool and returns the CLI envelope as structured content', async () => {
    const result = await client.callTool({
      name: 'lmfg_version',
      arguments: {},
    })
    expect(result.isError).toBeFalsy()
    expect(result.structuredContent).toMatchObject({
      schema: 'lmfg.version.v1',
      ok: true,
      exit_code: 0,
    })
    const text = (result.content as Array<{ type: string; text: string }>)[0]
    expect(JSON.parse(text.text)).toMatchObject({ ok: true })
  })

  it('maps CLI failures to isError with the CLI error code', async () => {
    const result = await client.callTool({
      name: 'lmfg_session_status',
      arguments: { session: 'sess_missing' },
    })
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { code: expect.stringMatching(/session|not_found|file/) },
    })
  })

  it('rejects invalid tool input before reaching the CLI', async () => {
    const invalid = await client.callTool({
      name: 'lmfg_schema_show',
      arguments: {},
    })
    expect(invalid.isError).toBe(true)
    expect(
      (invalid.content as Array<{ type: string; text: string }>)[0].text,
    ).toMatch(/invalid|id/i)
    const shown = await client.callTool({
      name: 'lmfg_schema_show',
      arguments: { id: 'lmfg.objective.v1' },
    })
    expect(shown.isError).toBeFalsy()
    expect(shown.structuredContent).toMatchObject({
      result: { id: 'lmfg.objective.v1' },
    })
  })
})
