/// <reference types="node" />
// @vitest-environment node

import { Buffer } from 'node:buffer'
import { createHash, randomBytes } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  __TEST_ONLY__,
  sourceContentIdFromBytes,
  sourceContentIdFromFile,
} from './source-content-id'

function nodeSha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

describe('sourceContentIdFromBytes', () => {
  it('matches node:crypto SHA-256 for known sizes', async () => {
    for (const size of [0, 1, 55, 56, 64, 65, 4096, 131_072]) {
      const bytes = randomBytes(size)
      const result = await sourceContentIdFromBytes(bytes)
      expect(result.byteSize).toBe(size)
      expect(result.sha256).toBe(nodeSha256Hex(bytes))
    }
  })

  it('returns a different sha256 when bytes differ by one bit', async () => {
    const a = randomBytes(1024)
    const b = new Uint8Array(a)
    b[37] = b[37] ^ 0x01
    const ra = await sourceContentIdFromBytes(a)
    const rb = await sourceContentIdFromBytes(b)
    expect(ra.sha256).not.toBe(rb.sha256)
  })
})

describe('sourceContentIdFromFile (cache by object identity)', () => {
  // Caching MUST be by source object identity
  // (WeakMap<File>), never by metadata. Fixture: two
  // files with identical {name, size, lastModified} but different bytes
  // produce different sha256.
  it('does not collide across distinct content with identical metadata', async () => {
    const aBytes = randomBytes(64)
    const bBytes = randomBytes(64)
    // sanity: random bytes are different
    expect(Buffer.compare(aBytes, bBytes)).not.toBe(0)

    // Construct two Files (Node 20+ provides global File) with the same
    // metadata but distinct content. They have distinct object identities
    // so the WeakMap cache cannot collide them.
    const meta = { type: 'image/x-raw', lastModified: 1_700_000_000_000 }
    const a = new File([aBytes], 'DSC0042.ARW', meta)
    const b = new File([bBytes], 'DSC0042.ARW', meta)

    expect(a.name).toBe(b.name)
    expect(a.size).toBe(b.size)
    expect(a.lastModified).toBe(b.lastModified)

    const ra = await sourceContentIdFromFile(a)
    const rb = await sourceContentIdFromFile(b)

    expect(ra.sha256).not.toBe(rb.sha256)
    expect(ra.sha256).toBe(nodeSha256Hex(aBytes))
    expect(rb.sha256).toBe(nodeSha256Hex(bBytes))
  })

  it('caches by File reference and returns the same result on repeat calls', async () => {
    const bytes = randomBytes(2048)
    const file = new File([bytes], 'fixture.bin', {
      type: 'application/octet-stream',
      lastModified: 1_700_000_000_000,
    })

    const first = await sourceContentIdFromFile(file)
    expect(__TEST_ONLY__.fileCache?.has(file)).toBe(true)

    const second = await sourceContentIdFromFile(file)
    expect(second).toEqual(first)
    // Identity check: cached object is returned, not a fresh allocation
    expect(second).toBe(__TEST_ONLY__.fileCache?.get(file))
  })

  it('treats two new File objects from the same Blob content as separate cache entries', async () => {
    const bytes = randomBytes(512)
    const fileA = new File([bytes], 'same-name.bin', {
      lastModified: 1_700_000_000_000,
    })
    const fileB = new File([bytes], 'same-name.bin', {
      lastModified: 1_700_000_000_000,
    })
    const ra = await sourceContentIdFromFile(fileA)
    const rb = await sourceContentIdFromFile(fileB)
    // Same content → same sha256 (content identity is what matters)
    expect(ra.sha256).toBe(rb.sha256)
    // But cache entries are separate (object identity)
    expect(__TEST_ONLY__.fileCache?.has(fileA)).toBe(true)
    expect(__TEST_ONLY__.fileCache?.has(fileB)).toBe(true)
  })
})
