// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { resolveRenderEnvironment } from '../runtime/versions'
import { parseRenderParams } from '../schemas/params'
import {
  ContactSheetMapSchema,
  IterationRecordSchema,
  SessionRecordSchema,
} from '../schemas/results'
import { buildColorGraph, requireSupportedGraph } from '../services/color-graph'
import { buildRenderManifest } from '../services/manifest'
import { computeImageMetrics } from '../services/metrics'
import { createIterationStore } from './iteration-store'
import { workspacePaths } from './paths'
import { createSessionStore } from './session-store'

let root: string
beforeEach(async () => {
  root = join(await mkdtemp(join(tmpdir(), 'lmfg-it-')), '.lmfg')
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('iteration store', () => {
  it('writes plan, events, candidate artifacts, and reads tiles back', async () => {
    const store = createIterationStore(root, 'sess_x')
    const params = parseRenderParams({})
    await store.create({
      schema: 'lmfg.iteration.v1',
      id: 'iter_0001',
      session_id: 'sess_x',
      created_at: 'now',
      kind: 'candidate',
      base: params,
      candidates: [{ id: 'cand_0001', tag: null, params }],
      options: { max_pixels: 2_500_000, quality: 85, contact_sheet: null },
    })
    await store.appendEvent('iter_0001', { event: 'started' })
    await store.appendEvent('iter_0001', { event: 'completed' })
    const tile = {
      rgba: new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 255]),
      width: 2,
      height: 1,
    }
    const paths = await store.writeCandidate('iter_0001', 'cand_0001', {
      previewJpeg: new Uint8Array([0xFF, 0xD8, 0xFF, 0xD9]),
      manifest: { manifest_sha256: 'x' } as never,
      metrics: { schema: 'lmfg.metrics.v1' } as never,
      tile,
      params,
    })
    expect(paths.preview.endsWith('preview.jpg')).toBe(true)
    const events = await readFile(
      join(
        root,
        'sessions',
        'sess_x',
        'iterations',
        'iter_0001',
        'events.ndjson',
      ),
      'utf8',
    )
    expect(events.trim().split('\n')).toHaveLength(2)
    expect(await store.readCandidateTile('iter_0001', 'cand_0001')).toEqual(
      tile,
    )
    expect(await store.listCandidates('iter_0001')).toEqual(['cand_0001'])
    expect((await store.read('iter_0001')).candidates[0].id).toBe('cand_0001')
    expect(await store.readCandidateParams('iter_0001', 'cand_0001')).toEqual(
      params,
    )
    await expect(store.read('iter_9999')).rejects.toMatchObject({
      code: 'iteration.not_found',
    })
  })
})

// Documents in the exact shape lmfg 0.1.0 wrote: params predate
// selective_color, and a sweep records its resolved contact-sheet layout.
const SID = 'sess_20260905T041219_a1b2c3'
const params010 = {
  exposure_ev: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
  temperature: 0,
  tint: 0,
  saturation: 0,
  vibrance: 0,
  intensity: 1,
  raw_render_exposure: 'auto',
  lut: {
    path: 'looks/film.cube',
    contract: { role: 'display-look', input_profile: 'slog3-sgamut3cine' },
  },
}
const session010 = {
  schema: 'lmfg.session.v1',
  id: SID,
  created_at: '2026-09-05T04:12:19.000Z',
  updated_at: '2026-09-05T04:13:02.512Z',
  workspace_root: '/work/.lmfg',
  source: {
    path: '/work/DSC00001.ARW',
    filename: 'DSC00001.ARW',
    byte_size: 25_165_824,
    sha256: 'a'.repeat(64),
  },
  decoded_dimensions: { width: 6000, height: 4000 },
  counters: { previews: 1, iterations: 1, exports: 0 },
  status: 'inspected',
}
const iteration010 = {
  schema: 'lmfg.iteration.v1',
  id: 'iter_0001',
  session_id: SID,
  created_at: '2026-09-05T04:13:02.500Z',
  kind: 'sweep',
  base: params010,
  candidates: [
    {
      id: 'cand_0001',
      tag: 'contrast=-10',
      params: { ...params010, contrast: -10 },
    },
    {
      id: 'cand_0002',
      tag: 'contrast=10',
      params: { ...params010, contrast: 10 },
    },
  ],
  options: {
    max_pixels: 2_500_000,
    quality: 85,
    contact_sheet: { cols: 2, tile_width: 384, gap: 8 },
  },
}
const map010 = {
  schema: 'lmfg.contact-sheet-map.v1',
  iteration_id: 'iter_0001',
  cols: 2,
  rows: 1,
  tile_width: 384,
  tile_height: 256,
  gap: 8,
  width: 792,
  height: 272,
  tiles: [
    {
      candidate_id: 'cand_0001',
      index: 0,
      x: 8,
      y: 8,
      width: 384,
      height: 256,
    },
    {
      candidate_id: 'cand_0002',
      index: 1,
      x: 400,
      y: 8,
      width: 384,
      height: 256,
    },
  ],
}

async function writeDoc(path: string, doc: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, JSON.stringify(doc, null, 2))
}

describe('historical workspace records', () => {
  it('reads a 0.1.0 session record through the session schema', async () => {
    await writeDoc(workspacePaths.sessionFile(root, SID), session010)
    expect(await createSessionStore(root).load(SID)).toEqual(session010)
  })

  it('reads a 0.1.0 iteration record, defaulting the missing selective_color', async () => {
    await writeDoc(
      workspacePaths.iterationPlanFile(root, SID, 'iter_0001'),
      iteration010,
    )
    const record = await createIterationStore(root, SID).read('iter_0001')
    expect(record).toEqual({
      ...iteration010,
      base: { ...params010, selective_color: null },
      candidates: iteration010.candidates.map((candidate) => ({
        ...candidate,
        params: { ...candidate.params, selective_color: null },
      })),
    })
    expect(record.candidates[1].params).toEqual(
      parseRenderParams({ ...params010, contrast: 10 }),
    )
  })

  it('accepts a 0.1.0 contact-sheet map unchanged', () => {
    expect(ContactSheetMapSchema.parse(map010)).toEqual(map010)
  })

  it('round-trips the records the current writers produce', async () => {
    const store = createIterationStore(root, SID)
    const params = parseRenderParams({
      selective_color: { red: { hue: 5 } },
    })
    const record = IterationRecordSchema.parse({
      ...iteration010,
      kind: 'candidate',
      base: params,
      candidates: [{ id: 'warm', tag: null, params }],
      options: { ...iteration010.options, contact_sheet: null },
    })
    await store.create(record)
    expect(await store.read('iter_0001')).toEqual(record)

    const written = await store.writeContactSheet('iter_0001', {
      jpeg: new Uint8Array([0xFF, 0xD8, 0xFF, 0xD9]),
      map: ContactSheetMapSchema.parse(map010),
    })
    expect(JSON.parse(await readFile(written.map, 'utf8'))).toEqual(map010)
    expect(SessionRecordSchema.parse(session010)).toEqual(session010)
  })
})

describe('iteration record validation', () => {
  const planFile = () =>
    workspacePaths.iterationPlanFile(root, SID, 'iter_0001')

  it.each([
    [
      'a foreign schema id',
      { ...iteration010, schema: 'lmfg.iteration.v2' },
      'schema',
    ],
    [
      'a missing candidate list',
      { ...iteration010, candidates: undefined },
      'candidates',
    ],
    [
      'an empty candidate list',
      { ...iteration010, candidates: [] },
      'candidates',
    ],
    [
      'a candidate id with path syntax',
      {
        ...iteration010,
        candidates: [{ ...iteration010.candidates[0], id: '../outside' }],
      },
      'candidates.0.id',
    ],
    [
      'out-of-range params',
      { ...iteration010, base: { ...params010, contrast: 1000 } },
      'base.contrast',
    ],
    ['an unknown kind', { ...iteration010, kind: 'batch' }, 'kind'],
  ])(
    'rejects a plan with %s, naming the file and field',
    async (_name, doc, field) => {
      await writeDoc(planFile(), doc)
      await expect(
        createIterationStore(root, SID).read('iter_0001'),
      ).rejects.toMatchObject({
        code: 'schema.invalid',
        message: expect.stringContaining(planFile()),
        details: {
          record_path: planFile(),
          issues: expect.arrayContaining([
            expect.objectContaining({ path: field }),
          ]),
        },
      })
    },
  )

  it('rejects a contact-sheet map with path syntax in a tile id', async () => {
    const bad = {
      ...map010,
      tiles: [{ ...map010.tiles[0], candidate_id: 'a/b' }],
    }
    expect(ContactSheetMapSchema.safeParse(bad).success).toBe(false)
    await expect(
      createIterationStore(root, SID).writeContactSheet('iter_0001', {
        jpeg: new Uint8Array([0xFF, 0xD8, 0xFF, 0xD9]),
        map: bad as never,
      }),
    ).rejects.toMatchObject({ name: 'ZodError' })
  })
})

describe('stored candidate records', () => {
  const tile = {
    rgba: new Uint8ClampedArray([200, 40, 10, 255, 10, 120, 220, 255]),
    width: 2,
    height: 1,
  }

  async function writeCandidate() {
    const store = createIterationStore(root, SID)
    const params = parseRenderParams({
      contrast: 5,
      selective_color: { red: { hue: 5 } },
    })
    const exposure = { ev: 0, multiplier: 1, source: 'identity' as const }
    const manifest = buildRenderManifest({
      kind: 'candidate',
      source: {
        sha256: 'a'.repeat(64),
        byte_size: 10,
        filename: 'x.dng',
        decoded_dimensions: { width: 2, height: 1 },
      },
      lut: null,
      graph: requireSupportedGraph(buildColorGraph(params, null, exposure)),
      params,
      exposure,
      policy: { kind: 'candidate', row_slice: 32, concurrency: 1 },
      environment: resolveRenderEnvironment('desktop'),
      output: {
        width: 2,
        height: 1,
        quality: 85,
        filename: 'preview.jpg',
        sha256: 'b'.repeat(64),
      },
      parentManifestSha256: null,
      producedAt: new Date('2026-09-05T00:00:00Z'),
    })
    const metrics = computeImageMetrics(tile.rgba, tile.width, tile.height)
    const paths = await store.writeCandidate('iter_0001', 'cand_0001', {
      previewJpeg: new Uint8Array([0xFF, 0xD8, 0xFF, 0xD9]),
      manifest,
      metrics,
      tile,
      params,
    })
    return { store, paths, params, manifest, metrics }
  }

  async function rewriteJson(
    path: string,
    edit: (doc: Record<string, unknown>) => unknown,
  ): Promise<void> {
    await writeFile(
      path,
      JSON.stringify(edit(JSON.parse(await readFile(path, 'utf8')))),
    )
  }

  function storedRecordFailure(
    code: string,
    recordPath: string,
    field: string,
  ) {
    return {
      code,
      message: expect.stringContaining(recordPath),
      details: {
        record_path: recordPath,
        issues: expect.arrayContaining([
          expect.objectContaining({ path: field }),
        ]),
      },
    }
  }

  it('round-trips the records the current writer produces unchanged', async () => {
    const { store, params, manifest, metrics } = await writeCandidate()
    expect(await store.readCandidateTile('iter_0001', 'cand_0001')).toEqual(
      tile,
    )
    expect(await store.readCandidateMetrics('iter_0001', 'cand_0001')).toEqual(
      metrics,
    )
    expect(await store.readCandidateParams('iter_0001', 'cand_0001')).toEqual(
      params,
    )
    expect(await store.readCandidateManifest('iter_0001', 'cand_0001')).toEqual(
      manifest,
    )
  })

  it('keeps missing-file semantics', async () => {
    const { store, paths } = await writeCandidate()
    await rm(paths.metrics)
    expect(
      await store.readCandidateMetrics('iter_0001', 'cand_0001'),
    ).toBeNull()
    await rm(paths.tile)
    await expect(
      store.readCandidateTile('iter_0001', 'cand_0001'),
    ).rejects.toMatchObject({ code: 'candidate.not_found' })
    await rm(paths.manifest)
    await expect(
      store.readCandidateManifest('iter_0001', 'cand_0001'),
    ).rejects.toMatchObject({ code: 'candidate.not_found' })
    await rm(paths.params)
    await expect(
      store.readCandidateParams('iter_0001', 'cand_0001'),
    ).rejects.toMatchObject({ code: 'file.not_found' })
  })

  it.each([
    ['a foreign schema id', { schema: 'lmfg.tile.v2' }, 'schema'],
    ['a missing schema id', { schema: undefined }, 'schema'],
    ['an unknown format', { format: 'rgb8' }, 'format'],
    ['a fractional width', { width: 1.5 }, 'width'],
    ['a zero height', { height: 0 }, 'height'],
    ['a string byte length', { byte_length: '8' }, 'byte_length'],
    [
      'a byte length that is not width * height * 4',
      { byte_length: 6 },
      'byte_length',
    ],
  ])('rejects tile metadata with %s', async (_name, patch, field) => {
    const { store, paths } = await writeCandidate()
    await rewriteJson(paths.tileMeta, (doc) => ({ ...doc, ...patch }))
    await expect(
      store.readCandidateTile('iter_0001', 'cand_0001'),
    ).rejects.toMatchObject(
      storedRecordFailure('schema.invalid', paths.tileMeta, field),
    )
  })

  it.each([
    ['truncated', 4],
    ['extra', 12],
  ])('rejects %s tile bytes', async (_name, length) => {
    const { store, paths } = await writeCandidate()
    await writeFile(paths.tile, new Uint8Array(length))
    await expect(
      store.readCandidateTile('iter_0001', 'cand_0001'),
    ).rejects.toMatchObject(
      storedRecordFailure('schema.invalid', paths.tile, 'byte_length'),
    )
  })

  it.each([
    [
      'a foreign schema id',
      (doc: Record<string, unknown>) => ({ ...doc, schema: 'lmfg.metrics.v2' }),
      'schema',
    ],
    [
      'a string luma mean',
      (doc: Record<string, unknown>) => ({
        ...doc,
        luma: { ...(doc.luma as object), mean: '0.5' },
      }),
      'luma.mean',
    ],
    [
      'a fractional histogram count',
      (doc: Record<string, unknown>) => ({
        ...doc,
        histogram: { bins: 2, luma: [0.5, 1] },
      }),
      'histogram.luma.0',
    ],
    [
      'no chroma section',
      (doc: Record<string, unknown>) => ({ ...doc, chroma: undefined }),
      'chroma',
    ],
  ])('rejects stored metrics with %s', async (_name, edit, field) => {
    const { store, paths } = await writeCandidate()
    await rewriteJson(paths.metrics, edit)
    await expect(
      store.readCandidateMetrics('iter_0001', 'cand_0001'),
    ).rejects.toMatchObject(
      storedRecordFailure('schema.invalid', paths.metrics, field),
    )
  })

  it.each([
    ['a string contrast', { contrast: '5' }, 'contrast'],
    ['a null intensity', { intensity: null }, 'intensity'],
    ['an out-of-range exposure', { exposure_ev: 99 }, 'exposure_ev'],
    ['a foreign schema id', { schema: 'lmfg.params.v2' }, 'schema'],
    ['an unknown field', { grain: 3 }, ''],
  ])('rejects stored params with %s', async (_name, patch, field) => {
    const { store, paths } = await writeCandidate()
    await rewriteJson(paths.params, (doc) => ({ ...doc, ...patch }))
    await expect(
      store.readCandidateParams('iter_0001', 'cand_0001'),
    ).rejects.toMatchObject(
      storedRecordFailure('schema.invalid', paths.params, field),
    )
  })

  it('rejects a tampered candidate manifest', async () => {
    const { store, paths } = await writeCandidate()
    await rewriteJson(paths.manifest, (doc) => ({
      ...doc,
      render_params: {
        ...(doc.render_params as object),
        exposure_ev: 2,
      },
    }))
    await expect(
      store.readCandidateManifest('iter_0001', 'cand_0001'),
    ).rejects.toMatchObject(
      storedRecordFailure(
        'manifest.invalid',
        paths.manifest,
        'manifest_sha256',
      ),
    )
  })
})
