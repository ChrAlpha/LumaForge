import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { preserveJpegMetadataBytes } from '@lumaforge/render-engine/export'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  assertJpegFile,
  createStreamingJpegFileWriter,
} from './jpeg-file-writer'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lmfg-jpeg-writer-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const metadata = { make: 'Fujifilm', model: 'GFX100RF', iso: 100 }

/** A JPEG-shaped stream large enough to cross the 64 KiB header scan. */
function fakeJpeg(size: number): Uint8Array {
  const bytes = new Uint8Array(size)
  bytes.set([0xFF, 0xD8, 0xFF, 0xDB, 0x00, 0x02])
  for (let i = 6; i < size - 2; i += 1) bytes[i] = (i * 31) & 0xFF
  bytes.set([0xFF, 0xD9], size - 2)
  return bytes
}

function chunk(bytes: Uint8Array, sizes: number[]): Uint8Array[] {
  const parts: Uint8Array[] = []
  let offset = 0
  for (const size of sizes) {
    parts.push(bytes.subarray(offset, offset + size))
    offset += size
  }
  parts.push(bytes.subarray(offset))
  return parts
}

describe('createStreamingJpegFileWriter', () => {
  it('produces the same bytes and hash as the in-memory metadata injection', async () => {
    for (const size of [1_000, 70_000, 200_000]) {
      const source = fakeJpeg(size)
      const expected = preserveJpegMetadataBytes({
        jpeg: source,
        metadata,
        width: 4,
        height: 2,
      })
      const path = join(dir, `out-${size}.jpg`)
      const writer = createStreamingJpegFileWriter({
        path,
        metadata,
        width: 4,
        height: 2,
      })
      for (const part of chunk(source, [3, 100, 65_000, 1])) {
        await writer.write(part)
      }
      const result = await writer.finish()
      const onDisk = new Uint8Array(await readFile(path))
      expect(Buffer.compare(onDisk, expected)).toBe(0)
      expect(result.byteLength).toBe(expected.byteLength)
      expect(result.sha256).toBe(
        createHash('sha256').update(expected).digest('hex'),
      )
      expect(await readdir(dir)).not.toContainEqual(
        expect.stringMatching(/\.tmp$/),
      )
    }
  })

  it('refuses an incomplete stream and leaves nothing behind', async () => {
    const path = join(dir, 'broken.jpg')
    const writer = createStreamingJpegFileWriter({
      path,
      metadata: null,
      width: 4,
      height: 2,
    })
    await writer.write(new Uint8Array([0xFF, 0xD8, 0x00, 0x00]))
    await expect(writer.finish()).rejects.toMatchObject({
      code: 'export.refused',
      exitCode: 8,
    })
    expect(await readdir(dir)).toEqual([])
  })

  it('abort removes the partial file', async () => {
    const path = join(dir, 'aborted.jpg')
    const writer = createStreamingJpegFileWriter({
      path,
      metadata: null,
      width: 4,
      height: 2,
    })
    await writer.write(fakeJpeg(80_000).subarray(0, 70_000))
    await writer.abort()
    expect(await readdir(dir)).toEqual([])
    await expect(writer.write(new Uint8Array(1))).rejects.toThrow(
      'JPEG_FILE_WRITER_CLOSED',
    )
  })
})

describe('assertJpegFile', () => {
  it('accepts SOI…EOI files and rejects anything else', async () => {
    const ok = join(dir, 'ok.jpg')
    await writeFile(ok, fakeJpeg(64))
    await expect(assertJpegFile(ok)).resolves.toBeUndefined()
    const bad = join(dir, 'bad.jpg')
    await writeFile(bad, new Uint8Array([0xFF, 0xD8, 0x00]))
    await expect(assertJpegFile(bad)).rejects.toMatchObject({
      code: 'export.refused',
    })
  })
})
