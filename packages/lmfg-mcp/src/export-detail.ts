import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, mkdir, open, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import {
  resolveWorkspaceRoot,
  toFileUri,
  workspacePaths,
} from '@lumaforge/lmfg-cli'
import type { RenderManifest } from '@lumaforge/render-engine'
import { canonicalizeJson } from '@lumaforge/render-engine'
import { checkRecordedExportGeometry } from '@lumaforge/render-engine/manifest'
import { z } from 'zod'

import {
  assertCanonical,
  loadSession,
  readCapturedFile,
  readSealedManifest,
} from './native-tool'

export const EXPORT_DETAIL_LIMITS = {
  max_source_bytes: 512 * 1024 * 1024,
  max_source_pixels: 120_000_000,
  max_region_pixels: 2_000_000,
  max_output_bytes: 8 * 1024 * 1024,
}
const identifier = z.string().regex(/^[a-z0-9][\w.-]{0,95}$/i)
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

const digest = (bytes: Buffer) =>
  createHash('sha256').update(bytes).digest('hex')

async function readExportManifest(path: string): Promise<RenderManifest> {
  const manifest = await readSealedManifest(path)
  if (manifest.kind !== 'export' || manifest.policy.kind !== 'export-full')
    throw new Error(
      'Export detail requires a full-resolution export manifest (kind export, policy export-full).',
    )
  return manifest
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
    if (!(await readCapturedFile(path, bytes.length)).equals(bytes))
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

/**
 * The full-resolution size the export must have delivered, checked from the
 * manifest before the JPEG is read: the decoded source frame, or under a
 * recorded geometry the frame the export itself plans from that source, which
 * the geometry's recorded output and the sealed output size must both state.
 */
function deliveredDimensions(manifest: RenderManifest): {
  width: number
  height: number
} {
  const check = checkRecordedExportGeometry(manifest)
  if (check.ok && check.frame) return check.frame.output
  if (check.ok || check.refusal.reason === 'non-export-geometry')
    throw new Error(
      'Export detail requires a full-resolution export manifest (kind export, policy export-full).',
    )
  switch (check.refusal.reason) {
    case 'unplannable-geometry':
      throw new Error(
        'Export geometry cannot be planned against its source frame.',
        { cause: check.refusal.cause },
      )
    case 'geometry-output-mismatch':
      throw new Error(
        'Export geometry output does not match the size the geometry plans from its source frame.',
      )
    case 'output-mismatch':
      throw new Error(
        'Export output dimensions do not match the size its source frame and geometry deliver.',
      )
  }
}

export async function createExportDetail(
  cwd: string,
  args: ExportDetailInput,
  loadDecoder: DecoderLoader = () => import('sharp'),
) {
  const input = ExportDetailInputSchema.parse(args)
  const root = resolveWorkspaceRoot(cwd, input.workspace)
  await assertCanonical(root)
  const session = await loadSession(root, input.session)
  const exportsDir = workspacePaths.exports(root, input.session)
  const manifest = await readExportManifest(
    workspacePaths.exportManifestFile(root, input.session, input.export_name),
  )
  if (
    manifest.source_raw.sha256 !== session.source.sha256 ||
    manifest.source_raw.byte_size !== session.source.byte_size ||
    manifest.output.filename !== `${input.export_name}.jpg`
  )
    throw new Error(
      'Export source identity or filename does not match the session and manifest.',
    )
  const full = deliveredDimensions(manifest)
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
  const jpegPath = workspacePaths.exportFile(
    root,
    input.session,
    input.export_name,
  )
  const jpeg = await readCapturedFile(
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
    input_jpeg_uri: toFileUri(jpegPath),
    full_dimensions: full,
    coordinate_space: 'oriented-export-pixels',
    region,
    width: info.width,
    height: info.height,
    mime_type: 'image/png',
    sha256: pngSha,
    byte_size: png.length,
    uri: toFileUri(pngPath),
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
      receipt_uri: toFileUri(receiptPath),
    },
  }
}
