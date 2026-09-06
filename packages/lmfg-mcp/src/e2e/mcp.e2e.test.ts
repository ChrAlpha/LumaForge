// @vitest-environment node
import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { computeManifestSha256 } from '@lumaforge/render-engine'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import sharp from 'sharp'
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
    cwd = await realpath(await mkdtemp(join(tmpdir(), 'lmfg-mcp-e2e-')))
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
        'lmfg_export_detail',
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

  it('delivers a verified export crop as lossless PNG over real SDK stdio transport', async () => {
    const dir = join(cwd, '.lmfg', 'sessions', 'sess_detail')
    await mkdir(join(dir, 'exports'), { recursive: true })
    const full = { width: 32, height: 24 }
    const pixels = Buffer.from(
      Array.from(
        { length: full.width * full.height * 3 },
        (_, index) => (index * 37 + Math.floor(index / 32) * 11) % 256,
      ),
    )
    const jpeg = await sharp(pixels, { raw: { ...full, channels: 3 } })
      .withMetadata({ orientation: 1 })
      .jpeg({ quality: 87 })
      .toBuffer()
    const digest = (bytes: Buffer) =>
      createHash('sha256').update(bytes).digest('hex')
    const unsealed = {
      manifest_version: 1,
      kind: 'export',
      parent_manifest_sha256: 'b'.repeat(64),
      source_raw: {
        sha256: 'a'.repeat(64),
        byte_size: 123,
        decoded_dimensions: full,
      },
      policy: { kind: 'export-full' },
      output: {
        format: 'jpeg',
        color_space: 'srgb',
        dimensions: full,
        filename: 'final.jpg',
        sha256: digest(jpeg),
      },
    }
    const manifestSha = computeManifestSha256(unsealed)
    await writeFile(
      join(dir, 'session.json'),
      JSON.stringify({
        schema: 'lmfg.session.v1',
        id: 'sess_detail',
        source: { sha256: 'a'.repeat(64), byte_size: 123 },
      }),
    )
    await writeFile(join(dir, 'exports', 'final.jpg'), jpeg)
    await writeFile(
      join(dir, 'exports', 'final.manifest.json'),
      JSON.stringify({
        ...unsealed,
        manifest_sha256: manifestSha,
      }),
    )
    const region = { x: 3, y: 5, width: 17, height: 11 }
    const result = await client.callTool({
      name: 'lmfg_export_detail',
      arguments: {
        session: 'sess_detail',
        export_name: 'final',
        region,
      },
    })
    expect(result.isError).toBe(false)
    expect(result.structuredContent).toMatchObject({
      schema: 'lmfg.export.detail.v1',
      ok: true,
      result: {
        export_manifest_sha256: manifestSha,
        input_jpeg_sha256: digest(jpeg),
        region,
        width: 17,
        height: 11,
        mime_type: 'image/png',
      },
    })
    const content = result.content as Array<{
      type: string
      mimeType?: string
      data?: string
    }>
    const image = content.find((part) => part.type === 'image')!
    expect(image.mimeType).toBe('image/png')
    const png = Buffer.from(image.data!, 'base64')
    const output = (
      result.structuredContent as { result: { uri: string; sha256: string } }
    ).result
    expect(await readFile(fileURLToPath(output.uri))).toEqual(png)
    expect(output.sha256).toBe(digest(png))
    const fullPixels = await sharp(jpeg).removeAlpha().raw().toBuffer()
    const expected = Buffer.alloc(region.width * region.height * 3)
    for (let row = 0; row < region.height; row += 1) {
      const start = ((region.y + row) * full.width + region.x) * 3
      fullPixels.copy(
        expected,
        row * region.width * 3,
        start,
        start + region.width * 3,
      )
    }
    expect(await sharp(png).removeAlpha().raw().toBuffer()).toEqual(expected)
    const loader = `data:text/javascript,${encodeURIComponent("export async function resolve(name, context, next) { if (name === 'sharp') throw new Error('decoder disabled for test'); return next(name, context) }")}`
    const bootstrap = `data:text/javascript,${encodeURIComponent(`import { register } from 'node:module'; register(${JSON.stringify(loader)}, import.meta.url)`)}`
    const missingDecoderClient = new Client({
      name: 'missing-decoder',
      version: 'test',
    })
    try {
      await missingDecoderClient.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: ['--import', bootstrap, BIN, '--cwd', cwd],
          stderr: 'pipe',
        }),
      )
      expect(
        (
          await missingDecoderClient.callTool({
            name: 'lmfg_version',
            arguments: {},
          })
        ).isError,
      ).toBeFalsy()
      const unavailable = await missingDecoderClient.callTool({
        name: 'lmfg_export_detail',
        arguments: { session: 'sess_detail', export_name: 'final', region },
      })
      expect(unavailable.isError).toBe(true)
      expect(unavailable.structuredContent).toMatchObject({
        error: {
          code: 'export_detail.refused',
          message: expect.stringMatching(/Sharp.*install/i),
        },
      })
    } finally {
      await missingDecoderClient.close()
    }
    const refused = await client.callTool({
      name: 'lmfg_export_detail',
      arguments: {
        session: 'sess_detail',
        export_name: 'final',
        region: { x: 31, y: 0, width: 2, height: 1 },
      },
    })
    expect(refused.isError).toBe(true)
    expect(refused.structuredContent).toMatchObject({
      error: { code: 'export_detail.refused' },
    })
    expect(
      (refused.content as Array<{ type: string }>).every(
        (part) => part.type !== 'image',
      ),
    ).toBe(true)
    await writeFile(
      join(dir, 'exports', 'final.jpg'),
      Buffer.concat([jpeg, Buffer.from('drift')]),
    )
    const tampered = await client.callTool({
      name: 'lmfg_export_detail',
      arguments: {
        session: 'sess_detail',
        export_name: 'final',
        region,
      },
    })
    expect(tampered.isError).toBe(true)
    expect(tampered.structuredContent).toMatchObject({
      error: { message: expect.stringMatching(/hash/i) },
    })
  })
  it('exits cleanly when stdin closes', async () => {
    const child = spawn(process.execPath, [BIN, '--cwd', cwd], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    const exited = new Promise<number | null>((resolve) => {
      child.on('exit', (code) => resolve(code))
    })
    child.stdin.end()
    expect(await exited).toBe(0)
    expect(stderr).not.toMatch(/unsettled top-level await/i)
  })
})
