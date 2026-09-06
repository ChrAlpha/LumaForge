import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  canonicalizeJson,
  verifyManifestSha256,
} from '@lumaforge/render-engine'
import { z } from 'zod'

export const EXPORT_DETAIL_LIMITS = {
  max_source_bytes: 512 * 1024 * 1024,
  max_source_pixels: 120_000_000,
  max_region_pixels: 2_000_000,
  max_output_bytes: 8 * 1024 * 1024,
}
const identifier = z.string().regex(/^[a-z0-9][\w.-]{0,95}$/i)
const sha256 = z.string().regex(/^[a-f0-9]{64}$/)
const dimensions = z.object({
  width: z.int().positive(),
  height: z.int().positive(),
})
const regionSchema = z
  .strictObject({
    x: z.int().nonnegative(),
    y: z.int().nonnegative(),
    width: z.int().positive(),
    height: z.int().positive(),
  })
  .refine(
    (region) =>
      region.width * region.height <= EXPORT_DETAIL_LIMITS.max_region_pixels,
    {
      message: `Detail region must contain at most ${EXPORT_DETAIL_LIMITS.max_region_pixels} pixels.`,
    },
  )

export const ExportDetailInputSchema = z.strictObject({
  session: identifier.describe('Session id from lmfg_session_init.'),
  workspace: z
    .string()
    .optional()
    .describe('Artifact root used by the export; default .lmfg.'),
  export_name: identifier.describe(
    'Export base name from lmfg_render_export, e.g. final.',
  ),
  region: regionSchema.describe(
    'Integer pixel rectangle in the full, already oriented export JPEG. No resize; inspect output dimensions first.',
  ),
})
export type ExportDetailInput = z.infer<typeof ExportDetailInputSchema>
type DecoderLoader = () => Promise<{ default: typeof import('sharp') }>

const SessionSchema = z.object({
  schema: z.literal('lmfg.session.v1'),
  id: identifier,
  source: z.object({ sha256, byte_size: z.int().positive() }),
})
const ManifestSchema = z.object({
  manifest_version: z.literal(1),
  kind: z.literal('export'),
  manifest_sha256: sha256,
  parent_manifest_sha256: sha256.nullable(),
  source_raw: z.object({
    sha256,
    byte_size: z.int().positive(),
    decoded_dimensions: dimensions,
  }),
  policy: z.object({ kind: z.literal('export-full') }),
  output: z.object({
    format: z.literal('jpeg'),
    color_space: z.literal('srgb'),
    filename: z.string(),
    sha256,
    dimensions,
  }),
})
const digest = (bytes: Buffer) =>
  createHash('sha256').update(bytes).digest('hex')

async function assertCanonical(path: string): Promise<void> {
  if ((await realpath(path)) !== path)
    throw new Error(
      'Export detail paths must be canonical and contain no symlinks.',
    )
}

async function readCaptured(path: string, limit: number): Promise<Buffer> {
  await assertCanonical(path)
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  )
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.size > limit)
      throw new Error(
        `Export detail input must be a regular file of at most ${limit} bytes.`,
      )
    const bytes = Buffer.alloc(before.size + 1)
    let length = 0
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, null)
      if (!read.bytesRead) break
      length += read.bytesRead
    }
    const after = await handle.stat()
    await assertCanonical(path)
    const current = await lstat(path)
    if (
      length !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      current.ino !== before.ino ||
      current.dev !== before.dev ||
      current.isSymbolicLink()
    )
      throw new Error('Export detail input changed while it was being read.')
    return bytes.subarray(0, length)
  } finally {
    await handle.close()
  }
}

async function readMetadata(path: string): Promise<unknown> {
  return JSON.parse((await readCaptured(path, 1024 * 1024)).toString('utf8'))
}

async function publish(path: string, bytes: Buffer): Promise<void> {
  await assertCanonical(dirname(path))
  const temporary = `${path}.${randomUUID()}.tmp`
  const handle = await open(
    temporary,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  )
  let completed = false
  try {
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await assertCanonical(dirname(path))
    try {
      await link(temporary, path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    if (!(await readCaptured(path, bytes.length)).equals(bytes))
      throw new Error(
        'Existing content-addressed export detail differs from its expected bytes.',
      )
    completed = true
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if (completed) throw error
    })
  }
}

export async function createExportDetail(
  cwd: string,
  args: ExportDetailInput,
  loadDecoder: DecoderLoader = () => import('sharp'),
) {
  const input = ExportDetailInputSchema.parse(args)
  const root = resolve(cwd, input.workspace ?? '.lmfg')
  await assertCanonical(root)
  const sessionDir = join(root, 'sessions', input.session)
  const session = SessionSchema.parse(
    await readMetadata(join(sessionDir, 'session.json')),
  )
  if (session.id !== input.session)
    throw new Error('Export detail session identity does not match.')
  const exportsDir = join(sessionDir, 'exports')
  const manifestPath = join(exportsDir, `${input.export_name}.manifest.json`)
  const raw = await readMetadata(manifestPath)
  if (!verifyManifestSha256(raw))
    throw new Error(
      'Export manifest canonical hash does not match its full content.',
    )
  const manifest = ManifestSchema.parse(raw)
  const full = manifest.output.dimensions
  if (
    manifest.source_raw.sha256 !== session.source.sha256 ||
    manifest.source_raw.byte_size !== session.source.byte_size ||
    manifest.output.filename !== `${input.export_name}.jpg` ||
    full.width !== manifest.source_raw.decoded_dimensions.width ||
    full.height !== manifest.source_raw.decoded_dimensions.height
  )
    throw new Error(
      'Export source identity, filename, or full-resolution dimensions do not match the session and manifest.',
    )
  if (full.width * full.height > EXPORT_DETAIL_LIMITS.max_source_pixels)
    throw new Error(
      `Export detail source exceeds ${EXPORT_DETAIL_LIMITS.max_source_pixels} pixels.`,
    )
  const { region } = input
  if (
    region.x > full.width - region.width ||
    region.y > full.height - region.height
  )
    throw new Error('Detail region is outside the full export JPEG bounds.')
  const jpegPath = join(exportsDir, manifest.output.filename)
  const jpeg = await readCaptured(
    jpegPath,
    EXPORT_DETAIL_LIMITS.max_source_bytes,
  )
  if (digest(jpeg) !== manifest.output.sha256)
    throw new Error('Export JPEG hash does not match its sealed manifest.')
  if (
    jpeg.length < 4 ||
    jpeg.readUInt16BE(0) !== 65496 ||
    jpeg.readUInt16BE(jpeg.length - 2) !== 65497
  )
    throw new Error('Export is not a complete JPEG.')
  let sharp: Awaited<ReturnType<DecoderLoader>>['default']
  try {
    sharp = (await loadDecoder()).default
  } catch {
    throw new Error(
      'Sharp JPEG decoder is unavailable. Install lmfg-mcp dependencies with pnpm install, including optional platform packages, then retry.',
    )
  }
  const decoder = sharp(jpeg, {
    limitInputPixels: EXPORT_DETAIL_LIMITS.max_source_pixels,
    sequentialRead: true,
    failOn: 'warning',
  })
  const metadata = await decoder.metadata()
  if (
    metadata.format !== 'jpeg' ||
    metadata.width !== full.width ||
    metadata.height !== full.height
  )
    throw new Error(
      'Actual JPEG dimensions or format do not match the export manifest.',
    )
  if (metadata.orientation !== undefined && metadata.orientation !== 1)
    throw new Error(
      'Export JPEG orientation must already be applied (EXIF Orientation 1).',
    )
  const { data: png, info } = await decoder
    .extract({
      left: region.x,
      top: region.y,
      width: region.width,
      height: region.height,
    })
    .png({ compressionLevel: 6, palette: false })
    .timeout({ seconds: 60 })
    .toBuffer({ resolveWithObject: true })
  if (info.width !== region.width || info.height !== region.height)
    throw new Error(
      'Decoded detail dimensions do not match the requested 1:1 region.',
    )
  if (png.length > EXPORT_DETAIL_LIMITS.max_output_bytes)
    throw new Error(
      `PNG detail exceeds ${EXPORT_DETAIL_LIMITS.max_output_bytes} bytes; choose a smaller region.`,
    )
  const detailsDir = join(exportsDir, 'details')
  await assertCanonical(exportsDir)
  await mkdir(detailsDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error
  })
  await assertCanonical(detailsDir)
  const pngSha = digest(png)
  const pngPath = join(detailsDir, `${pngSha}.png`)
  const receipt = {
    schema: 'lmfg.export.detail.receipt.v1',
    session_id: input.session,
    export_name: input.export_name,
    source_sha256: session.source.sha256,
    export_manifest_sha256: manifest.manifest_sha256,
    parent_candidate_manifest_sha256: manifest.parent_manifest_sha256,
    input_jpeg_sha256: manifest.output.sha256,
    input_jpeg_uri: pathToFileURL(jpegPath).href,
    full_dimensions: full,
    coordinate_space: 'oriented-export-pixels',
    region,
    width: info.width,
    height: info.height,
    mime_type: 'image/png',
    sha256: pngSha,
    byte_size: png.length,
    uri: pathToFileURL(pngPath).href,
    decoder: {
      name: 'sharp',
      version: sharp.versions.sharp,
      libvips: sharp.versions.vips,
      jpeg: sharp.versions.mozjpeg,
    },
    limits: EXPORT_DETAIL_LIMITS,
  }
  const receiptBytes = Buffer.from(canonicalizeJson(receipt))
  const receiptSha = digest(receiptBytes)
  const receiptPath = join(detailsDir, `${receiptSha}.json`)
  await publish(pngPath, png)
  await publish(receiptPath, receiptBytes)
  return {
    png,
    result: {
      ...receipt,
      receipt_sha256: receiptSha,
      receipt_uri: pathToFileURL(receiptPath).href,
    },
  }
}
