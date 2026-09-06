import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  canonicalizeJson,
  verifyManifestSha256,
} from '@lumaforge/render-engine/manifest'
import { z } from 'zod'

import type { ModelTool } from './types.js'

const identifier = z.string().regex(/^[a-z0-9][\w-]{0,95}$/i)
const FinishSchema = z.strictObject({
  session: identifier,
  iteration: identifier,
  candidate: identifier,
  export_name: z.string().regex(/^[a-z0-9][\w.-]{0,63}$/i),
  rationale: z.string().trim().min(1).max(8000),
  observations: z.string().trim().min(1).max(8000),
})

export const finishTool: ModelTool = {
  type: 'function',
  function: {
    name: 'finish_edit',
    description:
      'Finish only after viewing the selected individual candidate in an earlier model step and exporting it at full resolution. Explain the visible result and artistic choice. The harness verifies image provenance, export integrity, and exact replay before accepting completion.',
    parameters: z.toJSONSchema(FinishSchema),
  },
}

type CompletionContext = {
  workspace: string
  sourcePath: string
  step: number
  images: Array<{ step: number; result: Record<string, unknown> }>
  replay: (
    manifestPath: string,
    session: string,
  ) => Promise<Record<string, unknown>>
}

const sha256 = z.string().regex(/^[a-f0-9]{64}$/)
const SizeSchema = z.object({
  width: z.int().positive(),
  height: z.int().positive(),
})
const ManifestSchema = z.object({
  manifest_version: z.literal(1),
  kind: z.enum(['candidate', 'export']),
  manifest_sha256: sha256,
  parent_manifest_sha256: sha256.nullable(),
  source_raw: z.object({
    sha256,
    byte_size: z.int().positive(),
    decoded_dimensions: SizeSchema,
  }),
  color_graph: z.object({
    fingerprint: sha256,
    descriptor: z.record(z.string(), z.unknown()),
  }),
  render_params: z
    .object({
      exposure_ev: z.number(),
      raw_render_exposure_ev: z.number(),
      raw_render_exposure_source: z.string().min(1),
    })
    .passthrough(),
  lut: z.record(z.string(), z.unknown()).nullable(),
  calibration: z.record(z.string(), z.unknown()).nullable(),
  policy: z.object({ kind: z.string() }),
  output: z.object({
    sha256,
    filename: z.string(),
    dimensions: SizeSchema,
    format: z.literal('jpeg'),
    color_space: z.literal('srgb'),
  }),
})

const digest = (bytes: Buffer | string) =>
  createHash('sha256').update(bytes).digest('hex')
const same = (a: unknown, b: unknown) =>
  canonicalizeJson(a) === canonicalizeJson(b)

async function readCanonical(path: string, limit: number): Promise<Buffer> {
  if ((await realpath(path)) !== path)
    throw new Error(
      'Workspace artifact paths must be canonical and contain no symlinks.',
    )
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  )
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > limit)
      throw new Error('Workspace artifact is not a bounded regular file.')
    const bytes = Buffer.alloc(stat.size + 1)
    let size = 0
    while (size < bytes.length) {
      const read = await handle.read(bytes, size, bytes.length - size, null)
      if (!read.bytesRead) break
      size += read.bytesRead
    }
    if (size !== stat.size)
      throw new Error('Workspace artifact changed while being read.')
    return bytes.subarray(0, size)
  } finally {
    await handle.close()
  }
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse((await readCanonical(path, 1024 * 1024)).toString('utf8'))
}

async function readManifest(path: string) {
  const raw = await readJson(path)
  if (!verifyManifestSha256(raw))
    throw new Error('Manifest hash does not match its complete content.')
  return ManifestSchema.parse(raw)
}

async function sourceIdentity(path: string) {
  const handle = await open(
    await realpath(path),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  )
  try {
    const before = await handle.stat()
    if (!before.isFile()) throw new Error('Source RAW is not a regular file.')
    const hash = createHash('sha256')
    let size = 0
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      size += chunk.length
      hash.update(chunk)
    }
    const after = await handle.stat()
    if (
      size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.size !== size
    ) {
      throw new Error('Source RAW changed during verification.')
    }
    return { sha256: hash.digest('hex'), byte_size: size }
  } finally {
    await handle.close()
  }
}

function jpegSize(bytes: Buffer): z.infer<typeof SizeSchema> {
  if (
    bytes.length < 4 ||
    bytes.readUInt16BE(0) !== 0xFFD8 ||
    bytes.readUInt16BE(bytes.length - 2) !== 0xFFD9
  ) {
    throw new Error('Output is not a complete JPEG.')
  }
  let offset = 2
  let size: z.infer<typeof SizeSchema> | null = null
  while (offset + 4 <= bytes.length) {
    if (bytes[offset++] !== 255) break
    while (bytes[offset] === 255) offset += 1
    const marker = bytes[offset++]
    if (marker === 217) break
    const length = bytes.readUInt16BE(offset)
    if (length < 2 || offset + length > bytes.length) break
    if ([192, 193, 194].includes(marker)) {
      if (length < 8 || size) break
      size = SizeSchema.parse({
        height: bytes.readUInt16BE(offset + 3),
        width: bytes.readUInt16BE(offset + 5),
      })
    }
    if (marker === 218) {
      const components = bytes[offset + 2]
      if (
        size &&
        components > 0 &&
        length === 6 + 2 * components &&
        offset + length < bytes.length - 2
      )
        return size
      break
    }
    offset += length
  }
  throw new Error('JPEG frame or scan is missing or malformed.')
}

export async function verifyCompletion(
  args: unknown,
  context: CompletionContext,
): Promise<Record<string, unknown>> {
  const selected = FinishSchema.parse(args)
  if (!Number.isInteger(context.step) || context.step < 1)
    throw new Error('Invalid model step.')
  const workspace = await realpath(context.workspace)
  const sessionDir = join(workspace, 'sessions', selected.session)
  const candidateDir = join(
    sessionDir,
    'iterations',
    selected.iteration,
    'candidates',
    selected.candidate,
  )
  const candidateManifestPath = join(candidateDir, 'manifest.json')
  const previewPath = join(candidateDir, 'preview.jpg')
  const exportManifestPath = join(
    sessionDir,
    'exports',
    `${selected.export_name}.manifest.json`,
  )
  const outputPath = join(sessionDir, 'exports', `${selected.export_name}.jpg`)
  const candidate = await readManifest(candidateManifestPath)
  const exported = await readManifest(exportManifestPath)
  if (
    candidate.kind !== 'candidate' ||
    exported.kind !== 'export' ||
    exported.policy.kind !== 'export-full'
  ) {
    throw new Error(
      'Completion requires a candidate and a full-resolution export manifest.',
    )
  }
  const source = await sourceIdentity(context.sourcePath)
  const session = z
    .object({
      schema: z.literal('lmfg.session.v1'),
      id: identifier,
      source: z.object({ sha256 }),
      decoded_dimensions: SizeSchema.nullable().optional(),
    })
    .parse(await readJson(join(sessionDir, 'session.json')))
  if (
    session.id !== selected.session ||
    session.source.sha256 !== source.sha256 ||
    candidate.source_raw.sha256 !== source.sha256 ||
    exported.source_raw.sha256 !== source.sha256 ||
    candidate.source_raw.byte_size !== source.byte_size ||
    exported.source_raw.byte_size !== source.byte_size
  ) {
    throw new Error(
      'Candidate, export, and session must match the actual input RAW source.',
    )
  }
  if (
    !same(
      candidate.source_raw.decoded_dimensions,
      exported.source_raw.decoded_dimensions,
    )
  ) {
    const size = (value: { width: number; height: number }) =>
      `${value.width}x${value.height}`
    throw new Error(
      `Candidate source dimensions ${size(candidate.source_raw.decoded_dimensions)} disagree with export source dimensions ${size(exported.source_raw.decoded_dimensions)}, although source bytes match. Run lmfg_inspect with this session, then render and view a fresh candidate and export it. The input RAW source dimensions must agree before completion.`,
    )
  }
  const observed = context.images.find(({ step, result }) => {
    const artifact = result.artifact as Record<string, unknown> | undefined
    return (
      Number.isInteger(step) &&
      step >= 1 &&
      step < context.step &&
      result.session_id === selected.session &&
      artifact?.kind === 'candidate' &&
      artifact.iteration_id === selected.iteration &&
      artifact.candidate_id === selected.candidate &&
      result.source_sha256 === source.sha256 &&
      result.manifest_sha256 === candidate.manifest_sha256 &&
      result.sha256 === candidate.output.sha256 &&
      result.uri === pathToFileURL(previewPath).href &&
      result.width === candidate.output.dimensions.width &&
      result.height === candidate.output.dimensions.height
    )
  })
  if (!observed)
    throw new Error(
      'The selected individual candidate must have been viewed in an earlier model step with matching image provenance.',
    )
  if (exported.parent_manifest_sha256 !== candidate.manifest_sha256)
    throw new Error(
      'Export parent does not match the selected candidate manifest.',
    )
  for (const field of [
    'color_graph',
    'render_params',
    'lut',
    'calibration',
  ] as const) {
    if (!same(candidate[field], exported[field]))
      throw new Error(`Export ${field} differs from the selected candidate.`)
  }
  if (
    digest(canonicalizeJson(candidate.color_graph.descriptor)) !==
    candidate.color_graph.fingerprint
  ) {
    throw new Error(
      'Candidate color graph fingerprint does not match its descriptor.',
    )
  }
  if (
    !same(exported.output.dimensions, exported.source_raw.decoded_dimensions) ||
    (session.decoded_dimensions &&
      !same(exported.output.dimensions, session.decoded_dimensions))
  ) {
    throw new Error('Export dimensions are not the full source resolution.')
  }
  const preview = await readCanonical(previewPath, 8 * 1024 * 1024)
  const output = await readCanonical(outputPath, 512 * 1024 * 1024)
  if (
    candidate.output.filename !== 'preview.jpg' ||
    digest(preview) !== candidate.output.sha256 ||
    !same(jpegSize(preview), candidate.output.dimensions) ||
    observed.result.byte_size !== preview.length
  ) {
    throw new Error(
      'Viewed candidate JPEG bytes no longer match the observed image.',
    )
  }
  const outputHash = digest(output)
  if (
    exported.output.filename !== `${selected.export_name}.jpg` ||
    outputHash !== exported.output.sha256 ||
    !same(jpegSize(output), exported.output.dimensions)
  ) {
    throw new Error(
      'Export JPEG output hash or dimensions do not match its manifest.',
    )
  }
  const replay = await context.replay(exportManifestPath, selected.session)
  const replayOutput = replay.output as Record<string, unknown> | undefined
  if (
    replay.reproduced !== true ||
    replay.fingerprint_match !== true ||
    replay.expected_sha256 !== outputHash ||
    replay.actual_sha256 !== outputHash ||
    replayOutput?.sha256 !== outputHash ||
    replayOutput.width !== exported.output.dimensions.width ||
    replayOutput.height !== exported.output.dimensions.height
  ) {
    throw new Error(
      'Export replay did not prove the same graph, JPEG bytes, and dimensions.',
    )
  }
  if (
    !same(await readManifest(candidateManifestPath), candidate) ||
    !same(await readManifest(exportManifestPath), exported) ||
    digest(await readCanonical(outputPath, 512 * 1024 * 1024)) !== outputHash
  ) {
    throw new Error('Completion artifacts changed during replay verification.')
  }
  return {
    verified: true,
    ...selected,
    observed_step: observed.step,
    source_sha256: source.sha256,
    candidate_manifest_sha256: candidate.manifest_sha256,
    export_manifest_sha256: exported.manifest_sha256,
    export_manifest_path: exportManifestPath,
    output_path: outputPath,
    output_sha256: outputHash,
    dimensions: exported.output.dimensions,
    replay,
  }
}
