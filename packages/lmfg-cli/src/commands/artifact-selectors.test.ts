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
import { parseRenderParams } from '../schemas/params'
import { fileExists, writeJsonAtomic } from '../workspace/atomic-fs'
import { workspacePaths } from '../workspace/paths'

let cwd: string
let cli: ReturnType<typeof createCliHarness>
let session: string
let record: Record<string, unknown>
let iterationDir: string

function iterationPlan(id: string, candidateId: string) {
  const params = parseRenderParams({})
  return {
    schema: 'lmfg.iteration.v1',
    id,
    session_id: session,
    created_at: '2026-09-06T00:00:00.000Z',
    kind: 'candidate',
    base: params,
    candidates: [{ id: candidateId, tag: null, params }],
    options: { max_pixels: 2_500_000, quality: 85, contact_sheet: null },
  }
}

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
  await writeJsonAtomic(
    join(iterationDir, 'plan.json'),
    iterationPlan('iter_0001', 'cand_0001'),
  )
  const candidateDir = join(iterationDir, 'candidates', 'cand_0001')
  await mkdir(candidateDir, { recursive: true })
  await writeFile(
    join(candidateDir, 'tile.rgba'),
    new Uint8Array([255, 0, 0, 255]),
  )
  await writeJsonAtomic(join(candidateDir, 'tile.json'), {
    schema: 'lmfg.tile.v1',
    format: 'rgba8',
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
    for (const [changed, field] of [
      [iterationPlan('../../../../outside', 'cand_0001'), 'id'],
      [
        iterationPlan('iter_0001', '../../../../../../outside'),
        'candidates.0.id',
      ],
    ] as const) {
      await writeJsonAtomic(join(iterationDir, 'plan.json'), changed)
      const result = await cli.run(
        'compare',
        'sheet',
        '--session',
        session,
        '--iteration',
        'iter_0001',
      )
      expect(result.code, result.stdout).toBe(2)
      expect(result.envelope.error).toMatchObject({
        code: 'schema.invalid',
        message: expect.stringContaining(join(iterationDir, 'plan.json')),
        details: {
          record_path: join(iterationDir, 'plan.json'),
          issues: [
            {
              path: field,
              message: expect.stringMatching(/single portable path segment/),
            },
          ],
        },
      })
    }
  })

  it('fails session status on a corrupt plan, naming the plan file and field', async () => {
    const plan = join(iterationDir, 'plan.json')
    await writeJsonAtomic(plan, {
      ...iterationPlan('iter_0001', 'cand_0001'),
      kind: 'batch',
    })
    const result = await cli.run('session', 'status', '--session', session)
    expect(result.code, result.stdout).toBe(2)
    expect(result.envelope.result).toBeUndefined()
    expect(result.envelope.error).toMatchObject({
      code: 'schema.invalid',
      message: expect.stringContaining(plan),
      details: {
        record_path: plan,
        issues: [expect.objectContaining({ path: 'kind' })],
      },
    })
  })

  it('refuses malformed stored metrics and tiles before computing from them', async () => {
    const candidateDir = join(iterationDir, 'candidates', 'cand_0001')
    const compute = () =>
      cli.run(
        'metrics',
        'compute',
        '--session',
        session,
        '--iteration',
        'iter_0001',
        '--candidate',
        'cand_0001',
      )

    await writeJsonAtomic(join(candidateDir, 'metrics.json'), {
      schema: 'lmfg.metrics.v1',
      width: 1,
      height: 1,
    })
    const metrics = await compute()
    expect(metrics.code, metrics.stdout).toBe(2)
    expect(metrics.envelope.error).toMatchObject({
      code: 'schema.invalid',
      details: {
        record_path: join(candidateDir, 'metrics.json'),
        issues: expect.arrayContaining([
          expect.objectContaining({ path: 'luma' }),
        ]),
      },
    })

    await rm(join(candidateDir, 'metrics.json'))
    await writeFile(join(candidateDir, 'tile.rgba'), new Uint8Array(3))
    const tile = await compute()
    expect(tile.code, tile.stdout).toBe(2)
    expect(tile.envelope.error).toMatchObject({
      code: 'schema.invalid',
      details: {
        record_path: join(candidateDir, 'tile.rgba'),
        issues: [expect.objectContaining({ path: 'byte_length' })],
      },
    })
    expect(await fileExists(join(candidateDir, 'metrics.json'))).toBe(false)
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
