import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { resolveWorkspaceRoot, workspacePaths } from '@lumaforge/lmfg-cli'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { IMAGE_LIMITS, ImageReadInputSchema, readSessionImage } from './image'
import { createLmfgMcpServer } from './server'
import {
  contactSheetMap,
  iterationRecord,
  renderManifest,
  seal,
  sessionRecord,
} from './test-support/workspace-records'

// One white pixel encoded by the shipped native JPEG runtime.
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkMEQ8SEhEPERETFhwXExQaFRERGCEYGh0dHx8fExciJCIeJBweHx7/2wBDAQUFBQcGBw4ICA4eFBEUHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh7/wAARCAABAAEDAREAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD7LoA//9k=',
  'base64',
)
const sha256 = (bytes: Buffer) =>
  createHash('sha256').update(bytes).digest('hex')
const SOURCE_SHA = 'a'.repeat(64)
const SOURCE = { sha256: SOURCE_SHA, byte_size: 25_165_824 }
const SESSION = 'sess_test'
const imageManifest = (
  kind: 'preview' | 'candidate',
  filename: string,
  bytes: Buffer,
) =>
  seal(
    renderManifest({
      kind,
      source: SOURCE,
      decoded: { width: 6000, height: 4000 },
      output: { filename, sha256: sha256(bytes), width: 1, height: 1 },
    }),
  )

describe('session image delivery', () => {
  let cwd: string
  let root: string
  let sessionFile: string
  let preview: string
  let manifest: string

  async function writeRecord(path: string, record: unknown): Promise<void> {
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, JSON.stringify(record))
  }

  async function writeIteration(): Promise<void> {
    await writeRecord(
      workspacePaths.iterationPlanFile(root, SESSION, 'iter_0001'),
      iterationRecord('iter_0001', SESSION, [
        { id: 'warm', tag: 'Warm skin' },
        { id: 'cool', tag: null },
      ]),
    )
  }

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'lmfg-image-'))
    root = resolveWorkspaceRoot(cwd)
    sessionFile = workspacePaths.sessionFile(root, SESSION)
    await writeRecord(sessionFile, sessionRecord(SESSION, SOURCE))
    preview = workspacePaths.previewFile(root, SESSION, 'prev_0001')
    manifest = workspacePaths.previewManifestFile(root, SESSION, 'prev_0001')
    await mkdir(workspacePaths.previews(root, SESSION))
    await writeFile(preview, JPEG)
    await writeRecord(manifest, imageManifest('preview', 'prev_0001.jpg', JPEG))
  })

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true })
  })

  const args = {
    session: SESSION,
    artifact: { kind: 'preview' as const, preview_id: 'prev_0001' },
  }

  it('returns selected image bytes with identity and dimensions', async () => {
    const result = await readSessionImage(cwd, args)
    expect(result.isError).toBe(false)
    expect(result.structuredContent).toMatchObject({
      schema: 'lmfg.image.read.v1',
      ok: true,
      result: {
        session_id: SESSION,
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
      {
        ...original,
        source_raw: { ...original.source_raw, sha256: 'c'.repeat(64) },
      },
      { ...original, output: { ...original.output, sha256: 'c'.repeat(64) } },
      {
        ...original,
        output: { ...original.output, dimensions: { width: 2, height: 1 } },
      },
    ]) {
      await writeFile(manifest, JSON.stringify(seal(changed)))
      expect((await readSessionImage(cwd, args)).structuredContent).toEqual({
        schema: 'lmfg.error.v1',
        ok: false,
        error: {
          code: 'image.refused',
          message:
            'Image content or provenance does not match its recorded manifest.',
        },
      })
    }
    await writeFile(manifest, JSON.stringify(original))
    await writeRecord(sessionFile, sessionRecord('other', SOURCE))
    expect((await readSessionImage(cwd, args)).structuredContent).toMatchObject(
      {
        error: {
          message:
            'Session record identity does not match the requested session.',
        },
      },
    )
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
    await writeIteration()
    await writeFile(
      workspacePaths.contactSheetFile(root, SESSION, 'iter_0001'),
      JPEG,
    )
    const mapFile = workspacePaths.contactSheetMapFile(
      root,
      SESSION,
      'iter_0001',
    )
    const map = contactSheetMap('iter_0001', { width: 1, height: 1 }, [
      { candidate_id: 'warm', x: 0, y: 0, width: 1, height: 1 },
    ])
    await writeRecord(mapFile, map)
    const input = {
      session: SESSION,
      artifact: { kind: 'contact-sheet' as const, iteration_id: 'iter_0001' },
    }
    expect(
      (await readSessionImage(cwd, input)).structuredContent,
    ).toMatchObject({
      result: { tiles: [{ candidate_id: 'warm', tag: 'Warm skin', index: 0 }] },
    })
    await writeRecord(mapFile, {
      ...map,
      tiles: [{ ...map.tiles[0], candidate_id: 'missing' }],
    })
    expect((await readSessionImage(cwd, input)).isError).toBe(true)
  })

  it('reads a named contact sheet from the CLI sheet path', async () => {
    await writeIteration()
    await writeFile(
      workspacePaths.contactSheetFile(root, SESSION, 'iter_0001', 'warm-only'),
      JPEG,
    )
    await writeRecord(
      workspacePaths.contactSheetMapFile(
        root,
        SESSION,
        'iter_0001',
        'warm-only',
      ),
      contactSheetMap('iter_0001', { width: 1, height: 1 }, [
        { candidate_id: 'warm', x: 0, y: 0, width: 1, height: 1 },
      ]),
    )
    const result = await readSessionImage(cwd, {
      session: SESSION,
      artifact: {
        kind: 'contact-sheet',
        iteration_id: 'iter_0001',
        name: 'warm-only',
      },
    })
    expect(result.structuredContent).toMatchObject({
      ok: true,
      result: { label: 'warm-only', width: 1, height: 1 },
    })
  })

  it('returns a registered candidate preview with its tag and manifest identity', async () => {
    await writeIteration()
    const candidateManifest = imageManifest('candidate', 'preview.jpg', JPEG)
    await mkdir(workspacePaths.candidate(root, SESSION, 'iter_0001', 'warm'), {
      recursive: true,
    })
    await writeFile(
      workspacePaths.candidatePreviewFile(root, SESSION, 'iter_0001', 'warm'),
      JPEG,
    )
    await writeRecord(
      workspacePaths.candidateManifestFile(root, SESSION, 'iter_0001', 'warm'),
      candidateManifest,
    )
    const input = {
      session: SESSION,
      artifact: {
        kind: 'candidate' as const,
        iteration_id: 'iter_0001',
        candidate_id: 'warm',
      },
    }
    expect(
      (await readSessionImage(cwd, input)).structuredContent,
    ).toMatchObject({
      ok: true,
      result: {
        label: 'Warm skin',
        sha256: sha256(JPEG),
        manifest_sha256: candidateManifest.manifest_sha256,
      },
    })
    const unregistered = await readSessionImage(cwd, {
      ...input,
      artifact: { ...input.artifact, candidate_id: 'other' },
    })
    expect(unregistered.structuredContent).toMatchObject({
      error: { message: expect.stringMatching(/not registered/i) },
    })
  })

  it('reads from a non-default workspace root', async () => {
    await rename(root, resolveWorkspaceRoot(cwd, 'renders'))
    expect((await readSessionImage(cwd, args)).isError).toBe(true)
    expect(
      (await readSessionImage(cwd, { ...args, workspace: 'renders' }))
        .structuredContent,
    ).toMatchObject({ ok: true, result: { sha256: sha256(JPEG) } })
  })

  it('refuses a sealed manifest that is not a structurally valid render manifest', async () => {
    const original = JSON.parse(await readFile(manifest, 'utf8'))
    const { environment: _environment, ...withoutEnvironment } = original
    await writeRecord(manifest, seal(withoutEnvironment))
    const result = await readSessionImage(cwd, args)
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({
      error: { message: expect.stringMatching(/manifest.*environment/i) },
    })
  })

  it('refuses session, iteration, and contact-sheet records outside the CLI record schemas', async () => {
    const { created_at: _created, ...partialSession } = sessionRecord(
      SESSION,
      SOURCE,
    )
    await writeRecord(sessionFile, partialSession)
    expect((await readSessionImage(cwd, args)).isError).toBe(true)
    await writeRecord(sessionFile, sessionRecord(SESSION, SOURCE))

    const plan = iterationRecord('iter_0001', SESSION, [
      { id: 'warm', tag: 'Warm skin' },
    ])
    const planFile = workspacePaths.iterationPlanFile(
      root,
      SESSION,
      'iter_0001',
    )
    await writeRecord(planFile, {
      ...plan,
      candidates: [{ id: 'warm', tag: 'Warm skin' }],
    })
    await writeFile(
      workspacePaths.contactSheetFile(root, SESSION, 'iter_0001'),
      JPEG,
    )
    const map = contactSheetMap('iter_0001', { width: 1, height: 1 }, [
      { candidate_id: 'warm', x: 0, y: 0, width: 1, height: 1 },
    ])
    const mapFile = workspacePaths.contactSheetMapFile(
      root,
      SESSION,
      'iter_0001',
    )
    await writeRecord(mapFile, map)
    const input = {
      session: SESSION,
      artifact: { kind: 'contact-sheet' as const, iteration_id: 'iter_0001' },
    }
    expect((await readSessionImage(cwd, input)).isError).toBe(true)
    await writeRecord(planFile, plan)
    expect((await readSessionImage(cwd, input)).isError).toBe(false)
    const { tile_width: _tileWidth, ...partialMap } = map
    await writeRecord(mapFile, partialMap)
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

describe('session image delivery from the documented CLI layout', () => {
  let cwd: string

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'lmfg-image-layout-'))
  })

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true })
  })

  // Spelled out segment by segment as the CLI documents its workspace, so the
  // reader is held to the on-disk layout and not to the path helpers.
  async function put(segments: string[], content: Buffer | string) {
    const path = join(cwd, '.lmfg', 'sessions', 'sess_layout', ...segments)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, content)
  }

  it('reads a preview, a candidate, and a contact sheet at their literal paths', async () => {
    const source = { sha256: 'e'.repeat(64), byte_size: 4096 }
    await put(
      ['session.json'],
      JSON.stringify(sessionRecord('sess_layout', source)),
    )
    await put(['previews', 'prev_0003.jpg'], JPEG)
    const previewManifest = seal(
      renderManifest({
        kind: 'preview',
        source,
        decoded: { width: 3000, height: 2000 },
        output: {
          filename: 'prev_0003.jpg',
          sha256: sha256(JPEG),
          width: 1,
          height: 1,
        },
      }),
    )
    await put(
      ['previews', 'prev_0003.manifest.json'],
      JSON.stringify(previewManifest),
    )
    await put(
      ['iterations', 'iter_0002', 'plan.json'],
      JSON.stringify(
        iterationRecord('iter_0002', 'sess_layout', [
          { id: 'cand_0001', tag: 'Soft' },
        ]),
      ),
    )
    await put(
      ['iterations', 'iter_0002', 'candidates', 'cand_0001', 'preview.jpg'],
      JPEG,
    )
    const candidateManifest = seal(
      renderManifest({
        kind: 'candidate',
        source,
        decoded: { width: 3000, height: 2000 },
        output: {
          filename: 'preview.jpg',
          sha256: sha256(JPEG),
          width: 1,
          height: 1,
        },
      }),
    )
    await put(
      ['iterations', 'iter_0002', 'candidates', 'cand_0001', 'manifest.json'],
      JSON.stringify(candidateManifest),
    )
    await put(['iterations', 'iter_0002', 'contact-sheet.jpg'], JPEG)
    await put(
      ['iterations', 'iter_0002', 'contact-sheet.map.json'],
      JSON.stringify(
        contactSheetMap('iter_0002', { width: 1, height: 1 }, [
          { candidate_id: 'cand_0001', x: 0, y: 0, width: 1, height: 1 },
        ]),
      ),
    )
    const sessionDir = join(cwd, '.lmfg', 'sessions', 'sess_layout')

    const preview = await readSessionImage(cwd, {
      session: 'sess_layout',
      artifact: { kind: 'preview', preview_id: 'prev_0003' },
    })
    expect(preview.structuredContent).toMatchObject({
      ok: true,
      result: {
        label: 'prev_0003',
        uri: pathToFileURL(join(sessionDir, 'previews', 'prev_0003.jpg')).href,
        manifest_sha256: previewManifest.manifest_sha256,
      },
    })

    const candidate = await readSessionImage(cwd, {
      session: 'sess_layout',
      artifact: {
        kind: 'candidate',
        iteration_id: 'iter_0002',
        candidate_id: 'cand_0001',
      },
    })
    expect(candidate.structuredContent).toMatchObject({
      ok: true,
      result: {
        label: 'Soft',
        uri: pathToFileURL(
          join(
            sessionDir,
            'iterations',
            'iter_0002',
            'candidates',
            'cand_0001',
            'preview.jpg',
          ),
        ).href,
        manifest_sha256: candidateManifest.manifest_sha256,
      },
    })

    const sheet = await readSessionImage(cwd, {
      session: 'sess_layout',
      artifact: { kind: 'contact-sheet', iteration_id: 'iter_0002' },
    })
    expect(sheet.structuredContent).toMatchObject({
      ok: true,
      result: {
        label: 'contact-sheet',
        uri: pathToFileURL(
          join(sessionDir, 'iterations', 'iter_0002', 'contact-sheet.jpg'),
        ).href,
        tiles: [{ candidate_id: 'cand_0001', tag: 'Soft', index: 0 }],
      },
    })
  })
})
