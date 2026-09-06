#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFile, mkdir, realpath, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { z } from 'zod'

import { readRuntimeApiKey } from './credentials.js'
import { createHost } from './host.js'
import { runAgent } from './loop.js'
import { editingPrompt } from './prompt.js'
import { createProvider, redact } from './provider.js'

const help = `lmfg-agent edit --source <RAW> --brief <creative intent> --out <new run directory> [options]

Credentials: LMFG_AGENT_API_KEY environment variable or --key-stdin (hidden on a terminal).
Options:
  --base-url <url>           default https://token.memoh.net/v1
  --model <id>               default grok-4.6
  --max-steps <n>            default 40
  --context-window <tokens>  default 500000 (declared, not independently verified)
  --max-output-tokens <n>    default 8192
  --timeout-ms <n>           default 240000 for a model request
  --tool-timeout-ms <n>      default 180000 for a CLI tool
  --lut <path>               repeat for authorized local LUT files

Reasoning effort is high. Every run has an immutable directory, redacted events.ndjson,
run.json, real image artifacts and full-resolution export/replay evidence.
Exit 0 means verified export completion; exit 2 means incomplete or invalid invocation.
Build first: pnpm cli:build && pnpm --filter @lumaforge/lmfg-agent build
`

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    options: {
      source: { type: 'string' },
      brief: { type: 'string' },
      out: { type: 'string' },
      'base-url': { type: 'string', default: 'https://token.memoh.net/v1' },
      model: { type: 'string', default: 'grok-4.6' },
      'max-steps': { type: 'string', default: '40' },
      'context-window': { type: 'string', default: '500000' },
      'max-output-tokens': { type: 'string', default: '8192' },
      'timeout-ms': { type: 'string', default: '240000' },
      'tool-timeout-ms': { type: 'string', default: '180000' },
      lut: { type: 'string', multiple: true, default: [] },
      'key-stdin': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
    strict: true,
  })
  if (values.help) {
    process.stdout.write(help)
    return 0
  }
  if (positionals.length !== 1 || positionals[0] !== 'edit')
    throw new Error(help)
  const text = z.string().trim().min(1)
  const integer = z.coerce.number().int().positive()
  const invocationCwd = process.env.INIT_CWD ?? process.cwd()
  const config = {
    source: await realpath(resolve(invocationCwd, text.parse(values.source))),
    brief: text.parse(values.brief),
    out: resolve(invocationCwd, text.parse(values.out)),
    baseUrl: text.parse(values['base-url']),
    model: text.parse(values.model),
    reasoningEffort: 'high' as const,
    maxSteps: integer.max(200).parse(values['max-steps']),
    contextWindow: integer.parse(values['context-window']),
    maxOutputTokens: integer.parse(values['max-output-tokens']),
    timeoutMs: integer.parse(values['timeout-ms']),
    toolTimeoutMs: integer.parse(values['tool-timeout-ms']),
    luts: await Promise.all(
      values.lut.map((path) => realpath(resolve(invocationCwd, path))),
    ),
  }
  if (config.maxOutputTokens >= config.contextWindow)
    throw new Error(
      'Output budget must be smaller than the declared context window.',
    )
  const apiKey = await readRuntimeApiKey(values['key-stdin'])
  const complete = createProvider({ ...config, apiKey })
  await mkdir(dirname(config.out), { recursive: true })
  await mkdir(config.out)
  const workspace = resolve(config.out, 'workspace')
  await mkdir(workspace)
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim()
  const manifest = {
    schema: 'lmfg.agent.run.v1',
    process_id: process.pid,
    created_at: new Date().toISOString(),
    revision,
    config,
    protocol: 'chat-completions',
    context_window_basis: 'user-declared',
    status: 'running',
  }
  const safeJson = (value: unknown) => JSON.stringify(redact(value, apiKey))
  await writeFile(resolve(config.out, 'run.json'), safeJson(manifest))
  const record = async (event: Record<string, unknown>): Promise<void> => {
    const entry = { at: new Date().toISOString(), ...event }
    await appendFile(
      resolve(config.out, 'events.ndjson'),
      `${safeJson(entry)}\n`,
    )
    const summary = {
      event: event.event,
      step: event.step,
      name: event.name,
      status: event.status,
      reason: event.reason,
      elapsed_ms: event.elapsed_ms,
      usage: event.usage,
      ...(event.event === 'model_response' ? { message: event.message } : {}),
    }
    process.stdout.write(`${safeJson(summary)}\n`)
  }
  let host: Awaited<ReturnType<typeof createHost>> | undefined
  const controller = new AbortController()
  const cancel = () => controller.abort()
  process.once('SIGINT', cancel)
  process.once('SIGTERM', cancel)
  try {
    host = await createHost({
      repoRoot,
      sourcePath: config.source,
      workspace,
      lutPaths: config.luts,
      toolTimeoutMs: config.toolTimeoutMs,
      record,
    })
    const prompt = editingPrompt({
      source: config.source,
      workspace,
      brief: config.brief,
      luts: config.luts,
      schemas: host.schemas,
      capabilities: host.capabilities,
    })
    const hashes = {
      prompt_sha256: createHash('sha256').update(prompt).digest('hex'),
      tools_sha256: createHash('sha256')
        .update(JSON.stringify(host.tools))
        .digest('hex'),
    }
    const result = await runAgent({
      complete,
      tools: host.tools,
      messages: [
        { role: 'system', content: prompt },
        {
          role: 'user',
          content:
            'Begin editing the supplied RAW according to the creative brief. Make your own visual decisions and verify the final export.',
        },
      ],
      execute: host.execute,
      record,
      maxSteps: config.maxSteps,
      contextWindow: config.contextWindow,
      maxOutputTokens: config.maxOutputTokens,
      signal: controller.signal,
    })
    await writeFile(
      resolve(config.out, 'run.json'),
      safeJson({
        ...manifest,
        ...hashes,
        ...result,
        finished_at: new Date().toISOString(),
      }),
    )
    process.stdout.write(
      `${safeJson({ event: 'run_result', directory: config.out, ...result })}\n`,
    )
    return result.status === 'completed' ? 0 : 2
  } catch (error) {
    const failure = {
      status: 'incomplete',
      reason: 'host_error',
      error: error instanceof Error ? error.message : String(error),
    }
    await record({ event: 'terminal', ...failure })
    await writeFile(
      resolve(config.out, 'run.json'),
      safeJson({
        ...manifest,
        ...failure,
        finished_at: new Date().toISOString(),
      }),
    )
    return 2
  } finally {
    process.off('SIGINT', cancel)
    process.off('SIGTERM', cancel)
    await host?.close()
  }
}

try {
  process.exitCode = await main()
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({ event: 'error', message: redact(error instanceof Error ? error.message : String(error), process.env.LMFG_AGENT_API_KEY ?? '') })}\n`,
  )
  process.exitCode = 2
}
