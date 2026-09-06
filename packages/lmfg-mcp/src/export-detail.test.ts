import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { computeManifestSha256 } from '@lumaforge/render-engine'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createExportDetail,
  EXPORT_DETAIL_LIMITS,
  ExportDetailInputSchema,
} from './export-detail'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, open: vi.fn(actual.open) }
})

const hash = (bytes: Buffer | string) =>
  createHash('sha256').update(bytes).digest('hex')
const sourceSha = 'a'.repeat(64)
const parentSha = 'b'.repeat(64)
const full = { width: 128, height: 96 }
const seal = (manifest: Record<string, unknown>) => ({
  ...manifest,
  manifest_sha256: computeManifestSha256(manifest),
})

describe('verified export JPEG detail', () => {
  let cwd: string
  let sessionDir: string
  let jpegPath: string
  let manifestPath: string
  let jpeg: Buffer
  let manifest: ReturnType<typeof seal>
  const input = {
    session: 'sess_test',
    export_name: 'final',
    region: { x: 17, y: 13, width: 35, height: 29 },
  }

  beforeEach(async () => {
    cwd = await realpath(await mkdtemp(join(tmpdir(), 'lmfg-export-detail-')))
    sessionDir = join(cwd, '.lmfg', 'sessions', input.session)
    await mkdir(join(sessionDir, 'exports'), { recursive: true })
    await writeFile(
      join(sessionDir, 'session.json'),
      JSON.stringify({
        schema: 'lmfg.session.v1',
        id: input.session,
        source: { sha256: sourceSha, byte_size: 123 },
      }),
    )
    const pixels = Buffer.alloc(full.width * full.height * 3)
    for (let y = 0; y < full.height; y += 1) {
      for (let x = 0; x < full.width; x += 1) {
        const index = (y * full.width + x) * 3
        pixels[index] = (x * 11 + y * 3) % 256
        pixels[index + 1] = (x * 7 + y * 13) % 256
        pixels[index + 2] = (x * 23 + y * 17) % 256
      }
    }
    jpeg = await sharp(pixels, { raw: { ...full, channels: 3 } })
      .withMetadata({ orientation: 1 })
      .jpeg({ quality: 87, chromaSubsampling: '4:2:0' })
      .toBuffer()
    jpegPath = join(sessionDir, 'exports', 'final.jpg')
    manifestPath = join(sessionDir, 'exports', 'final.manifest.json')
    manifest = seal({
      manifest_version: 1,
      kind: 'export',
      parent_manifest_sha256: parentSha,
      source_raw: {
        sha256: sourceSha,
        byte_size: 123,
        decoded_dimensions: full,
      },
      policy: { kind: 'export-full' },
      output: {
        format: 'jpeg',
        color_space: 'srgb',
        filename: 'final.jpg',
        sha256: hash(jpeg),
        dimensions: full,
      },
    })
    await writeFile(jpegPath, jpeg)
    await writeFile(manifestPath, JSON.stringify(manifest))
  })

  afterEach(async () => {
    vi.mocked(open).mockReset()
    vi.restoreAllMocks()
    await rm(cwd, { recursive: true, force: true })
  })

  it.each([
    { x: 17, y: 13, width: 35, height: 29 },
    { x: 0, y: 0, width: 1, height: 1 },
    { x: 111, y: 81, width: 17, height: 15 },
    { x: 0, y: 0, ...full },
  ])(
    'matches the corresponding pixels of a full JPEG decode for %o',
    async (region) => {
      const { png, result } = await createExportDetail(cwd, {
        ...input,
        region,
      })
      const decoded = await sharp(jpeg).removeAlpha().raw().toBuffer()
      const expected = Buffer.alloc(region.width * region.height * 3)
      for (let row = 0; row < region.height; row += 1) {
        const start = ((region.y + row) * full.width + region.x) * 3
        decoded.copy(
          expected,
          row * region.width * 3,
          start,
          start + region.width * 3,
        )
      }
      expect(await sharp(png).removeAlpha().raw().toBuffer()).toEqual(expected)
      expect(await sharp(png).metadata()).toMatchObject({
        format: 'png',
        width: region.width,
        height: region.height,
      })
      expect((await sharp(png).metadata()).exif).toBeUndefined()
      expect(result).toMatchObject({
        session_id: input.session,
        export_name: 'final',
        source_sha256: sourceSha,
        export_manifest_sha256: manifest.manifest_sha256,
        parent_candidate_manifest_sha256: parentSha,
        input_jpeg_sha256: hash(jpeg),
        full_dimensions: full,
        region,
        width: region.width,
        height: region.height,
        mime_type: 'image/png',
        sha256: hash(png),
        decoder: { name: 'sharp', version: '0.34.5' },
      })
      expect(await readFile(fileURLToPath(result.uri))).toEqual(png)
      expect(fileURLToPath(result.uri)).toBe(
        join(sessionDir, 'exports', 'details', `${hash(png)}.png`),
      )
      const receiptBytes = await readFile(fileURLToPath(result.receipt_uri))
      const { receipt_uri: _uri, receipt_sha256, ...receipt } = result
      expect(JSON.parse(receiptBytes.toString())).toEqual(receipt)
      expect(hash(receiptBytes)).toBe(receipt_sha256)
      expect(fileURLToPath(result.receipt_uri)).toBe(
        join(sessionDir, 'exports', 'details', `${receipt_sha256}.json`),
      )
      const repeated = await createExportDetail(cwd, { ...input, region })
      expect(repeated.png).toEqual(png)
      expect(repeated.result).toEqual(result)
    },
  )

  it('rejects traversal, arbitrary paths, and unbounded or invalid rectangles', async () => {
    for (const changed of [
      { ...input, session: '../outside' },
      { ...input, export_name: '../outside' },
      { ...input, path: '/outside.jpg' },
      { ...input, region: { ...input.region, x: -1 } },
      { ...input, region: { ...input.region, y: 0.5 } },
      { ...input, region: { ...input.region, width: 0 } },
      { ...input, region: { x: 0, y: 0, width: 2001, height: 1000 } },
    ])
      expect(ExportDetailInputSchema.safeParse(changed).success).toBe(false)
    await expect(
      createExportDetail(cwd, {
        ...input,
        region: { x: 127, y: 0, width: 2, height: 1 },
      }),
    ).rejects.toThrow(/bounds/i)
  })

  it('refuses JPEG hash changes and changes to any sealed manifest field', async () => {
    await writeFile(jpegPath, Buffer.concat([jpeg, Buffer.from('drift')]))
    await expect(createExportDetail(cwd, input)).rejects.toThrow(/hash/i)
    await writeFile(jpegPath, jpeg)
    await writeFile(
      manifestPath,
      JSON.stringify({ ...manifest, ignored_field: true }),
    )
    await expect(createExportDetail(cwd, input)).rejects.toThrow(
      /manifest.*hash/i,
    )
  })

  it('refuses inconsistent export kind, source, dimensions, filename, and policy', async () => {
    const original = JSON.parse(JSON.stringify(manifest))
    for (const changed of [
      { ...original, kind: 'preview' },
      {
        ...original,
        source_raw: { ...original.source_raw, sha256: 'c'.repeat(64) },
      },
      { ...original, source_raw: { ...original.source_raw, byte_size: 124 } },
      { ...original, output: { ...original.output, filename: 'other.jpg' } },
      {
        ...original,
        output: { ...original.output, dimensions: { width: 127, height: 96 } },
      },
      { ...original, policy: { kind: 'preview-quick' } },
    ]) {
      await writeFile(manifestPath, JSON.stringify(seal(changed)))
      await expect(createExportDetail(cwd, input)).rejects.toThrow()
    }
    await writeFile(manifestPath, JSON.stringify(manifest))
    await writeFile(
      join(sessionDir, 'session.json'),
      JSON.stringify({
        schema: 'lmfg.session.v1',
        id: 'another',
        source: { sha256: sourceSha, byte_size: 123 },
      }),
    )
    await expect(createExportDetail(cwd, input)).rejects.toThrow(/session/i)
  })

  it('checks actual JPEG dimensions and refuses unapplied orientation', async () => {
    for (const replacement of [
      await sharp(jpeg).resize(64, 48).jpeg().toBuffer(),
      await sharp(jpeg).withMetadata({ orientation: 6 }).jpeg().toBuffer(),
      jpeg.subarray(0, -100),
    ]) {
      await writeFile(jpegPath, replacement)
      const original = JSON.parse(JSON.stringify(manifest))
      await writeFile(
        manifestPath,
        JSON.stringify(
          seal({
            ...original,
            output: { ...original.output, sha256: hash(replacement) },
          }),
        ),
      )
      await expect(createExportDetail(cwd, input)).rejects.toThrow(
        /dimensions|orientation|JPEG/i,
      )
    }
  })

  it('refuses oversized source files and source dimensions before decoding', async () => {
    await truncate(jpegPath, EXPORT_DETAIL_LIMITS.max_source_bytes + 1)
    await expect(createExportDetail(cwd, input)).rejects.toThrow(/bytes/i)
    await writeFile(jpegPath, jpeg)
    const original = JSON.parse(JSON.stringify(manifest))
    const huge = { width: 12001, height: 10000 }
    await writeFile(
      manifestPath,
      JSON.stringify(
        seal({
          ...original,
          source_raw: { ...original.source_raw, decoded_dimensions: huge },
          output: { ...original.output, dimensions: huge },
        }),
      ),
    )
    await expect(createExportDetail(cwd, input)).rejects.toThrow(/pixels/i)
  })

  it('refuses symlinked image, metadata, source directories, and output directories', async () => {
    for (const path of [
      jpegPath,
      manifestPath,
      join(sessionDir, 'session.json'),
    ]) {
      const target = `${path}.original`
      await rename(path, target)
      await symlink(target, path)
      await expect(createExportDetail(cwd, input)).rejects.toThrow(
        /symlink|canonical/i,
      )
      await rm(path)
      await rename(target, path)
    }
    const outside = join(cwd, 'outside')
    await mkdir(outside)
    await symlink(outside, join(sessionDir, 'exports', 'details'), 'dir')
    await expect(createExportDetail(cwd, input)).rejects.toThrow(
      /symlink|canonical/i,
    )
    await rm(join(sessionDir, 'exports', 'details'))
    await rename(sessionDir, `${sessionDir}-real`)
    await symlink(`${sessionDir}-real`, sessionDir, 'dir')
    await expect(createExportDetail(cwd, input)).rejects.toThrow(
      /symlink|canonical/i,
    )
  })

  it('refuses corrupt or symlinked content-addressed output without overwriting it', async () => {
    const first = await createExportDetail(cwd, input)
    const path = fileURLToPath(first.result.uri)
    await writeFile(path, 'corrupt')
    await expect(createExportDetail(cwd, input)).rejects.toThrow(
      /content-addressed/i,
    )
    expect(await readFile(path, 'utf8')).toBe('corrupt')
    await rm(path)
    await symlink(jpegPath, path)
    await expect(createExportDetail(cwd, input)).rejects.toThrow(
      /symlink|canonical/i,
    )
    expect(await readFile(jpegPath)).toEqual(jpeg)
  })

  it('returns an actionable error if the optional native decoder cannot load', async () => {
    await expect(
      createExportDetail(cwd, input, async () => {
        throw new Error('platform binary missing')
      }),
    ).rejects.toThrow(/Sharp.*install|install.*Sharp/i)
  })

  it.each(['writeFile', 'sync'] as const)(
    'cleans a temporary output when %s fails',
    async (operation) => {
      const actual =
        await vi.importActual<typeof import('node:fs/promises')>(
          'node:fs/promises',
        )
      vi.mocked(open).mockImplementation(async (...args) => {
        const handle = await actual.open(...args)
        if (String(args[0]).endsWith('.tmp')) {
          vi.spyOn(handle, operation).mockRejectedValue(
            new Error(`simulated ${operation} failure`),
          )
        }
        return handle
      })
      await expect(createExportDetail(cwd, input)).rejects.toThrow(
        `simulated ${operation} failure`,
      )
      expect(await readdir(join(sessionDir, 'exports', 'details'))).toEqual([])
    },
  )
})
