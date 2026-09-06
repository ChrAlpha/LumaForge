import { Buffer } from 'node:buffer'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const bin = resolve(import.meta.dirname, '../dist/evaluation-cli.js')
if (!existsSync(bin))
  throw new Error('Build lmfg-agent before its CLI subprocess tests.')
const KEY = 'local-test-credential-marker'
const PROMPT = 'Runtime API key (hidden): '
const WHITE =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkMEQ8SEhEPERETFhwXExQaFRERGCEYGh0dHx8fExciJCIeJBweHx7/2wBDAQUFBQcGBw4ICA4eFBEUHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh7/wAARCAAIAAgDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/ALLAB//Z'
const DARK = WHITE.replace('ALLAB//Z', 'AJNAB//Z')
const digest = (image: string) =>
  createHash('sha256').update(Buffer.from(image, 'base64')).digest('hex')
const moduleUrl = (source: string) =>
  `data:text/javascript,${encodeURIComponent(source)}`
const preparationStub = moduleUrl(`
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
export async function prepareRunComparison(input) {
  if (existsSync(input.outDir)) throw new Error('CLI allocated output before the preparation guard.');
  const fixture = JSON.parse(await readFile(join(input.runDir, 'prepared.json'), 'utf8'));
  await mkdir(input.outDir);
  await input.record({event:'comparison_preparation_started',directory:input.outDir,run_directory:input.runDir});
  const state = JSON.parse(await readFile(join(input.outDir, 'comparison.json'), 'utf8'));
  if (state.status !== 'preparing') throw new Error('Missing preparation state.');
  if (fixture.failure) throw new Error(fixture.failure);
  const pair = {...fixture.pair, seed: input.seed ?? fixture.pair.seed};
  const pairPath = join(input.outDir, 'pair.json');
  await writeFile(pairPath, JSON.stringify(pair), {flag:'wx'});
  return {pairPath,pair,metadata:{schema:'lmfg.comparison-input.v1',full_resolution_export_revalidated:false,replay_revalidated:false}};
}`)

describe('evaluation CLI modes and output ownership', () => {
  let cwd: string
  const children = new Set<ChildProcessWithoutNullStreams>()
  const servers: Array<ReturnType<typeof createServer>> = []

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'lmfg-eval-cli-'))
  })
  afterEach(async () => {
    for (const child of children) child.kill()
    children.clear()
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolveClose) => {
            server.closeAllConnections()
            server.close(() => resolveClose())
          }),
      ),
    )
    await rm(cwd, { recursive: true, force: true })
  })

  function launch(
    args: string[],
    options: { stub?: boolean; terminal?: boolean } = {},
  ) {
    const preload = []
    if (options.terminal)
      preload.push(
        "Object.defineProperty(process.stdin, 'isTTY', {value:true}); process.stdin.setRawMode = () => process.stdin;",
      )
    if (options.stub) {
      const loader = moduleUrl(
        `export async function resolve(name, context, next) { if (name === './comparison-input.js' && context.parentURL?.endsWith('/evaluation-cli.js')) return {url:${JSON.stringify(preparationStub)},shortCircuit:true}; return next(name, context); }`,
      )
      preload.push(
        `import { register } from 'node:module'; register(${JSON.stringify(loader)}, import.meta.url);`,
      )
    }
    const child = spawn(
      process.execPath,
      [
        ...(preload.length ? ['--import', moduleUrl(preload.join('\n'))] : []),
        bin,
        ...args,
      ],
      {
        cwd: resolve(import.meta.dirname, '..'),
        env: {
          PATH: process.env.PATH ?? '',
          SYSTEMROOT: process.env.SYSTEMROOT ?? '',
          INIT_CWD: cwd,
          LMFG_AGENT_API_KEY: '',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    )
    children.add(child)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.stdin.on('error', () => {})
    const result = new Promise<{
      code: number | null
      stdout: string
      stderr: string
    }>((resolveResult, reject) => {
      child.once('error', reject)
      child.once('close', (code) => {
        children.delete(child)
        resolveResult({ code, stdout, stderr })
      })
    })
    const waitForPrompt = () =>
      new Promise<void>((resolvePrompt, reject) => {
        const cleanup = () => {
          clearTimeout(timeout)
          child.stderr.off('data', onData)
          child.off('close', onClose)
        }
        const onData = () => {
          if (stderr.includes(PROMPT)) {
            cleanup()
            resolvePrompt()
          }
        }
        const onClose = () => {
          cleanup()
          reject(new Error(`CLI exited before its key prompt: ${stderr}`))
        }
        const timeout = setTimeout(() => {
          cleanup()
          reject(new Error('CLI did not prompt for the key.'))
        }, 5000)
        child.stderr.on('data', onData)
        child.once('close', onClose)
        onData()
      })
    return { child, result, waitForPrompt }
  }

  async function inputs() {
    const dir = join(cwd, 'inputs')
    await mkdir(dir)
    await writeFile(join(dir, 'baseline.jpg'), Buffer.from(WHITE, 'base64'))
    await writeFile(join(dir, 'candidate.jpg'), Buffer.from(DARK, 'base64'))
    const pair = {
      brief: 'Keep the tones restrained.',
      baselinePath: 'baseline.jpg',
      candidatePath: 'candidate.jpg',
      seed: 'pair-seed',
      baseline_sha256: digest(WHITE),
      candidate_sha256: digest(DARK),
    }
    await writeFile(join(dir, 'pair.json'), JSON.stringify(pair))
    return {
      ...pair,
      baselinePath: join(dir, 'baseline.jpg'),
      candidatePath: join(dir, 'candidate.jpg'),
    }
  }

  async function judge() {
    const requests: Array<Record<string, unknown>> = []
    const server = createServer(async (request, response) => {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      const assessment = {
        intent: 'A restrained rendering.',
        color: 'Neutral tones.',
        tonal_hierarchy: 'Clear subject.',
        artifacts: 'No visible defect.',
        strengths: [],
        defects: [],
      }
      response.setHeader('Content-Type', 'application/json')
      response.end(
        JSON.stringify({
          id: `local-${requests.length}`,
          model: 'local-test',
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: `call-${requests.length}`,
                    type: 'function',
                    function: {
                      name: 'submit_comparison',
                      arguments: JSON.stringify({
                        winner: 'tie',
                        reason: 'Both treatments meet the brief.',
                        A: assessment,
                        B: assessment,
                      }),
                    },
                  },
                ],
              },
            },
          ],
        }),
      )
    })
    servers.push(server)
    await new Promise<void>((resolveListen) =>
      server.listen(0, '127.0.0.1', resolveListen),
    )
    const address = server.address()
    if (!address || typeof address === 'string')
      throw new Error('No loopback address.')
    return { requests, url: `http://127.0.0.1:${address.port}/v1` }
  }

  it.each([{ args: [] }, { args: ['--pair', 'pair.json', '--run', 'run'] }])(
    'rejects missing or ambiguous input mode %j without allocating output',
    async ({ args }) => {
      const process = launch([...args, '--out', 'result', '--key-stdin'])
      process.child.stdin.end()
      const result = await process.result
      expect(result.code).toBe(2)
      expect(result.stderr).toMatch(/exactly one.*--pair.*--run/i)
      expect(existsSync(join(cwd, 'result'))).toBe(false)
    },
  )

  it('documents both modes and preparation boundaries in help', async () => {
    const process = launch(['--help'])
    const result = await process.result
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('--run <completed run directory>')
    expect(result.stdout).toContain('--pair <pair.json>')
    expect(result.stdout).toContain('--seed')
    expect(result.stdout).toMatch(/before local run preparation/i)
  })

  it('prompts before invalid run preparation and redacts stdin keys in pre-allocation errors', async () => {
    const process = launch(
      ['--run', `missing-${KEY}`, '--out', 'result', '--key-stdin'],
      { terminal: true },
    )
    await process.waitForPrompt()
    expect(existsSync(join(cwd, 'result'))).toBe(false)
    process.child.stdin.end(`${KEY}\n`)
    const result = await process.result
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('[REDACTED]')
    expect(result.stdout + result.stderr).not.toContain(KEY)
    expect(existsSync(join(cwd, 'result'))).toBe(false)
  })

  it.each(['run/new/comparison', 'existing-result'])(
    'preserves original and existing directories when preparation rejects %s',
    async (out) => {
      await mkdir(join(cwd, 'run'))
      const run = JSON.stringify({
        schema: 'lmfg.agent.run.v1',
        status: 'incomplete',
      })
      await writeFile(join(cwd, 'run', 'run.json'), run)
      await mkdir(join(cwd, 'existing-result'))
      await writeFile(join(cwd, 'existing-result', 'keep'), 'untouched')
      const process = launch(['--run', 'run', '--out', out, '--key-stdin'])
      process.child.stdin.end(`${KEY}\n`)
      const result = await process.result
      expect(result.code).toBe(2)
      expect(await readFile(join(cwd, 'run', 'run.json'), 'utf8')).toBe(run)
      expect(await readdir(join(cwd, 'run'))).toEqual(['run.json'])
      expect(await readdir(join(cwd, 'existing-result'))).toEqual(['keep'])
      expect(result.stdout + result.stderr).not.toContain(KEY)
    },
  )

  it('preserves pair mode, resolves paths from the pair file, and allows a seed override', async () => {
    const pair = await inputs()
    const server = await judge()
    const process = launch([
      '--pair',
      'inputs/pair.json',
      '--out',
      'result',
      '--seed',
      'override-seed',
      '--base-url',
      server.url,
      '--key-stdin',
    ])
    process.child.stdin.end(`${KEY}\n`)
    const result = await process.result
    expect(result.code, result.stderr).toBe(0)
    expect(server.requests).toHaveLength(2)
    const stored = JSON.parse(
      await readFile(join(cwd, 'result', 'comparison.json'), 'utf8'),
    )
    expect(stored).toMatchObject({
      status: 'completed',
      winner: 'tie',
      seed: 'override-seed',
      pair: { ...pair, seed: 'override-seed' },
    })
    expect(
      await readFile(join(cwd, 'result', 'events.ndjson'), 'utf8'),
    ).not.toContain(KEY)
    expect(result.stdout + result.stderr).not.toContain(KEY)
  })

  it('passes run preparation pins and provenance through to the judge after directory ownership', async () => {
    const pair = await inputs()
    await mkdir(join(cwd, 'run'))
    await writeFile(join(cwd, 'run', 'prepared.json'), JSON.stringify({ pair }))
    const server = await judge()
    const process = launch(
      [
        '--run',
        'run',
        '--out',
        'result',
        '--seed',
        'run-seed',
        '--base-url',
        server.url,
        '--key-stdin',
      ],
      { stub: true, terminal: true },
    )
    await process.waitForPrompt()
    expect(existsSync(join(cwd, 'result'))).toBe(false)
    process.child.stdin.end(`${KEY}\n`)
    const result = await process.result
    expect(result.code, result.stderr).toBe(0)
    expect(server.requests).toHaveLength(2)
    const stored = JSON.parse(
      await readFile(join(cwd, 'result', 'comparison.json'), 'utf8'),
    )
    expect(stored).toMatchObject({
      status: 'completed',
      pair: { ...pair, seed: 'run-seed' },
      preparation: {
        full_resolution_export_revalidated: false,
        replay_revalidated: false,
      },
    })
    expect(
      await readFile(join(cwd, 'result', 'events.ndjson'), 'utf8'),
    ).toContain('comparison_preparation_started')
  })

  it.each(['preparation', 'pins'])(
    'records owned-output %s failures as inconclusive without leaking the stdin key',
    async (failure) => {
      const pair = await inputs()
      await mkdir(join(cwd, 'run'))
      await writeFile(
        join(cwd, 'run', 'prepared.json'),
        JSON.stringify(
          failure === 'preparation'
            ? { failure: `Preparation failed: ${KEY}` }
            : { pair: { ...pair, candidate_sha256: 'f'.repeat(64) } },
        ),
      )
      const server = await judge()
      const process = launch(
        [
          '--run',
          'run',
          '--out',
          'result',
          '--base-url',
          server.url,
          '--key-stdin',
        ],
        { stub: true },
      )
      process.child.stdin.end(`${KEY}\n`)
      const result = await process.result
      expect(result.code).toBe(2)
      expect(server.requests).toHaveLength(0)
      const stored = await readFile(
        join(cwd, 'result', 'comparison.json'),
        'utf8',
      )
      expect(JSON.parse(stored).status).toBe('inconclusive')
      const events = await readFile(
        join(cwd, 'result', 'events.ndjson'),
        'utf8',
      )
      expect(stored + events + result.stdout + result.stderr).not.toContain(KEY)
      expect(await readdir(join(cwd, 'run'))).toEqual(['prepared.json'])
    },
  )
})
