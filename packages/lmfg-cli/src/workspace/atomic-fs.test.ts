// @vitest-environment node
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { readJson, writeFileAtomic, writeJsonAtomic } from './atomic-fs'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lmfg-fs-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('atomic-fs', () => {
  it('writes files atomically and leaves no temp files', async () => {
    const target = join(dir, 'nested', 'out.bin')
    await writeFileAtomic(target, new Uint8Array([1, 2, 3]))
    expect([...(await readFile(target))]).toEqual([1, 2, 3])
    expect(await readdir(join(dir, 'nested'))).toEqual(['out.bin'])
  })

  it('round-trips JSON', async () => {
    const target = join(dir, 'a.json')
    await writeJsonAtomic(target, { b: 1, a: [true] })
    expect(await readJson<{ a: boolean[] }>(target)).toEqual({
      b: 1,
      a: [true],
    })
  })

  it('maps missing files to file.not_found', async () => {
    await expect(readJson(join(dir, 'missing.json'))).rejects.toMatchObject({
      code: 'file.not_found',
    })
  })
})
