// @vitest-environment node
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createSessionStore } from './session-store'

const SHA = 'a'.repeat(64)
let root: string
beforeEach(async () => {
  root = join(await mkdtemp(join(tmpdir(), 'lmfg-ws-')), '.lmfg')
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('session store', () => {
  it('initializes a session with directories and identity file', async () => {
    const store = createSessionStore(root)
    const session = await store.init({
      sourcePath: '/photos/DSC0001.ARW',
      sha256: SHA,
      byteSize: 42,
      now: new Date('2026-09-05T00:00:00Z'),
      random: () => 'ffffff',
    })
    expect(session.id).toBe('sess_20260905T000000_ffffff')
    expect(session.source).toEqual({
      path: '/photos/DSC0001.ARW',
      filename: 'DSC0001.ARW',
      byte_size: 42,
      sha256: SHA,
    })
    expect(session.status).toBe('initialized')
    expect(
      (
        await stat(
          join(root, 'sessions', session.id, 'source', 'source.identity.json'),
        )
      ).isFile(),
    ).toBe(true)
    expect(
      (await stat(join(root, 'sessions', session.id, 'session.json'))).isFile(),
    ).toBe(true)
  })

  it('loads, lists, updates and allocates counters', async () => {
    const store = createSessionStore(root)
    const a = await store.init({
      sourcePath: '/p/a.dng',
      sha256: SHA,
      byteSize: 1,
      now: new Date('2026-09-05T00:00:00Z'),
      random: () => '000001',
    })
    const b = await store.init({
      sourcePath: '/p/b.dng',
      sha256: SHA,
      byteSize: 1,
      now: new Date('2026-09-05T00:00:01Z'),
      random: () => '000002',
    })
    expect((await store.list()).map((s) => s.id)).toEqual([a.id, b.id])
    expect(await store.allocate(a.id, 'iterations')).toBe(1)
    expect(await store.allocate(a.id, 'iterations')).toBe(2)
    const updated = await store.update(a.id, (rec) => ({
      ...rec,
      status: 'inspected',
      decoded_dimensions: { width: 10, height: 5 },
    }))
    expect(updated.status).toBe('inspected')
    expect((await store.load(a.id)).counters.iterations).toBe(2)
    await expect(store.load('sess_missing')).rejects.toMatchObject({
      code: 'session.not_found',
    })
  })
})
