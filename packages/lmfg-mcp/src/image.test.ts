import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { computeManifestSha256 } from '@lumaforge/render-engine'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { IMAGE_LIMITS, ImageReadInputSchema, readSessionImage } from './image'
import { createLmfgMcpServer } from './server'

// One white pixel encoded by the shipped native JPEG runtime.
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkMEQ8SEhEPERETFhwXExQaFRERGCEYGh0dHx8fExciJCIeJBweHx7/2wBDAQUFBQcGBw4ICA4eFBEUHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh7/wAARCAABAAEDAREAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD7LoA//9k=',
  'base64',
)
const sha256 = (bytes: Buffer) =>
  createHash('sha256').update(bytes).digest('hex')
const SOURCE_SHA = 'a'.repeat(64)
const seal = (manifest: object) => ({
  ...manifest,
  manifest_sha256: computeManifestSha256(manifest),
})

describe('session image delivery', () => {
  let cwd: string
  let sessionDir: string
  let preview: string
  let manifest: string

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'lmfg-image-'))
    sessionDir = join(cwd, '.lmfg', 'sessions', 'sess_test')
    await mkdir(join(sessionDir, 'previews'), { recursive: true })
    await writeFile(
      join(sessionDir, 'session.json'),
      JSON.stringify({
        schema: 'lmfg.session.v1',
        id: 'sess_test',
        source: { sha256: SOURCE_SHA },
      }),
    )
    preview = join(sessionDir, 'previews', 'prev_0001.jpg')
    manifest = join(sessionDir, 'previews', 'prev_0001.manifest.json')
    await writeFile(preview, JPEG)
    await writeFile(
      manifest,
      JSON.stringify(
        seal({
          kind: 'preview',
          source_raw: { sha256: SOURCE_SHA },
          output: {
            sha256: sha256(JPEG),
            filename: 'prev_0001.jpg',
            dimensions: { width: 1, height: 1 },
          },
        }),
      ),
    )
  })

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true })
  })

  const args = {
    session: 'sess_test',
    artifact: { kind: 'preview' as const, preview_id: 'prev_0001' },
  }

  it('returns selected image bytes with identity and dimensions', async () => {
    const result = await readSessionImage(cwd, args)
    expect(result.isError).toBe(false)
    expect(result.structuredContent).toMatchObject({
      schema: 'lmfg.image.read.v1',
      ok: true,
      result: {
        session_id: 'sess_test',
        artifact: args.artifact,
        source_sha256: SOURCE_SHA,
        sha256: sha256(JPEG),
        width: 1,
        height: 1,
      },
    })
    expect(result.content[1]).toEqual({
      type: 'image',
      mimeType: 'image/jpeg',
      data: JPEG.toString('base64'),
    })
  })

  it('rejects traversal and ambiguous selectors', () => {
    for (const input of [
      { ...args, session: '../outside' },
      { ...args, artifact: { kind: 'preview', preview_id: '../../private' } },
      { ...args, artifact: { ...args.artifact, candidate_id: 'cand_1' } },
      { ...args, artifact: { kind: 'candidate', iteration_id: 'iter_0001' } },
    ])
      expect(ImageReadInputSchema.safeParse(input).success).toBe(false)
  })

  it('rejects image and metadata symlinks before reading their target', async () => {
    for (const path of [preview, manifest]) {
      const original = await readFile(path)
      const target = join(cwd, 'outside')
      await writeFile(target, original)
      await rm(path)
      await symlink(target, path)
      expect((await readSessionImage(cwd, args)).isError).toBe(true)
      await rm(path)
      await writeFile(path, original)
    }
  })

  it('rejects session identity, source identity, and image hash mismatches', async () => {
    const original = JSON.parse(await readFile(manifest, 'utf8'))
    for (const changed of [
      { ...original, source_raw: { sha256: 'c'.repeat(64) } },
      { ...original, output: { ...original.output, sha256: 'c'.repeat(64) } },
      {
        ...original,
        output: { ...original.output, dimensions: { width: 2, height: 1 } },
      },
    ]) {
      await writeFile(manifest, JSON.stringify(seal(changed)))
      expect((await readSessionImage(cwd, args)).isError).toBe(true)
    }
    await writeFile(manifest, JSON.stringify(original))
    await writeFile(
      join(sessionDir, 'session.json'),
      JSON.stringify({
        schema: 'lmfg.session.v1',
        id: 'other',
        source: { sha256: SOURCE_SHA },
      }),
    )
    expect((await readSessionImage(cwd, args)).isError).toBe(true)
  })

  it('rejects oversized and malformed JPEG payloads', async () => {
    for (const bytes of [
      Buffer.alloc(IMAGE_LIMITS.max_bytes + 1),
      Buffer.from('not a JPEG'),
      JPEG.subarray(0, -2),
    ]) {
      await writeFile(preview, bytes)
      expect((await readSessionImage(cwd, args)).isError).toBe(true)
    }
    const huge = Buffer.from(JPEG)
    const frame = huge.indexOf(Buffer.from([255, 192]))
    huge.writeUInt16BE(65535, frame + 5)
    huge.writeUInt16BE(65535, frame + 7)
    await writeFile(preview, huge)
    expect((await readSessionImage(cwd, args)).isError).toBe(true)
  })

  it('rejects manifest changes even in fields outside the image projection', async () => {
    const original = JSON.parse(await readFile(manifest, 'utf8'))
    await writeFile(
      manifest,
      JSON.stringify({ ...original, render_params: { exposure_ev: 5 } }),
    )
    const result = await readSessionImage(cwd, args)
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({
      error: { message: expect.stringMatching(/manifest.*hash/i) },
    })
  })

  it('rejects a JPEG frame with no scan even when its manifest hash matches', async () => {
    const frame = JPEG.indexOf(Buffer.from([255, 192]))
    const truncated = Buffer.concat([
      JPEG.subarray(0, frame + 2 + JPEG.readUInt16BE(frame + 2)),
      Buffer.from([255, 217]),
    ])
    await writeFile(preview, truncated)
    const original = JSON.parse(await readFile(manifest, 'utf8'))
    await writeFile(
      manifest,
      JSON.stringify(
        seal({
          ...original,
          output: { ...original.output, sha256: sha256(truncated) },
        }),
      ),
    )
    const result = await readSessionImage(cwd, args)
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({
      error: { message: expect.stringMatching(/JPEG.*scan/i) },
    })
  })

  it('returns contact sheet candidate labels and bounds, and rejects unknown candidates', async () => {
    const dir = join(sessionDir, 'iterations', 'iter_0001')
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'plan.json'),
      JSON.stringify({
        schema: 'lmfg.iteration.v1',
        id: 'iter_0001',
        session_id: 'sess_test',
        candidates: [{ id: 'warm', tag: 'Warm skin' }],
      }),
    )
    await writeFile(join(dir, 'contact-sheet.jpg'), JPEG)
    const map = {
      schema: 'lmfg.contact-sheet-map.v1',
      iteration_id: 'iter_0001',
      width: 1,
      height: 1,
      cols: 1,
      rows: 1,
      tiles: [
        { candidate_id: 'warm', index: 0, x: 0, y: 0, width: 1, height: 1 },
      ],
    }
    await writeFile(join(dir, 'contact-sheet.map.json'), JSON.stringify(map))
    const input = {
      session: 'sess_test',
      artifact: { kind: 'contact-sheet' as const, iteration_id: 'iter_0001' },
    }
    expect(
      (await readSessionImage(cwd, input)).structuredContent,
    ).toMatchObject({
      result: { tiles: [{ candidate_id: 'warm', tag: 'Warm skin', index: 0 }] },
    })
    await writeFile(
      join(dir, 'contact-sheet.map.json'),
      JSON.stringify({
        ...map,
        tiles: [{ ...map.tiles[0], candidate_id: 'missing' }],
      }),
    )
    expect((await readSessionImage(cwd, input)).isError).toBe(true)
  })

  it('delivers a discoverable image content block through the actual MCP SDK transport', async () => {
    const server = createLmfgMcpServer({ cwd, version: 'test' })
    const client = new Client({ name: 'image-test', version: 'test' })
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair()
    try {
      await server.connect(serverTransport)
      await client.connect(clientTransport)
      const { tools } = await client.listTools()
      expect(
        tools.find((tool) => tool.name === 'lmfg_image_read')?.inputSchema
          .properties,
      ).toHaveProperty('artifact')
      const result = await client.callTool({
        name: 'lmfg_image_read',
        arguments: args,
      })
      expect(result.isError).toBe(false)
      expect(result.content).toContainEqual({
        type: 'image',
        mimeType: 'image/jpeg',
        data: JPEG.toString('base64'),
      })
    } finally {
      await client.close()
      await server.close()
    }
  })
})
