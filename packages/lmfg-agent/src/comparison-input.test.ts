import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'

import type { RenderManifest } from '@lumaforge/render-engine/manifest'
import { sealRenderManifest } from '@lumaforge/render-engine/manifest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { prepareRunComparison } from './comparison-input.js'
import { readComparisonImage } from './evaluation.js'
import { createHost } from './host.js'

const repoRoot = resolve(
  process.env.LMFG_COMPARISON_TEST_REPO_ROOT ??
    resolve(import.meta.dirname, '../../..'),
)
const fixture = join(
  repoRoot,
  'packages/luma-raw-runtime/fixtures/.cache/public/raw-pixls-iphone-se.dng',
)
if (process.env.LMFG_REQUIRE_FIXTURE === '1' && !existsSync(fixture))
  throw new Error(
    'The public DNG fixture is required for comparison input tests.',
  )

type CompletedRun = {
  schema: string
  status: string
  config: { source: string; brief: string }
  completion: Record<string, unknown>
}
const readJson = async <T>(path: string): Promise<T> =>
  JSON.parse(await readFile(path, 'utf8')) as T
const writeJson = async (path: string, value: unknown) =>
  writeFile(path, JSON.stringify(value))
const hash = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex')
const record = async () => {}

async function snapshot(root: string) {
  const entries = await readdir(root, { recursive: true })
  const files = await Promise.all(
    entries.sort().map(async (entry) => {
      const path = join(root, entry)
      return [
        entry,
        (await stat(path)).isFile() ? hash(await readFile(path)) : null,
      ]
    }),
  )
  return files
}

describe.skipIf(!existsSync(fixture))('completed run comparison inputs', () => {
  let directory: string
  let template: string
  let runDir: string
  let outDir: string
  let run: CompletedRun
  let candidatePath: string
  let manifestPath: string
  let candidate: RenderManifest

  beforeAll(async () => {
    directory = await realpath(
      await mkdtemp(join(tmpdir(), 'lmfg-comparison-')),
    )
    template = join(directory, 'template')
    const workspace = join(template, 'workspace')
    await mkdir(workspace, { recursive: true })
    const sourcePath = await realpath(fixture)
    const host = await createHost({
      repoRoot,
      sourcePath,
      workspace,
      lutPaths: [],
      toolTimeoutMs: 60000,
      record,
    })
    let step = 0
    const invoke = async (name: string, args: Record<string, unknown>) => {
      const result = await host.execute(name, args, ++step)
      expect(result.result.isError, JSON.stringify(result.result)).not.toBe(
        true,
      )
      return result
    }
    try {
      const initialized = await invoke('lmfg_session_init', {
        source: sourcePath,
      })
      const session = (
        initialized.result.structuredContent!.result as { id: string }
      ).id
      await invoke('lmfg_inspect', { session })
      await invoke('lmfg_render_candidate', {
        session,
        plan: { candidates: [{ id: 'warm', params: { temperature: 8 } }] },
        max_pixels: 200000,
        quality: 79,
        concurrency: 1,
        memory_profile: 'low-memory',
      })
      const selected = { session, iteration: 'iter_0001', candidate: 'warm' }
      await invoke('lmfg_image_read', {
        session,
        artifact: {
          kind: 'candidate',
          iteration_id: selected.iteration,
          candidate_id: selected.candidate,
        },
      })
      await invoke('lmfg_render_export', { ...selected, output: 'final' })
      const completed = await invoke('finish_edit', {
        ...selected,
        export_name: 'final',
        rationale: 'Keep a restrained warm treatment.',
        observations: 'The laptop is visible against the dark printer.',
      })
      expect(completed.completion?.verified).toBe(true)
      await writeJson(join(template, 'run.json'), {
        schema: 'lmfg.agent.run.v1',
        status: 'completed',
        config: {
          source: sourcePath,
          brief: 'Keep a restrained warm treatment.',
        },
        completion: completed.completion,
      })
    } finally {
      await host.close()
    }
  }, 120000)

  beforeEach(async () => {
    const testDir = await mkdtemp(join(directory, 'case-'))
    runDir = join(testDir, 'run')
    outDir = join(testDir, 'comparison')
    await cp(template, runDir, { recursive: true })
    run = await readJson<CompletedRun>(join(runDir, 'run.json'))
    const selected = run.completion
    const candidateDir = join(
      runDir,
      'workspace',
      'sessions',
      String(selected.session),
      'iterations',
      String(selected.iteration),
      'candidates',
      String(selected.candidate),
    )
    candidatePath = join(candidateDir, 'preview.jpg')
    manifestPath = join(candidateDir, 'manifest.json')
    candidate = await readJson<RenderManifest>(manifestPath)
  })

  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true })
  })

  const prepare = () =>
    prepareRunComparison({ repoRoot, runDir, outDir, record })

  it('prepares a matched default baseline and pins both images without changing the run', async () => {
    const before = await snapshot(runDir)
    const result = await prepare()
    expect(result.pair).toMatchObject({
      brief: run.config.brief,
      candidatePath,
      candidate_sha256: candidate.output.sha256,
      quality: 79,
      max_pixels: 200000,
      dimensions: candidate.output.dimensions,
    })
    expect(result.pair.seed).toBe(
      `lmfg-comparison-${candidate.manifest_sha256}`,
    )
    expect(await readJson(result.pairPath)).toEqual(result.pair)
    const [baseline, selected] = await Promise.all([
      readComparisonImage(result.pair.baselinePath),
      readComparisonImage(result.pair.candidatePath),
    ])
    expect(baseline.facts.sha256).toBe(result.pair.baseline_sha256)
    expect(baseline.facts.encoding_sha256).toBe(selected.facts.encoding_sha256)
    const baselineManifest = await readJson<RenderManifest>(
      result.pair.baselinePath.replace(/\.jpg$/, '.manifest.json'),
    )
    expect(baselineManifest.environment).toEqual(candidate.environment)
    expect(baselineManifest.environment.native_artifacts.variant).toBe(
      'low-memory',
    )
    expect(result.metadata).toMatchObject({
      source_sha256: run.completion.source_sha256,
      candidate_manifest_sha256: run.completion.candidate_manifest_sha256,
      full_resolution_export_revalidated: false,
      replay_revalidated: false,
    })
    expect(await snapshot(runDir)).toEqual(before)
  }, 60000)

  it('accepts an explicit seed for a frozen comparison', async () => {
    const result = await prepareRunComparison({
      repoRoot,
      runDir,
      outDir,
      record,
      seed: 'frozen-repeat',
    })
    expect(result.pair.seed).toBe('frozen-repeat')
  }, 60000)

  it.each(['status', 'verified'])('rejects incomplete %s', async (field) => {
    if (field === 'status') run.status = 'incomplete'
    else run.completion.verified = false
    await writeJson(join(runDir, 'run.json'), run)
    await expect(prepare()).rejects.toThrow()
    expect(existsSync(outDir)).toBe(false)
  })

  it.each(['session', 'iteration', 'candidate'])(
    'rejects unsafe %s selectors',
    async (field) => {
      run.completion[field] = '../outside'
      await writeJson(join(runDir, 'run.json'), run)
      await expect(prepare()).rejects.toThrow()
      expect(existsSync(outDir)).toBe(false)
    },
  )

  it('rejects an oversized run before parsing it', async () => {
    await writeFile(join(runDir, 'run.json'), ' '.repeat(1024 * 1024 + 1))
    await expect(prepare()).rejects.toThrow(/bounded|size|limit/i)
  })

  it('rejects unsealed candidate changes', async () => {
    await writeJson(manifestPath, {
      ...candidate,
      policy: { ...candidate.policy, max_pixels: 1 },
    })
    await expect(prepare()).rejects.toThrow(/manifest|seal|hash/i)
  })

  it('rejects a valid seal that no longer matches completion', async () => {
    await writeJson(
      manifestPath,
      sealRenderManifest({
        ...candidate,
        policy: { ...candidate.policy, max_pixels: 1 },
      }),
    )
    await expect(prepare()).rejects.toThrow(/completion|manifest/i)
  })

  it('rejects modified candidate JPEG bytes', async () => {
    const bytes = await readFile(candidatePath)
    bytes[bytes.length - 3] ^= 1
    await writeFile(candidatePath, bytes)
    await expect(prepare()).rejects.toThrow(/hash|SHA|candidate/i)
  })

  it('rejects a candidate artifact symlink', async () => {
    await rm(candidatePath)
    await symlink(
      join(template, candidatePath.slice(runDir.length + 1)),
      candidatePath,
    )
    await expect(prepare()).rejects.toThrow(/symlink|canonical/i)
  })

  it('rejects a changed actual source before baseline decoding', async () => {
    const bytes = await readFile(fixture)
    bytes[bytes.length - 1] ^= 1
    const changedSource = join(directory, 'changed.dng')
    await writeFile(changedSource, bytes)
    run.config.source = changedSource
    await writeJson(join(runDir, 'run.json'), run)
    const sessionPath = join(
      runDir,
      'workspace',
      'sessions',
      String(run.completion.session),
      'session.json',
    )
    const session = await readJson<{ source: { path: string } }>(sessionPath)
    session.source.path = changedSource
    await writeJson(sessionPath, session)
    await expect(prepare()).rejects.toThrow(/source/i)
  }, 60000)

  it('rejects output paths inside the original run', async () => {
    outDir = join(runDir, 'new', 'comparison')
    const before = await snapshot(runDir)
    await expect(prepare()).rejects.toThrow(/original|run|outside/i)
    expect(await snapshot(runDir)).toEqual(before)
  })

  it('does not overwrite an existing output directory', async () => {
    await mkdir(outDir)
    await writeFile(join(outDir, 'keep'), 'unchanged')
    await expect(prepare()).rejects.toThrow()
    expect(await readFile(join(outDir, 'keep'), 'utf8')).toBe('unchanged')
  })

  it('refuses a changed runtime environment despite a valid pinned seal', async () => {
    const altered = sealRenderManifest({
      ...candidate,
      environment: {
        ...candidate.environment,
        luma_raw_runtime: 'different-runtime',
      },
    })
    await writeJson(manifestPath, altered)
    run.completion.candidate_manifest_sha256 = altered.manifest_sha256
    await writeJson(join(runDir, 'run.json'), run)
    await expect(prepare()).rejects.toThrow(/runtime environment/i)
    expect(existsSync(join(outDir, 'pair.json'))).toBe(false)
  }, 60000)

  it('rejects output aliases that resolve inside the original run', async () => {
    const alias = join(directory, 'run-alias')
    await symlink(runDir, alias, 'junction')
    outDir = join(alias, 'nested', 'comparison')
    const before = await snapshot(runDir)
    await expect(prepare()).rejects.toThrow(/original|outside/i)
    expect(await snapshot(runDir)).toEqual(before)
  })

  it.each(['max_pixels', 'quality'])(
    'rejects unmatched baseline %s conditions',
    async (field) => {
      const altered = sealRenderManifest({
        ...candidate,
        ...(field === 'quality'
          ? { output: { ...candidate.output, quality: 70 } }
          : { policy: { ...candidate.policy, max_pixels: 400000 } }),
      })
      await writeJson(manifestPath, altered)
      run.completion.candidate_manifest_sha256 = altered.manifest_sha256
      await writeJson(join(runDir, 'run.json'), run)
      await expect(prepare()).rejects.toThrow(
        /dimensions|encoding|sampling|quantization/i,
      )
      expect(existsSync(join(outDir, 'pair.json'))).toBe(false)
    },
    60000,
  )
})
