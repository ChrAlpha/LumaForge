// @vitest-environment node
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import type { Server } from 'node:http'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { sealRenderManifest } from '@lumaforge/render-engine/manifest'
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
let server: Server
let serverBase = ''
const DISPLAY_CUBE = identityCube([
  'LUMAFORGE_ROLE=display-look',
  'LUMAFORGE_INPUT_PROFILE=display-srgb',
])
const DISPLAY_CUBE_SHA = createHash('sha256').update(DISPLAY_CUBE).digest('hex')

beforeAll(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'lmfg-e2e-'))
  cli = createCliHarness(cwd)
  await writeFile(join(cwd, 'display.cube'), DISPLAY_CUBE)
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
  server = createServer((request, response) => {
    if (request.url === '/display.cube') {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end(DISPLAY_CUBE)
      return
    }
    response.writeHead(404)
    response.end()
  })
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  )
  const address = server.address()
  serverBase =
    typeof address === 'object' && address
      ? `http://127.0.0.1:${address.port}`
      : ''
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
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

  it('lut fetch is gated, verified, and cached', async () => {
    const url = `${serverBase}/display.cube`
    const denied = await cli.run(
      'lut',
      'fetch',
      '--url',
      url,
      '--sha256',
      DISPLAY_CUBE_SHA,
    )
    expect(denied.code).toBe(5)
    expect(denied.envelope.error).toMatchObject({ code: 'network.not_allowed' })

    const fetched = await cli.run(
      'lut',
      'fetch',
      '--url',
      url,
      '--sha256',
      DISPLAY_CUBE_SHA,
      '--allow-network',
    )
    expect(fetched.code, fetched.stdout).toBe(0)
    const cachedPath = join(cwd, '.lmfg', 'luts', `${DISPLAY_CUBE_SHA}.cube`)
    expect(fetched.envelope.result).toMatchObject({
      path: cachedPath,
      cached: false,
      sha256: DISPLAY_CUBE_SHA,
    })
    expect(
      (fetched.envelope.result!.contract as { complete: boolean }).complete,
    ).toBe(true)

    const again = await cli.run(
      'lut',
      'fetch',
      '--url',
      url,
      '--sha256',
      DISPLAY_CUBE_SHA,
    )
    expect(again.code).toBe(0)
    expect(again.envelope.result).toMatchObject({ cached: true })

    const wrongSha = await cli.run(
      'lut',
      'fetch',
      '--url',
      url,
      '--sha256',
      'f'.repeat(64),
      '--allow-network',
    )
    expect(wrongSha.code).toBe(6)
    expect(wrongSha.envelope.error).toMatchObject({ code: 'hash.mismatch' })

    await writeFile(
      join(cwd, 'cached-params.json'),
      JSON.stringify({
        selective_color: { red: { hue: 15 } },
        lut: { path: cachedPath },
      }),
    )
    const preview = await cli.run(
      'render',
      'preview',
      '--session',
      sessionId,
      '--params',
      'cached-params.json',
      '--max-pixels',
      '300000',
    )
    expect(preview.code, preview.stdout).toBe(0)
    const manifest = JSON.parse(
      await readFile(
        fileURLToPath(preview.envelope.result!.manifest_uri as string),
        'utf8',
      ),
    )
    expect(manifest.render_params.selective_color.red).toEqual({
      hue: 15,
      saturation: 0,
      lightness: 0,
    })
    expect(manifest.policy.max_pixels).toBe(300000)
    expect(manifest.lut.sha256).toBe(DISPLAY_CUBE_SHA)
  }, 60_000)

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

  it('render sweep with worker threads is byte-identical to the serial run', async () => {
    await writeFile(
      join(cwd, 'parallel-sweep.json'),
      JSON.stringify({
        base: { lut: { path: 'display.cube' } },
        axes: { exposure_ev: [-0.4, 0, 0.4], contrast: [-15, 20] },
      }),
    )
    const serial = await cli.run(
      'render',
      'sweep',
      '--session',
      sessionId,
      '--plan',
      'parallel-sweep.json',
      '--concurrency',
      '1',
    )
    expect(serial.code, serial.stdout).toBe(0)
    const parallel = await cli.run(
      'render',
      'sweep',
      '--session',
      sessionId,
      '--plan',
      'parallel-sweep.json',
      '--concurrency',
      '3',
    )
    expect(parallel.code, parallel.stdout).toBe(0)
    const serialResult = serial.envelope.result as {
      concurrency: number
      candidates: Array<{
        index: number
        sha256: string
        manifest_sha256: string
        manifest_uri: string
      }>
    }
    const parallelResult = parallel.envelope.result as typeof serialResult
    expect(serialResult.concurrency).toBe(1)
    expect(parallelResult.concurrency).toBe(3)
    expect(parallelResult.candidates).toHaveLength(6)
    const byIndex = (list: typeof serialResult.candidates) =>
      [...list].sort((a, b) => a.index - b.index).map((c) => c.sha256)
    expect(byIndex(parallelResult.candidates)).toEqual(
      byIndex(serialResult.candidates),
    )
    const fingerprintsOf = async (list: typeof serialResult.candidates) =>
      Promise.all(
        [...list]
          .sort((a, b) => a.index - b.index)
          .map(async (candidate) => {
            const manifest = JSON.parse(
              await readFile(fileURLToPath(candidate.manifest_uri), 'utf8'),
            ) as {
              color_graph: { fingerprint: string }
              policy: { concurrency: number }
            }
            return manifest.color_graph.fingerprint
          }),
      )
    expect(await fingerprintsOf(parallelResult.candidates)).toEqual(
      await fingerprintsOf(serialResult.candidates),
    )
    const parallelManifest = JSON.parse(
      await readFile(
        fileURLToPath(parallelResult.candidates[0].manifest_uri),
        'utf8',
      ),
    ) as { policy: { concurrency: number } }
    expect(parallelManifest.policy.concurrency).toBe(3)

    const rejected = await cli.run(
      'render',
      'sweep',
      '--session',
      sessionId,
      '--plan',
      'parallel-sweep.json',
      '--concurrency',
      '0',
    )
    expect(rejected.code).toBe(2)
  }, 240_000)

  it('metrics compare and rank evaluate the sweep, and inline JSON options replace files', async () => {
    const sweep = await cli.run(
      'render',
      'sweep',
      '--session',
      sessionId,
      '--plan-json',
      JSON.stringify({
        base: { lut: { path: 'display.cube' } },
        axes: { exposure_ev: [-0.5, 0, 0.5] },
      }),
      '--concurrency',
      '2',
    )
    expect(sweep.code, sweep.stdout).toBe(0)
    const iterationId = (sweep.envelope.result as { iteration_id: string })
      .iteration_id
    const compared = await cli.run(
      'metrics',
      'compare',
      '--session',
      sessionId,
      '--iteration',
      iterationId,
      '--baseline',
      'cand_0002',
    )
    expect(compared.code, compared.stdout).toBe(0)
    const comparison = compared.envelope.result as {
      baseline_candidate_id: string
      candidates: Array<{
        candidate_id: string
        deltas: Record<
          string,
          { baseline: number; value: number; delta: number }
        >
      }>
    }
    expect(comparison.baseline_candidate_id).toBe('cand_0002')
    expect(comparison.candidates).toHaveLength(3)
    const baselineRow = comparison.candidates.find(
      (c) => c.candidate_id === 'cand_0002',
    )!
    expect(baselineRow.deltas['luma.mean'].delta).toBe(0)
    const darker = comparison.candidates.find(
      (c) => c.candidate_id === 'cand_0001',
    )!
    const brighter = comparison.candidates.find(
      (c) => c.candidate_id === 'cand_0003',
    )!
    expect(darker.deltas['luma.mean'].delta).toBeLessThan(0)
    expect(brighter.deltas['luma.mean'].delta).toBeGreaterThan(0)

    const ranked = await cli.run(
      'metrics',
      'rank',
      '--session',
      sessionId,
      '--iteration',
      iterationId,
      '--objective',
      JSON.stringify({
        'luma.mean': { target: baselineRow.deltas['luma.mean'].value },
      }),
    )
    expect(ranked.code, ranked.stdout).toBe(0)
    const ranking = (
      ranked.envelope.result as {
        ranking: Array<{ rank: number; candidate_id: string; score: number }>
      }
    ).ranking
    expect(ranking.map((entry) => entry.rank)).toEqual([1, 2, 3])
    expect(ranking[0]).toMatchObject({ candidate_id: 'cand_0002', score: 0 })
    expect(ranking[1].score).toBeGreaterThan(0)
    expect(ranking[2].score).toBeGreaterThanOrEqual(ranking[1].score)

    const badObjective = await cli.run(
      'metrics',
      'rank',
      '--session',
      sessionId,
      '--iteration',
      iterationId,
      '--objective',
      JSON.stringify({ 'luma.nope': { target: 1 } }),
    )
    expect(badObjective.code).toBe(2)

    const inlinePreview = await cli.run(
      'render',
      'preview',
      '--session',
      sessionId,
      '--params-json',
      JSON.stringify({ exposure_ev: 0.1, lut: { path: 'display.cube' } }),
    )
    expect(inlinePreview.code, inlinePreview.stdout).toBe(0)
    const both = await cli.run(
      'render',
      'preview',
      '--session',
      sessionId,
      '--params',
      'params.json',
      '--params-json',
      '{}',
    )
    expect(both.code).toBe(2)

    const validated = await cli.run(
      'lut',
      'contract',
      'validate',
      '--lut',
      'display.cube',
      '--contract-json',
      JSON.stringify({
        role: 'display-look',
        input_gamut: 'srgb-rec709',
        input_transfer: 'srgb',
        input_range: 'full',
      }),
    )
    expect(validated.code, validated.stdout).toBe(0)
  }, 240_000)

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
  }, 120_000)

  it('render replay reports reproduced: false when a valid manifest records different output bytes', async () => {
    const exportManifest = join(
      cwd,
      '.lmfg',
      'sessions',
      sessionId,
      'exports',
      'final.manifest.json',
    )
    const original = JSON.parse(await readFile(exportManifest, 'utf8'))
    const foreign = sealRenderManifest({
      ...original,
      output: { ...original.output, sha256: 'f'.repeat(64) },
    })
    const foreignPath = join(cwd, 'foreign.manifest.json')
    await writeFile(foreignPath, JSON.stringify(foreign))
    const verify = await cli.run('manifest', 'verify', foreignPath)
    expect(verify.code, verify.stdout).toBe(0)

    const replayed = await cli.run(
      'render',
      'replay',
      '--session',
      sessionId,
      '--manifest',
      foreignPath,
      '--name',
      'foreign',
    )
    expect(replayed.code).toBe(8)
    expect(replayed.envelope.error).toMatchObject({ code: 'replay.mismatch' })

    const traversal = await cli.run(
      'render',
      'replay',
      '--session',
      sessionId,
      '--manifest',
      exportManifest,
      '--name',
      '../escape',
    )
    expect(traversal.code).toBe(2)
    expect(traversal.envelope.error).toMatchObject({ code: 'args.invalid' })
  }, 240_000)

  it('render replay reproduces export and candidate manifests byte for byte', async () => {
    const exportManifest = join(
      cwd,
      '.lmfg',
      'sessions',
      sessionId,
      'exports',
      'final.manifest.json',
    )
    const replayed = await cli.run(
      'render',
      'replay',
      '--session',
      sessionId,
      '--manifest',
      exportManifest,
    )
    expect(replayed.code, replayed.stdout).toBe(0)
    expect(replayed.envelope.result).toMatchObject({
      kind: 'export',
      reproduced: true,
      fingerprint_match: true,
    })
    const original = JSON.parse(await readFile(exportManifest, 'utf8'))
    expect(replayed.envelope.result!.actual_sha256).toBe(original.output.sha256)
    expect(replayed.envelope.result!.parent_manifest_sha256).toBe(
      original.manifest_sha256,
    )
    const verify = await cli.run(
      'manifest',
      'verify',
      fileURLToPath(replayed.envelope.result!.manifest_uri as string),
    )
    expect(verify.code).toBe(0)

    const candidateManifest = join(
      cwd,
      '.lmfg',
      'sessions',
      sessionId,
      'iterations',
      'iter_0001',
      'candidates',
      'cand_0003',
      'manifest.json',
    )
    const candidate = await cli.run(
      'render',
      'replay',
      '--session',
      sessionId,
      '--manifest',
      candidateManifest,
      '--name',
      'cand3',
    )
    expect(candidate.code, candidate.stdout).toBe(0)
    expect(candidate.envelope.result).toMatchObject({
      kind: 'candidate',
      reproduced: true,
    })
    expect(
      existsSync(
        join(
          cwd,
          '.lmfg',
          'sessions',
          sessionId,
          'replays',
          'cand3',
          'output.jpg',
        ),
      ),
    ).toBe(true)

    const alteredSource = join(cwd, 'altered.dng')
    await copyFile(FIXTURE_PATH, alteredSource)
    const bytes = await readFile(alteredSource)
    await writeFile(alteredSource, Buffer.concat([bytes, Buffer.from([0])]))
    const mismatch = await cli.run(
      'render',
      'replay',
      '--manifest',
      exportManifest,
      '--source',
      alteredSource,
    )
    expect(mismatch.code).toBe(6)
    expect(mismatch.envelope.error).toMatchObject({ code: 'hash.mismatch' })
  }, 180_000)

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

    const tampered = join(
      cwd,
      '.lmfg',
      'sessions',
      sessionId,
      'exports',
      'final.manifest.json',
    )
    const manifest = JSON.parse(await readFile(tampered, 'utf8'))
    manifest.render_params.exposure_ev = 3
    await writeFile(tampered, JSON.stringify(manifest))
    const broken = await cli.run('manifest', 'verify', tampered)
    expect(broken.code).toBe(1)
    expect(broken.envelope.error).toMatchObject({ code: 'manifest.invalid' })
    const replayBroken = await cli.run(
      'render',
      'replay',
      '--session',
      sessionId,
      '--manifest',
      tampered,
    )
    expect(replayBroken.code).toBe(1)
  }, 180_000)
})
