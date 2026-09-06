import process from 'node:process'

import type { CliIo } from '@lumaforge/lmfg-cli'
import { runCli } from '@lumaforge/lmfg-cli'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

import { registerExportDetailTool } from './export-detail-tool'
import { registerImageTool } from './image'
import { TOOLS } from './tools'

export type Envelope = {
  schema: string
  ok: boolean
  result?: unknown
  error?: { code: string; message: string; [key: string]: unknown }
}

export type ToolRun = {
  exitCode: number
  envelope: Envelope
  stderr: string
}

/**
 * Run one CLI invocation in-process and return its envelope. The CLI is the
 * source of truth: stdout carries exactly one JSON line in `--emit json` mode.
 */
export async function runCliTool(
  argv: readonly string[],
  cwd: string,
  cli: typeof runCli = runCli,
): Promise<ToolRun> {
  const out: string[] = []
  const err: string[] = []
  const io: CliIo = {
    stdout: (chunk) => {
      out.push(chunk)
    },
    stderr: (chunk) => {
      err.push(chunk)
    },
    cwd,
  }
  const exitCode = await cli([...argv, '--quiet'], io)
  const lines = out.join('').trim().split('\n').filter(Boolean)
  const last = lines.at(-1)
  let envelope: Envelope
  try {
    envelope = last
      ? (JSON.parse(last) as Envelope)
      : {
          schema: 'lmfg.error.v1',
          ok: false,
          error: { code: 'internal', message: 'The CLI produced no output.' },
        }
  } catch {
    envelope = {
      schema: 'lmfg.error.v1',
      ok: false,
      error: {
        code: 'internal',
        message: `The CLI produced non-JSON output: ${last?.slice(0, 200) ?? ''}`,
      },
    }
  }
  return { exitCode, envelope, stderr: err.join('') }
}

export function toCallToolResult(run: ToolRun): CallToolResult {
  const structured = {
    ...run.envelope,
    exit_code: run.exitCode,
  }
  return {
    content: [{ type: 'text', text: JSON.stringify(structured) }],
    structuredContent: structured,
    isError: !run.envelope.ok,
  }
}

export type ServerOptions = {
  cwd: string
  version: string
  cli?: typeof runCli
}

export function createLmfgMcpServer(options: ServerOptions): McpServer {
  const server = new McpServer({ name: 'lmfg', version: options.version })
  registerImageTool(server, options.cwd)
  registerExportDetailTool(server, options.cwd)
  for (const spec of TOOLS) {
    server.registerTool(
      spec.name,
      {
        title: spec.title,
        description: `${spec.description} Returns the lmfg JSON envelope (${spec.resultSchema} on success).`,
        inputSchema: z.object(spec.inputShape),
      },
      async (args) => {
        const argv = spec.argv(args as Record<string, unknown>)
        const run = await runCliTool(argv, options.cwd, options.cli)
        return toCallToolResult(run)
      },
    )
  }
  return server
}

function parseServerArgs(argv: readonly string[]): { cwd: string } {
  let cwd = process.cwd()
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--cwd' && argv[i + 1]) {
      cwd = argv[i + 1]
      i += 1
    } else if (arg.startsWith('--cwd=')) {
      cwd = arg.slice('--cwd='.length)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return { cwd }
}

/** Entry used by `bin/lmfg-mcp.mjs`: serve tools over stdio until stdin closes. */
export async function runMcpServer(
  argv: readonly string[],
  version: string,
): Promise<number> {
  let parsed: { cwd: string }
  try {
    parsed = parseServerArgs(argv)
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\nUsage: lmfg-mcp [--cwd <dir>]\n`,
    )
    return 2
  }
  const server = createLmfgMcpServer({ cwd: parsed.cwd, version })
  const transport = new StdioServerTransport()
  await server.connect(transport)
  await new Promise<void>((resolve) => {
    // `Protocol.connect` owns `transport.onclose`; observe the server instead.
    server.server.onclose = () => resolve()
    // The stdio transport only listens for data, so EOF on stdin (the host
    // went away) must close the server explicitly or the process lingers.
    process.stdin.once('end', () => {
      void server.close().catch(() => undefined)
    })
  })
  return 0
}
