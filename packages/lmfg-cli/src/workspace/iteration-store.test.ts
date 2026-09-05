// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { parseRenderParams } from '../schemas/params'
import { createIterationStore } from './iteration-store'

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
