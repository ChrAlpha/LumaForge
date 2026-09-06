#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { z } from 'zod'

import type { PreparedRunComparison } from './comparison-input.js'
import { prepareRunComparison } from './comparison-input.js'
import { readRuntimeApiKey } from './credentials.js'
import { evaluatePair } from './evaluation.js'
import { createProvider, redact } from './provider.js'

const help = `pnpm agent:evaluate --run <completed run directory> --out <new result directory> [--key-stdin]
pnpm agent:evaluate --pair <pair.json> --out <new result directory> [--key-stdin]

Build first from the repository root: pnpm agent:build.

Choose exactly one of --run and --pair. --run verifies the selected candidate and
prepares a default baseline with matching source, runtime, memory variant, pixel
budget, JPEG quality, dimensions and encoding. The new --out directory must be
outside the original run. The original run is never modified.
The key prompt comes before local run preparation. Preparation does not reverify
the full-resolution export or replay; judgment concerns the supplied image size.

pair.json: {"brief":"creative intent","baselinePath":"baseline.jpg","candidatePath":"candidate.jpg","seed":"fixed-seed"}
Optional baseline_sha256/candidate_sha256 pin the expected input bytes.
Paths in the pair are relative to pair.json. Images must share dimensions, JPEG
quantization and subsampling, without identifying metadata. Their filenames, editing
parameters and origins are withheld from two independent, reversed A/B judgments.

Credentials: LMFG_AGENT_API_KEY or --key-stdin (hidden on a terminal).
Options: --seed overrides the comparison seed (otherwise preserved from pair.json
or derived from the selected candidate manifest). --base-url (https://token.memoh.net/v1), --model (grok-4.6),
--timeout-ms (240000), --max-output-tokens (8192). Effort is high.
Exit 0: comparison completed (either image may win, tie or identical images).
Exit 2: inconclusive judgment, preparation failure or invalid invocation.
Once the new output directory is created, inspect comparison.json/events.ndjson;
--run also writes pair.json and preparation.json. Validation failures before
directory allocation do not create or overwrite comparison records.
`

let runtimeApiKey = ''

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      pair: { type: 'string' },
      run: { type: 'string' },
      out: { type: 'string' },
      seed: { type: 'string' },
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
  if ((values.pair === undefined) === (values.run === undefined))
    throw new Error('Specify exactly one of --pair or --run.')
  const invocationCwd = process.env.INIT_CWD ?? process.cwd()
  const pairPath =
    values.pair === undefined
      ? undefined
      : resolve(invocationCwd, text.parse(values.pair))
  const runDir =
    values.run === undefined
      ? undefined
      : resolve(invocationCwd, text.parse(values.run))
  const out = resolve(invocationCwd, text.parse(values.out))
  const seed = z.string().trim().min(1).max(256).optional().parse(values.seed)
  const sha256 = z.string().regex(/^[a-f0-9]{64}$/)
  const pairSchema = z.object({
    brief: text,
    baselinePath: text,
    candidatePath: text,
    seed: text,
    baseline_sha256: sha256.optional(),
    candidate_sha256: sha256.optional(),
  })
  let pair: z.infer<typeof pairSchema> | undefined
  if (pairPath) {
    pair = pairSchema.parse(JSON.parse(await readFile(pairPath, 'utf8')))
    pair.baselinePath = resolve(dirname(pairPath), pair.baselinePath)
    pair.candidatePath = resolve(dirname(pairPath), pair.candidatePath)
    pair.seed = seed ?? pair.seed
  }
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
  runtimeApiKey = apiKey
  const complete = createProvider({ ...config, apiKey })
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim()
  const safeJson = (value: unknown) => JSON.stringify(redact(value, apiKey))
  let ownedOut: string | undefined
  let preparation: PreparedRunComparison['metadata'] | undefined
  const createdAt = new Date().toISOString()
  const metadata = () => ({
    created_at: createdAt,
    process_id: process.pid,
    revision,
    config,
    ...(runDir ? { run_directory: runDir } : {}),
    ...(pair ? { pair } : {}),
    ...(preparation ? { preparation } : {}),
  })
  const writeState = async (state: Record<string, unknown>) => {
    if (!ownedOut)
      throw new Error('Comparison output directory has not been allocated.')
    await writeFile(
      resolve(ownedOut, 'comparison.json'),
      safeJson({ ...metadata(), ...state }),
    )
  }
  const record = async (event: Record<string, unknown>): Promise<void> => {
    if (event.event === 'comparison_preparation_started') {
      ownedOut = z.string().min(1).parse(event.directory)
      await writeState({ status: 'preparing' })
    }
    if (!ownedOut)
      throw new Error('Comparison output directory has not been allocated.')
    await appendFile(
      resolve(ownedOut, 'events.ndjson'),
      `${safeJson({ at: new Date().toISOString(), ...event })}\n`,
    )
    process.stdout.write(
      `${safeJson({ event: event.event, round: event.round, status: event.status, winner: event.winner, receipt: event.receipt })}\n`,
    )
  }
  try {
    if (runDir) {
      const prepared = await prepareRunComparison({
        repoRoot,
        runDir,
        outDir: out,
        record,
        seed,
      })
      pair = prepared.pair
      preparation = prepared.metadata
    } else {
      await mkdir(dirname(out), { recursive: true })
      await mkdir(out)
      ownedOut = out
    }
    if (!pair) throw new Error('Comparison inputs were not prepared.')
    await writeState({ status: 'running' })
    const result = await evaluatePair({
      ...pair,
      baselineSha256: pair.baseline_sha256,
      candidateSha256: pair.candidate_sha256,
      complete,
      record,
    })
    await writeState({ ...result, finished_at: new Date().toISOString() })
    process.stdout.write(
      `${safeJson({ event: 'comparison_result', directory: ownedOut, status: result.status, winner: result.winner, usage: result.usage })}\n`,
    )
    return result.status === 'inconclusive' ? 2 : 0
  } catch (error) {
    if (!ownedOut) throw error
    const result = {
      status: 'inconclusive',
      error: error instanceof Error ? error.message : String(error),
    }
    await record({ event: 'comparison_error', ...result })
    await writeState({ ...result, finished_at: new Date().toISOString() })
    return 2
  }
}

try {
  process.exitCode = await main()
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({ event: 'error', message: redact(error instanceof Error ? error.message : String(error), runtimeApiKey || process.env.LMFG_AGENT_API_KEY || '') })}\n`,
  )
  process.exitCode = 2
}
