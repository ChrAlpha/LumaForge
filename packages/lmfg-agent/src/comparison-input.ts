import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, realpath, writeFile } from 'node:fs/promises'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path'

import {
  canonicalizeJson,
  verifyManifestSha256,
} from '@lumaforge/render-engine/manifest'
import { z } from 'zod'

import { readComparisonImage } from './evaluation.js'
import { createHost } from './host.js'

const identifier = z.string().regex(/^[a-z0-9][\w-]{0,95}$/i)
const sha256 = z.string().regex(/^[a-f0-9]{64}$/)
const dimensions = z.object({
  width: z.int().positive(),
  height: z.int().positive(),
})
const sourceIdentity = z.object({
  sha256,
  byte_size: z.int().positive(),
  decoded_dimensions: dimensions,
})
const environment = z
  .object({
    render_engine: z.string().min(1),
    luma_color_runtime: z.string().min(1),
    luma_raw_runtime: z.string().min(1),
    luma_jpeg_runtime: z.string().min(1),
    native_artifacts: z
      .object({
        build_id: z.string().min(1),
        variant: z.enum(['desktop', 'low-memory']),
      })
      .passthrough(),
  })
  .passthrough()
const runSchema = z.object({
  schema: z.literal('lmfg.agent.run.v1'),
  status: z.literal('completed'),
  config: z.object({
    source: z
      .string()
      .min(1)
      .refine(isAbsolute, 'Run source path must be absolute.'),
    brief: z.string().trim().min(1).max(16000),
  }),
  completion: z.object({
    verified: z.literal(true),
    session: identifier,
    iteration: identifier,
    candidate: identifier,
    source_sha256: sha256,
    candidate_manifest_sha256: sha256,
    dimensions,
  }),
})
const manifestSchema = z.object({
  manifest_version: z.literal(1),
  kind: z.enum(['preview', 'candidate']),
  manifest_sha256: sha256,
  source_raw: sourceIdentity,
  environment,
  policy: z.object({
    kind: z.string(),
    max_pixels: z.int().positive().max(12000000),
  }),
  output: z.object({
    sha256,
    filename: z.string().min(1),
    dimensions,
    format: z.literal('jpeg'),
    color_space: z.literal('srgb'),
    quality: z.int().min(1).max(100),
  }),
})
const same = (a: unknown, b: unknown) =>
  canonicalizeJson(a) === canonicalizeJson(b)
const digest = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex')

async function readBoundedJson(path: string) {
  if ((await realpath(path)) !== path)
    throw new Error('Run artifacts must have canonical paths without symlinks.')
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  )
  try {
    const before = await file.stat()
    if (!before.isFile() || before.size > 1024 * 1024)
      throw new Error(
        'Run metadata must be a bounded regular file of at most 1 MiB.',
      )
    const bytes = Buffer.alloc(before.size + 1)
    let size = 0
    while (size < bytes.length) {
      const { bytesRead } = await file.read(
        bytes,
        size,
        bytes.length - size,
        null,
      )
      if (!bytesRead) break
      size += bytesRead
    }
    const after = await file.stat()
    if (
      size !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw new Error('Run metadata changed while being read.')
    const content = bytes.subarray(0, size)
    return {
      value: JSON.parse(content.toString('utf8')) as unknown,
      sha256: digest(content),
    }
  } finally {
    await file.close()
  }
}

async function readManifest(path: string) {
  const raw = await readBoundedJson(path)
  if (!verifyManifestSha256(raw.value))
    throw new Error('Comparison manifest seal does not match its content.')
  return manifestSchema.parse(raw.value)
}

async function resolveDestination(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return join(await resolveDestination(dirname(path)), basename(path))
  }
}

export type PreparedRunComparison = {
  pairPath: string
  pair: {
    brief: string
    baselinePath: string
    candidatePath: string
    seed: string
    baseline_sha256: string
    candidate_sha256: string
    quality: number
    max_pixels: number
    dimensions: { width: number; height: number }
  }
  metadata: {
    schema: 'lmfg.comparison-input.v1'
    run_directory: string
    run_sha256: string
    source_sha256: string
    candidate_manifest_sha256: string
    baseline_manifest_sha256: string
    baseline_session: string
    full_resolution_export_revalidated: false
    replay_revalidated: false
  }
}

export async function prepareRunComparison(input: {
  repoRoot: string
  runDir: string
  outDir: string
  seed?: string
  record: (event: Record<string, unknown>) => Promise<void>
}): Promise<PreparedRunComparison> {
  const runDir = await realpath(resolve(input.runDir))
  const outDir = await resolveDestination(resolve(input.outDir))
  const relation = relative(runDir, outDir)
  if (
    relation === '' ||
    (!isAbsolute(relation) &&
      relation !== '..' &&
      !relation.startsWith(`..${sep}`))
  )
    throw new Error('Comparison output must be outside the original run.')
  const runFile = await readBoundedJson(join(runDir, 'run.json'))
  const run = runSchema.parse(runFile.value)
  const selected = run.completion
  const seed = z
    .string()
    .min(1)
    .max(256)
    .parse(
      input.seed ?? `lmfg-comparison-${selected.candidate_manifest_sha256}`,
    )
  const sessionDir = join(runDir, 'workspace', 'sessions', selected.session)
  const candidateDir = join(
    sessionDir,
    'iterations',
    selected.iteration,
    'candidates',
    selected.candidate,
  )
  const manifestPath = join(candidateDir, 'manifest.json')
  const candidatePath = join(candidateDir, 'preview.jpg')
  const candidate = await readManifest(manifestPath)
  if (
    candidate.kind !== 'candidate' ||
    candidate.policy.kind !== 'candidate' ||
    candidate.output.filename !== 'preview.jpg' ||
    candidate.manifest_sha256 !== selected.candidate_manifest_sha256
  )
    throw new Error(
      'Selected candidate manifest does not match the completed run.',
    )
  if (
    candidate.source_raw.sha256 !== selected.source_sha256 ||
    !same(candidate.source_raw.decoded_dimensions, selected.dimensions)
  )
    throw new Error('Candidate source identity differs from completion.')
  const originalSession = z
    .object({
      schema: z.literal('lmfg.session.v1'),
      id: identifier,
      source: z.object({
        path: z.string(),
        sha256,
        byte_size: z.int().positive(),
      }),
    })
    .parse((await readBoundedJson(join(sessionDir, 'session.json'))).value)
  const sourcePath = await realpath(run.config.source)
  if (
    originalSession.id !== selected.session ||
    originalSession.source.sha256 !== selected.source_sha256 ||
    originalSession.source.byte_size !== candidate.source_raw.byte_size ||
    (await realpath(originalSession.source.path)) !== sourcePath
  )
    throw new Error('Run source does not match the selected session.')
  const selectedImage = await readComparisonImage(candidatePath)
  if (
    selectedImage.facts.sha256 !== candidate.output.sha256 ||
    !same(
      { width: selectedImage.facts.width, height: selectedImage.facts.height },
      candidate.output.dimensions,
    )
  )
    throw new Error(
      'Candidate JPEG hash or dimensions differ from its sealed manifest.',
    )
  const memoryProfile = candidate.environment.native_artifacts.variant

  await mkdir(dirname(outDir), { recursive: true })
  await mkdir(outDir)
  await input.record({
    event: 'comparison_preparation_started',
    directory: outDir,
    run_directory: runDir,
  })
  const workspace = join(outDir, 'workspace')
  await mkdir(workspace)
  const host = await createHost({
    repoRoot: input.repoRoot,
    sourcePath,
    workspace,
    lutPaths: [],
    toolTimeoutMs: 180000,
    record: input.record,
  })
  let step = 0
  const invoke = async (name: string, args: Record<string, unknown>) => {
    const execution = await host.execute(name, args, ++step)
    const result = execution.result
    if (execution.terminal || result.isError)
      throw new Error(
        `Baseline ${name} failed: ${JSON.stringify(result.content)}`,
      )
    const envelope =
      result.structuredContent ??
      JSON.parse(
        result.content.find((part) => part.type === 'text')?.text ?? '{}',
      )
    if (envelope.ok === false) throw new Error(`Baseline ${name} failed.`)
    return envelope.result as unknown
  }
  try {
    const initialized = z
      .object({
        id: identifier,
        source: z.object({ sha256, byte_size: z.int().positive() }),
      })
      .parse(
        await invoke('lmfg_session_init', {
          source: sourcePath,
          memory_profile: memoryProfile,
        }),
      )
    if (
      initialized.source.sha256 !== selected.source_sha256 ||
      initialized.source.byte_size !== candidate.source_raw.byte_size
    )
      throw new Error('Actual source bytes differ from the completed run.')
    const inspected = z
      .object({ source: z.object({ sha256 }), decoded_dimensions: dimensions })
      .parse(
        await invoke('lmfg_inspect', {
          session: initialized.id,
          memory_profile: memoryProfile,
        }),
      )
    if (
      inspected.source.sha256 !== selected.source_sha256 ||
      !same(
        inspected.decoded_dimensions,
        candidate.source_raw.decoded_dimensions,
      )
    )
      throw new Error('Baseline source identity differs from the candidate.')
    const rendered = z.object({ preview_id: identifier }).parse(
      await invoke('lmfg_render_preview', {
        session: initialized.id,
        params: {},
        max_pixels: candidate.policy.max_pixels,
        quality: candidate.output.quality,
        memory_profile: memoryProfile,
      }),
    )
    const previewDir = join(workspace, 'sessions', initialized.id, 'previews')
    const baselinePath = join(previewDir, `${rendered.preview_id}.jpg`)
    const baselineManifest = await readManifest(
      join(previewDir, `${rendered.preview_id}.manifest.json`),
    )
    const baseline = await readComparisonImage(baselinePath)
    if (!same(baselineManifest.environment, candidate.environment))
      throw new Error(
        'Baseline runtime environment differs from the selected candidate.',
      )
    if (
      baselineManifest.kind !== 'preview' ||
      baselineManifest.output.filename !== `${rendered.preview_id}.jpg` ||
      !same(baselineManifest.source_raw, candidate.source_raw)
    )
      throw new Error(
        'Baseline manifest source identity differs from the candidate.',
      )
    if (
      baselineManifest.policy.max_pixels !== candidate.policy.max_pixels ||
      baselineManifest.output.quality !== candidate.output.quality ||
      baseline.facts.sha256 !== baselineManifest.output.sha256
    )
      throw new Error(
        'Baseline JPEG hash or rendering conditions do not match.',
      )
    const baselineDimensions = {
      width: baseline.facts.width,
      height: baseline.facts.height,
    }
    if (
      !same(baselineDimensions, candidate.output.dimensions) ||
      !same(baselineDimensions, baselineManifest.output.dimensions)
    )
      throw new Error('Baseline and candidate JPEG dimensions must match.')
    if (baseline.facts.encoding_sha256 !== selectedImage.facts.encoding_sha256)
      throw new Error(
        'Baseline and candidate JPEG quantization and sampling must match.',
      )
    if (
      (await readBoundedJson(join(runDir, 'run.json'))).sha256 !==
        runFile.sha256 ||
      (await readManifest(manifestPath)).manifest_sha256 !==
        candidate.manifest_sha256 ||
      (await readComparisonImage(candidatePath)).facts.sha256 !==
        selectedImage.facts.sha256
    )
      throw new Error(
        'Original run evidence changed during comparison preparation.',
      )
    const pair = {
      brief: run.config.brief,
      baselinePath,
      candidatePath,
      seed,
      baseline_sha256: baseline.facts.sha256,
      candidate_sha256: selectedImage.facts.sha256,
      quality: candidate.output.quality,
      max_pixels: candidate.policy.max_pixels,
      dimensions: baselineDimensions,
    }
    const metadata: PreparedRunComparison['metadata'] = {
      schema: 'lmfg.comparison-input.v1',
      run_directory: runDir,
      run_sha256: runFile.sha256,
      source_sha256: selected.source_sha256,
      candidate_manifest_sha256: candidate.manifest_sha256,
      baseline_manifest_sha256: baselineManifest.manifest_sha256,
      baseline_session: initialized.id,
      full_resolution_export_revalidated: false,
      replay_revalidated: false,
    }
    const pairPath = join(outDir, 'pair.json')
    await writeFile(
      join(outDir, 'preparation.json'),
      `${JSON.stringify(metadata, null, 2)}\n`,
      { flag: 'wx' },
    )
    await writeFile(pairPath, `${JSON.stringify(pair, null, 2)}\n`, {
      flag: 'wx',
    })
    await input.record({
      event: 'comparison_inputs_prepared',
      pair_path: pairPath,
      ...metadata,
    })
    return { pairPath, pair, metadata }
  } finally {
    await host.close()
  }
}
