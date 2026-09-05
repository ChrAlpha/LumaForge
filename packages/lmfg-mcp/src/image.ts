import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { verifyManifestSha256 } from '@lumaforge/render-engine'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

export const IMAGE_LIMITS = {
  max_bytes: 8 * 1024 * 1024,
  max_pixels: 16_000_000,
}
const identifier = z.string().regex(/^[a-z0-9][\w-]{0,95}$/i)
const sha256 = z.string().regex(/^[a-f0-9]{64}$/)
const dimensions = { width: z.int().positive(), height: z.int().positive() }

export const ImageReadInputSchema = z.strictObject({
  session: identifier.describe('Session id from lmfg_session_init.'),
  workspace: z
    .string()
    .optional()
    .describe('Artifact root, as passed to the render tool; default .lmfg.'),
  artifact: z
    .discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('preview'), preview_id: identifier }),
      z.strictObject({
        kind: z.literal('candidate'),
        iteration_id: identifier,
        candidate_id: identifier,
      }),
      z.strictObject({
        kind: z.literal('contact-sheet'),
        iteration_id: identifier,
        name: identifier
          .optional()
          .describe(
            'Sheet base name; default contact-sheet. Use the name from lmfg_compare_sheet for a recomposed sheet.',
          ),
      }),
    ])
    .describe(
      'Select one session-produced image using identifiers from lmfg render results.',
    ),
})

type ImageReadInput = z.infer<typeof ImageReadInputSchema>

const SessionSchema = z.object({
  schema: z.literal('lmfg.session.v1'),
  id: identifier,
  source: z.object({ sha256 }),
})
const ManifestSchema = z.object({
  kind: z.enum(['preview', 'candidate']),
  manifest_sha256: sha256,
  source_raw: z.object({ sha256 }),
  output: z.object({
    sha256,
    filename: z.string(),
    dimensions: z.object(dimensions),
  }),
})
const PlanSchema = z.object({
  schema: z.literal('lmfg.iteration.v1'),
  id: identifier,
  session_id: identifier,
  candidates: z
    .array(z.object({ id: identifier, tag: z.string().nullable().optional() }))
    .min(1)
    .max(64),
})
const MapSchema = z.object({
  schema: z.literal('lmfg.contact-sheet-map.v1'),
  iteration_id: identifier,
  ...dimensions,
  cols: z.int().positive(),
  rows: z.int().positive(),
  tiles: z
    .array(
      z.object({
        candidate_id: identifier,
        index: z.int().nonnegative(),
        x: z.int().nonnegative(),
        y: z.int().nonnegative(),
        ...dimensions,
      }),
    )
    .min(1)
    .max(64),
})

async function readBounded(path: string, limit: number): Promise<Buffer> {
  if ((await realpath(path)) !== path)
    throw new Error('Artifact paths must not contain symlinks.')
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  )
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > limit)
      throw new Error(
        `Artifact must be a regular file of at most ${limit} bytes.`,
      )
    const buffer = Buffer.alloc(limit + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        length,
        buffer.length - length,
        null,
      )
      if (bytesRead === 0) break
      length += bytesRead
    }
    if (length > limit) throw new Error(`Artifact exceeds ${limit} bytes.`)
    return buffer.subarray(0, length)
  } finally {
    await handle.close()
  }
}

async function readMetadata(path: string): Promise<unknown> {
  return JSON.parse((await readBounded(path, 1024 * 1024)).toString('utf8'))
}

async function readManifest(path: string) {
  const raw = await readMetadata(path)
  if (!verifyManifestSha256(raw)) {
    throw new Error('Manifest canonical hash does not match its full content.')
  }
  return ManifestSchema.parse(raw)
}

function skipJpegScan(bytes: Buffer, start: number): number {
  let offset = start
  let hasData = false
  while (offset < bytes.length) {
    if (bytes[offset] !== 255) {
      hasData = true
      offset += 1
      continue
    }
    const markerStart = offset
    while (bytes[offset] === 255) offset += 1
    const marker = bytes[offset]
    if (marker === 0) {
      hasData = true
      offset += 1
    } else if (marker >= 208 && marker <= 215) {
      offset += 1
    } else {
      if (!hasData) throw new Error('JPEG scan has no encoded data.')
      return markerStart
    }
  }
  throw new Error('JPEG scan has no terminating marker.')
}

function jpegDimensions(bytes: Buffer): { width: number; height: number } {
  if (
    bytes.length < 4 ||
    bytes.readUInt16BE(0) !== 65496 ||
    bytes.readUInt16BE(bytes.length - 2) !== 65497
  )
    throw new Error('Artifact is not a complete JPEG.')
  let offset = 2
  let size: { width: number; height: number } | null = null
  let hasScan = false
  while (offset + 2 <= bytes.length) {
    if (bytes[offset++] !== 255) throw new Error('Invalid JPEG marker.')
    while (bytes[offset] === 255) offset += 1
    const marker = bytes[offset++]
    if (marker === 217) {
      if (!size || !hasScan || offset !== bytes.length) {
        throw new Error('JPEG frame or scan is missing or incomplete.')
      }
      return size
    }
    if (marker === 1 || (marker >= 208 && marker <= 215)) continue
    if (offset + 2 > bytes.length) break
    const length = bytes.readUInt16BE(offset)
    if (length < 2 || offset + length > bytes.length) break
    if (marker === 218) {
      const components = bytes[offset + 2]
      if (!size || !components || length !== 6 + 2 * components) {
        throw new Error('JPEG scan header is invalid.')
      }
      offset = skipJpegScan(bytes, offset + length)
      hasScan = true
      continue
    }
    if (
      [
        192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207,
      ].includes(marker)
    ) {
      if (length < 8 || size) break
      const height = bytes.readUInt16BE(offset + 3)
      const width = bytes.readUInt16BE(offset + 5)
      if (!width || !height || width * height > IMAGE_LIMITS.max_pixels)
        throw new Error(
          `Image exceeds ${IMAGE_LIMITS.max_pixels} pixels or has invalid dimensions. Render a smaller preview or contact sheet.`,
        )
      size = { width, height }
    }
    offset += length
  }
  throw new Error('JPEG frame or scan is missing or malformed.')
}

async function loadImage(cwd: string, input: ImageReadInput) {
  const root = await realpath(resolve(cwd, input.workspace ?? '.lmfg'))
  const dir = join(root, 'sessions', input.session)
  const session = SessionSchema.parse(
    await readMetadata(join(dir, 'session.json')),
  )
  if (session.id !== input.session)
    throw new Error(
      'Session record identity does not match the requested session.',
    )
  const { artifact } = input
  let path: string
  let manifest: z.infer<typeof ManifestSchema> | null = null
  let map: z.infer<typeof MapSchema> | null = null
  let tags = new Map<string, string | null>()
  if (artifact.kind === 'preview') {
    path = join(dir, 'previews', `${artifact.preview_id}.jpg`)
    manifest = await readManifest(
      join(dir, 'previews', `${artifact.preview_id}.manifest.json`),
    )
  } else {
    const iterationDir = join(dir, 'iterations', artifact.iteration_id)
    const plan = PlanSchema.parse(
      await readMetadata(join(iterationDir, 'plan.json')),
    )
    if (plan.id !== artifact.iteration_id || plan.session_id !== input.session)
      throw new Error(
        'Iteration record identity does not match the requested session and iteration.',
      )
    tags = new Map(
      plan.candidates.map((candidate) => [candidate.id, candidate.tag ?? null]),
    )
    if (artifact.kind === 'candidate') {
      if (!tags.has(artifact.candidate_id))
        throw new Error('Candidate is not registered in the iteration.')
      path = join(
        iterationDir,
        'candidates',
        artifact.candidate_id,
        'preview.jpg',
      )
      manifest = await readManifest(
        join(
          iterationDir,
          'candidates',
          artifact.candidate_id,
          'manifest.json',
        ),
      )
    } else {
      const name = artifact.name ?? 'contact-sheet'
      path = join(iterationDir, `${name}.jpg`)
      map = MapSchema.parse(
        await readMetadata(join(iterationDir, `${name}.map.json`)),
      )
      if (
        map.iteration_id !== artifact.iteration_id ||
        map.tiles.some((tile) => !tags.has(tile.candidate_id))
      )
        throw new Error(
          'Contact sheet contains unregistered iteration or candidate identities.',
        )
    }
  }
  const bytes = await readBounded(path, IMAGE_LIMITS.max_bytes)
  const size = jpegDimensions(bytes)
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (
    manifest &&
    (manifest.kind !== artifact.kind ||
      manifest.source_raw.sha256 !== session.source.sha256 ||
      manifest.output.sha256 !== digest ||
      manifest.output.filename !== basename(path) ||
      manifest.output.dimensions.width !== size.width ||
      manifest.output.dimensions.height !== size.height)
  )
    throw new Error(
      'Image content or provenance does not match its recorded manifest.',
    )
  if (
    map &&
    (map.width !== size.width ||
      map.height !== size.height ||
      map.tiles.some(
        (tile) =>
          tile.x + tile.width > size.width ||
          tile.y + tile.height > size.height,
      ))
  )
    throw new Error(
      'Contact sheet dimensions or tile bounds do not match its image.',
    )
  return {
    bytes,
    result: {
      session_id: input.session,
      artifact,
      source_sha256: session.source.sha256,
      label:
        artifact.kind === 'candidate'
          ? (tags.get(artifact.candidate_id) ?? artifact.candidate_id)
          : artifact.kind === 'preview'
            ? artifact.preview_id
            : (artifact.name ?? 'contact-sheet'),
      uri: pathToFileURL(path).href,
      mime_type: 'image/jpeg',
      ...size,
      byte_size: bytes.length,
      sha256: digest,
      manifest_sha256: manifest?.manifest_sha256 ?? null,
      tiles:
        map?.tiles.map((tile) => ({
          ...tile,
          tag: tags.get(tile.candidate_id) ?? null,
        })) ?? null,
      limits: IMAGE_LIMITS,
    },
  }
}

export async function readSessionImage(
  cwd: string,
  args: ImageReadInput,
): Promise<CallToolResult> {
  try {
    const { bytes, result } = await loadImage(
      cwd,
      ImageReadInputSchema.parse(args),
    )
    const structured = { schema: 'lmfg.image.read.v1', ok: true, result }
    return {
      content: [
        { type: 'text', text: JSON.stringify(structured) },
        {
          type: 'image',
          mimeType: 'image/jpeg',
          data: bytes.toString('base64'),
        },
      ],
      structuredContent: structured,
      isError: false,
    }
  } catch (error) {
    const structured = {
      schema: 'lmfg.error.v1',
      ok: false,
      error: {
        code: 'image.refused',
        message:
          error instanceof Error ? error.message : 'Image could not be read.',
      },
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(structured) }],
      structuredContent: structured,
      isError: true,
    }
  }
}

export function registerImageTool(server: McpServer, cwd: string): void {
  server.registerTool(
    'lmfg_image_read',
    {
      title: 'View a rendered image',
      description:
        'View pixels from one lmfg session preview, candidate, or contact sheet for subjective visual editing. Returns JPEG image content plus actual SHA-256, source identity, dimensions, label, and contact-sheet tile-to-candidate mapping. Call after rendering; metric scores do not judge aesthetic quality. Maximum 8 MiB and 16 megapixels; request smaller previews or sheet tiles when refused.',
      inputSchema: ImageReadInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    (args) => readSessionImage(cwd, args),
  )
}
