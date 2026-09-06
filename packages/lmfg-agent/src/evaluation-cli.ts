#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { z } from 'zod'

import { readRuntimeApiKey } from './credentials.js'
import { evaluatePair } from './evaluation.js'
import { createProvider, redact } from './provider.js'

const help = `lmfg-agent evaluate --pair <pair.json> --out <new result directory> [--key-stdin]

pair.json: {"brief":"creative intent","baselinePath":"baseline.jpg","candidatePath":"candidate.jpg","seed":"fixed-seed"}
Optional baseline_sha256/candidate_sha256 pin the expected input bytes.
Paths in the pair are relative to pair.json. Images must share dimensions, JPEG
quantization and subsampling, without identifying metadata. Their filenames, editing
parameters and origins are withheld from two independent, reversed A/B judgments.

Credentials: LMFG_AGENT_API_KEY or --key-stdin (hidden on a terminal).
Options: --base-url (https://token.memoh.net/v1), --model (grok-4.6),
--timeout-ms (240000), --max-output-tokens (8192). Effort is high.
Exit 0: comparison completed (either image may win, tie or identical images).
Exit 2: inconclusive judgment or invalid invocation; inspect comparison.json/events.ndjson.
`

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      pair: { type: 'string' },
      out: { type: 'string' },
      'base-url': { type: 'string', default: 'https://token.memoh.net/v1' },
      model: { type: 'string', default: 'grok-4.6' },
      'timeout-ms': { type: 'string', default: '240000' },
      'max-output-tokens': { type: 'string', default: '8192' },
      'key-stdin': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  })
  if (values.help) {
    process.stdout.write(help)
    return 0
  }
  const text = z.string().trim().min(1)
  const invocationCwd = process.env.INIT_CWD ?? process.cwd()
  const pairPath = resolve(invocationCwd, text.parse(values.pair))
  const out = resolve(invocationCwd, text.parse(values.out))
  const sha256 = z.string().regex(/^[a-f0-9]{64}$/)
  const pair = z
    .object({
      brief: text,
      baselinePath: text,
      candidatePath: text,
      seed: text,
      baseline_sha256: sha256.optional(),
      candidate_sha256: sha256.optional(),
    })
    .parse(JSON.parse(await readFile(pairPath, 'utf8')))
  pair.baselinePath = resolve(dirname(pairPath), pair.baselinePath)
  pair.candidatePath = resolve(dirname(pairPath), pair.candidatePath)
  const config = {
    baseUrl: values['base-url'],
    model: values.model,
    reasoningEffort: 'high' as const,
    timeoutMs: z.coerce.number().int().positive().parse(values['timeout-ms']),
    maxOutputTokens: z.coerce
      .number()
      .int()
      .positive()
      .parse(values['max-output-tokens']),
  }
  const apiKey = await readRuntimeApiKey(values['key-stdin'])
  const complete = createProvider({ ...config, apiKey })
  await mkdir(dirname(out), { recursive: true })
  await mkdir(out)
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim()
  const safeJson = (value: unknown) => JSON.stringify(redact(value, apiKey))
  const record = async (event: Record<string, unknown>): Promise<void> => {
    await appendFile(
      resolve(out, 'events.ndjson'),
      `${safeJson({ at: new Date().toISOString(), ...event })}\n`,
    )
    process.stdout.write(
      `${safeJson({ event: event.event, round: event.round, status: event.status, winner: event.winner, receipt: event.receipt })}\n`,
    )
  }
  const metadata = {
    created_at: new Date().toISOString(),
    process_id: process.pid,
    revision,
    config,
    pair,
  }
  await writeFile(
    resolve(out, 'comparison.json'),
    safeJson({ ...metadata, status: 'running' }),
  )
  try {
    const result = await evaluatePair({
      ...pair,
      baselineSha256: pair.baseline_sha256,
      candidateSha256: pair.candidate_sha256,
      complete,
      record,
    })
    await writeFile(
      resolve(out, 'comparison.json'),
      safeJson({
        ...metadata,
        ...result,
        finished_at: new Date().toISOString(),
      }),
    )
    process.stdout.write(
      `${safeJson({ event: 'comparison_result', directory: out, status: result.status, winner: result.winner, usage: result.usage })}\n`,
    )
    return result.status === 'inconclusive' ? 2 : 0
  } catch (error) {
    const result = {
      status: 'inconclusive',
      error: error instanceof Error ? error.message : String(error),
    }
    await record({ event: 'comparison_error', ...result })
    await writeFile(
      resolve(out, 'comparison.json'),
      safeJson({
        ...metadata,
        ...result,
        finished_at: new Date().toISOString(),
      }),
    )
    return 2
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
