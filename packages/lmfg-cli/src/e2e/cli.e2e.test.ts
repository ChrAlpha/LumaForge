// @vitest-environment node
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, expect, it } from 'vitest'

import {
  createCliHarness,
  describeWithFixture,
  FIXTURE_PATH,
  identityCube,
} from './fixture'

let cwd: string
let cli: ReturnType<typeof createCliHarness>
let sessionId = ''

beforeAll(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'lmfg-e2e-'))
  cli = createCliHarness(cwd)
  await writeFile(
    join(cwd, 'display.cube'),
    identityCube([
      'LUMAFORGE_ROLE=display-look',
      'LUMAFORGE_INPUT_PROFILE=display-srgb',
    ]),
  )
  await writeFile(
    join(cwd, 'mystery.cube'),
    identityCube(['Sony S-Gamut3.Cine S-Log3 to Rec709']),
  )
  await writeFile(
    join(cwd, 'params.json'),
    JSON.stringify({ contrast: 20, lut: { path: 'display.cube' } }),
  )
  await writeFile(
    join(cwd, 'sweep.json'),
    JSON.stringify({
      base: { lut: { path: 'display.cube' } },
      axes: { exposure_ev: [-0.5, 0.5], temperature: [-20, 20] },
    }),
  )
})

afterAll(async () => {
  await rm(cwd, { recursive: true, force: true })
})

describeWithFixture('lmfg agent loop', () => {
  it('session init → inspect → status', async () => {
    const init = await cli.run('session', 'init', '--source', FIXTURE_PATH)
    expect(init.code, init.stdout).toBe(0)
    sessionId = init.envelope.result!.id as string
    expect(sessionId).toMatch(/^sess_/)

    const inspect = await cli.run('inspect', '--session', sessionId)
    expect(inspect.code, inspect.stdout).toBe(0)
    expect(
      (inspect.envelope.result!.metadata as { make: string }).make,
    ).toMatch(/apple/i)
    expect(
      existsSync(
        join(
          cwd,
          '.lmfg',
          'sessions',
          sessionId,
          'source',
          'embedded-preview.jpg',
        ),
      ),
    ).toBe(true)

    const status = await cli.run('session', 'status', '--session', sessionId)
    expect(status.code).toBe(0)
    expect(status.envelope.result).toMatchObject({
      status: 'inspected',
      decoded_dimensions: { width: 4032, height: 3024 },
    })
    const list = await cli.run('session', 'list')
    expect((list.envelope.result!.sessions as unknown[]).length).toBe(1)
  }, 60_000)

  it('lut inspect / contract infer / validate', async () => {
    const confirmed = await cli.run(
      'lut',
      'contract',
      'infer',
      '--lut',
      'display.cube',
    )
    expect(confirmed.code).toBe(0)
    expect(confirmed.envelope.result).toMatchObject({ complete: true })

    const mystery = await cli.run(
      'lut',
      'contract',
      'infer',
      '--lut',
      'mystery.cube',
    )
    expect(mystery.code).toBe(0)
    expect(mystery.envelope.result).toMatchObject({ complete: false })
    const suggested = (
      mystery.envelope.result!.suggested_contracts as unknown[]
    )[0]
    await writeFile(join(cwd, 'contract.json'), JSON.stringify(suggested))
    const validate = await cli.run(
      'lut',
      'contract',
      'validate',
      '--lut',
      'mystery.cube',
      '--contract',
      'contract.json',
    )
    expect(validate.code).toBe(0)
    expect(validate.envelope.result).toMatchObject({
      valid: true,
      export_supported: true,
    })
    const inspect = await cli.run('lut', 'inspect', 'display.cube')
    expect(inspect.envelope.result).toMatchObject({ valid: false })
  })

  it('render preview writes a verifiable manifest', async () => {
    const preview = await cli.run(
      'render',
      'preview',
      '--session',
      sessionId,
      '--params',
      'params.json',
      '--max-pixels',
      '400000',
    )
    expect(preview.code, preview.stdout).toBe(0)
    const result = preview.envelope.result!
    expect(result.decode).toBe('quick')
    const verify = await cli.run(
      'manifest',
      'verify',
      fileURLToPath(result.manifest_uri as string),
    )
    expect(verify.code, verify.stdout).toBe(0)
    expect(verify.envelope.result).toMatchObject({
      valid: true,
      kind: 'preview',
      environment_match: true,
    })
  }, 60_000)

  it('render sweep streams NDJSON and produces a contact sheet; compare and metrics work', async () => {
    const sweep = await cli.run(
      'render',
      'sweep',
      '--session',
      sessionId,
      '--plan',
      'sweep.json',
      '--contact-sheet',
      '--max-pixels',
      '300000',
      '--emit',
      'ndjson',
    )
    expect(sweep.code, sweep.stdout).toBe(0)
    expect(sweep.lines[0]).toMatchObject({
      event: 'started',
      schema: 'lmfg.event.v1',
    })
    expect(
      sweep.lines.filter((l) => l.event === 'candidate.ready'),
    ).toHaveLength(4)
    expect(sweep.envelope).toMatchObject({
      event: 'completed',
      ok: true,
      result_schema: 'lmfg.render.sweep.v1',
    })
    const result = sweep.envelope.result!
    expect(result.iteration_id).toBe('iter_0001')
    expect(result.contact_sheet).not.toBeNull()

    const sheet = await cli.run(
      'compare',
      'sheet',
      '--session',
      sessionId,
      '--iteration',
      'iter_0001',
      '--layout',
      '4x1',
    )
    expect(sheet.code, sheet.stdout).toBe(0)
    expect(sheet.envelope.result).toMatchObject({
      contact_sheet: { cols: 4, rows: 1 },
    })

    const metrics = await cli.run(
      'metrics',
      'compute',
      '--session',
      sessionId,
      '--iteration',
      'iter_0001',
      '--candidate',
      'cand_0001',
    )
    expect(metrics.code).toBe(0)
    expect(
      (metrics.envelope.result!.metrics as { schema: string }).schema,
    ).toBe('lmfg.metrics.v1')
  }, 120_000)

  it('render export chains the candidate manifest and refuses unsafe rewrites', async () => {
    const candidateManifest = JSON.parse(
      await readFile(
        join(
          cwd,
          '.lmfg',
          'sessions',
          sessionId,
          'iterations',
          'iter_0001',
          'candidates',
          'cand_0002',
          'manifest.json',
        ),
        'utf8',
      ),
    )
    const exported = await cli.run(
      'render',
      'export',
      '--session',
      sessionId,
      '--iteration',
      'iter_0001',
      '--candidate',
      'cand_0002',
    )
    expect(exported.code, exported.stdout).toBe(0)
    const result = exported.envelope.result!
    expect(result.parent_manifest_sha256).toBe(
      candidateManifest.manifest_sha256,
    )
    expect((result.output as { width: number }).width).toBe(4032)
    const verify = await cli.run(
      'manifest',
      'verify',
      fileURLToPath(result.manifest_uri as string),
    )
    expect(verify.code).toBe(0)
    const show = await cli.run(
      'manifest',
      'show',
      fileURLToPath(result.manifest_uri as string),
    )
    expect((show.envelope.result!.manifest as { kind: string }).kind).toBe(
      'export',
    )

    const again = await cli.run(
      'render',
      'export',
      '--session',
      sessionId,
      '--params',
      'params.json',
    )
    expect(again.code).toBe(2)
    expect(again.envelope.error).toMatchObject({ code: 'args.invalid' })

    const tampered = fileURLToPath(result.manifest_uri as string)
    const manifest = JSON.parse(await readFile(tampered, 'utf8'))
    manifest.render_params.exposure_ev = 3
    await writeFile(tampered, JSON.stringify(manifest))
    const broken = await cli.run('manifest', 'verify', tampered)
    expect(broken.code).toBe(1)
    expect(broken.envelope.error).toMatchObject({ code: 'manifest.invalid' })
  }, 120_000)

  it('fails closed with spec exit codes', async () => {
    const browser = await cli.run(
      'render',
      'preview',
      '--session',
      sessionId,
      '--tier',
      'browser',
    )
    expect(browser.code).toBe(3)
    expect(browser.envelope.error).toMatchObject({ code: 'tier.unavailable' })

    await writeFile(
      join(cwd, 'needs-contract.json'),
      JSON.stringify({ lut: { path: 'mystery.cube' } }),
    )
    const incomplete = await cli.run(
      'render',
      'preview',
      '--session',
      sessionId,
      '--params',
      'needs-contract.json',
    )
    expect(incomplete.code).toBe(4)
    expect(incomplete.envelope.error).toMatchObject({
      code: 'lut.contract.incomplete',
    })
    expect(
      (incomplete.envelope.error!.suggested_next_actions as string[])[0],
    ).toMatch(/lut contract infer/)

    const missing = await cli.run('session', 'init', '--source', 'nope.dng')
    expect(missing.code).toBe(2)

    const dry = await cli.run(
      'render',
      'export',
      '--session',
      sessionId,
      '--params',
      'params.json',
      '--output',
      'dry',
      '--dry-run',
    )
    expect(dry.code).toBe(0)
    expect(dry.envelope).toMatchObject({
      schema: 'lmfg.dry-run.v1',
      result: { dry_run: true, command: 'render.export' },
    })
    expect(
      existsSync(
        join(cwd, '.lmfg', 'sessions', sessionId, 'exports', 'dry.jpg'),
      ),
    ).toBe(false)

    const timeout = await cli.run(
      'render',
      'export',
      '--session',
      sessionId,
      '--params',
      'params.json',
      '--output',
      'slow',
      '--timeout',
      '1',
    )
    expect(timeout.code).toBe(9)
    expect(timeout.envelope.error).toMatchObject({ code: 'timeout' })
  }, 120_000)
})
