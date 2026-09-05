// @vitest-environment node
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  loadSessionSource,
  loadSourceFile,
  verifySourceIdentity,
} from './source-loader'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lmfg-src-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('source loader', () => {
  it('reads bytes and computes the full-file sha256', async () => {
    const file = join(dir, 'a.dng')
    await writeFile(file, Buffer.from('hello raw'))
    const source = await loadSourceFile('a.dng', dir)
    expect(source.absolutePath).toBe(file)
    expect(source.filename).toBe('a.dng')
    expect(source.byteSize).toBe(9)
    expect(source.sha256).toBe(
      createHash('sha256').update('hello raw').digest('hex'),
    )
    expect(source.input).toEqual({ data: source.bytes, name: 'a.dng', size: 9 })
  })

  it('maps missing files and directories to argument errors', async () => {
    await expect(loadSourceFile('missing.dng', dir)).rejects.toMatchObject({
      code: 'file.not_found',
    })
    await expect(loadSourceFile('.', dir)).rejects.toMatchObject({
      code: 'args.invalid',
    })
  })

  it('verifies identity and reports mismatches', async () => {
    const file = join(dir, 'b.dng')
    await writeFile(file, Buffer.from('bytes'))
    const source = await loadSourceFile(file, dir)
    expect(() => verifySourceIdentity(source, source.sha256)).not.toThrow()
    expect(() => verifySourceIdentity(source, 'f'.repeat(64))).toThrow(
      expect.objectContaining({ code: 'hash.mismatch' }),
    )
  })

  it('loads the session source and verifies its identity', async () => {
    const file = join(dir, 'c.dng')
    await writeFile(file, Buffer.from('c'))
    const source = await loadSourceFile(file, dir)
    const record = {
      source: {
        path: file,
        filename: 'c.dng',
        byte_size: 1,
        sha256: source.sha256,
      },
    }
    expect((await loadSessionSource(record)).sha256).toBe(source.sha256)
    await expect(
      loadSessionSource({
        source: { ...record.source, sha256: '0'.repeat(64) },
      }),
    ).rejects.toMatchObject({ code: 'hash.mismatch' })
  })
})
