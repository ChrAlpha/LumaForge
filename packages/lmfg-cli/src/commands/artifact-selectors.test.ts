// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  createCliHarness,
  describeWithFixture,
  FIXTURE_PATH,
} from '../e2e/fixture'
import { fileExists, writeJsonAtomic } from '../workspace/atomic-fs'
import { workspacePaths } from '../workspace/paths'

let cwd: string
let cli: ReturnType<typeof createCliHarness>
let session: string
let record: Record<string, unknown>
let iterationDir: string

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'lmfg-selectors-'))
  cli = createCliHarness(cwd)
  await writeFile(join(cwd, 'source.dng'), 'source identity bytes')
  const initialized = await cli.run('session', 'init', '--source', 'source.dng')
  expect(initialized.code, initialized.stdout).toBe(0)
  record = initialized.envelope.result!
  session = record.id as string
  iterationDir = workspacePaths.iteration(
    join(cwd, '.lmfg'),
    session,
    'iter_0001',
  )
  await writeJsonAtomic(join(iterationDir, 'plan.json'), {
    id: 'iter_0001',
    session_id: session,
    candidates: [{ id: 'cand_0001' }],
  })
  const candidateDir = join(iterationDir, 'candidates', 'cand_0001')
  await mkdir(candidateDir, { recursive: true })
  await writeFile(
    join(candidateDir, 'tile.rgba'),
    new Uint8Array([255, 0, 0, 255]),
  )
  await writeJsonAtomic(join(candidateDir, 'tile.json'), {
    width: 1,
    height: 1,
    byte_length: 4,
  })
})

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true })
})

async function expectInvalid(argv: string[]) {
  const result = await cli.run(...argv)
  expect(result.code, result.stdout).toBe(2)
  expect(result.envelope.error).toMatchObject({
    code: 'args.invalid',
    message: expect.stringMatching(/single portable path segment/),
  })
  return result
}

describe('artifact selectors at the CLI boundary', () => {
  it('refuses escaped session metadata even when a readable record exists there', async () => {
    await writeJsonAtomic(join(cwd, 'outside-session', 'session.json'), {
      ...record,
      source: {
        ...(record.source as object),
        filename: 'outside-record-marker',
      },
    })
    const result = await expectInvalid([
      'session',
      'status',
      '--session',
      '../../outside-session',
    ])
    expect(result.stdout).not.toContain('outside-record-marker')
  })

  it('refuses escaped iteration and candidate metrics that exist outside the workspace', async () => {
    await writeJsonAtomic(join(cwd, 'outside-iteration', 'plan.json'), {
      candidates: [{ id: 'cand_0001' }],
    })
    await writeJsonAtomic(
      join(cwd, 'outside-iteration', 'candidates', 'cand_0001', 'metrics.json'),
      { marker: 'outside-iteration-marker' },
    )
    await writeJsonAtomic(join(cwd, 'outside-candidate', 'metrics.json'), {
      marker: 'outside-candidate-marker',
    })
    for (const [iteration, candidate] of [
      ['../../../../outside-iteration', 'cand_0001'],
      ['iter_0001', '../../../../../../outside-candidate'],
    ]) {
      const result = await expectInvalid([
        'metrics',
        'compute',
        '--session',
        session,
        '--iteration',
        iteration,
        '--candidate',
        candidate,
      ])
      expect(result.stdout).not.toContain('-marker')
    }
  })

  it.each([
    '../../../../outside-export',
    '/outside-export',
    'C:\\outside',
    'NUL',
    'final.',
  ])('refuses export output %s during command planning', async (output) => {
    await expectInvalid([
      'render',
      'export',
      '--session',
      session,
      '--output',
      output,
      '--dry-run',
    ])
  })

  it('refuses an escaping sheet name and preserves the external file', async () => {
    const external = join(cwd, 'outside-sheet.jpg')
    await writeFile(external, 'outside-original')
    await expectInvalid([
      'compare',
      'sheet',
      '--session',
      session,
      '--iteration',
      'iter_0001',
      '--name',
      '../../../../../outside-sheet',
    ])
    expect(await readFile(external, 'utf8')).toBe('outside-original')
    expect(await fileExists(join(cwd, 'outside-sheet.map.json'))).toBe(false)
  })

  it('rejects selectors injected into stored iteration records', async () => {
    for (const changed of [
      { id: '../../../../outside', candidates: [{ id: 'cand_0001' }] },
      { id: 'iter_0001', candidates: [{ id: '../../../../../../outside' }] },
    ]) {
      await writeJsonAtomic(join(iterationDir, 'plan.json'), changed)
      await expectInvalid([
        'compare',
        'sheet',
        '--session',
        session,
        '--iteration',
        'iter_0001',
      ])
    }
  })

  it('keeps a dotted export basename and writes a valid named sheet inside the session', async () => {
    const planned = await cli.run(
      'render',
      'export',
      '--session',
      session,
      '--output',
      'final.jpg',
      '--dry-run',
    )
    expect(planned.code, planned.stdout).toBe(0)
    expect(planned.envelope.result!.plan).toMatchObject({
      output_path: join(
        cwd,
        '.lmfg',
        'sessions',
        session,
        'exports',
        'final.jpg.jpg',
      ),
    })
    const sheet = await cli.run(
      'compare',
      'sheet',
      '--session',
      session,
      '--iteration',
      'iter_0001',
      '--name',
      'Gallery final.jpg',
    )
    expect(sheet.code, sheet.stdout).toBe(0)
    expect(await fileExists(join(iterationDir, 'Gallery final.jpg.jpg'))).toBe(
      true,
    )
    expect(
      await fileExists(join(iterationDir, 'Gallery final.jpg.map.json')),
    ).toBe(true)
  })
})

describeWithFixture('export selector before native execution', () => {
  it('rejects the escaping output on an actual export without creating external artifacts', async () => {
    const initialized = await cli.run(
      'session',
      'init',
      '--source',
      FIXTURE_PATH,
    )
    expect(initialized.code, initialized.stdout).toBe(0)
    await expectInvalid([
      'render',
      'export',
      '--session',
      initialized.envelope.result!.id as string,
      '--output',
      '../../../../outside-export',
    ])
    expect(await fileExists(join(cwd, 'outside-export.jpg'))).toBe(false)
    expect(await fileExists(join(cwd, 'outside-export.manifest.json'))).toBe(
      false,
    )
  }, 120_000)
})
