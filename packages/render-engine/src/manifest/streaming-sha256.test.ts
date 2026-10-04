/// <reference types="node" />
// @vitest-environment node

import { createHash, randomBytes } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { createStreamingSha256, sha256Hex } from './streaming-sha256'

function nodeSha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

describe('streaming-sha256 (FIPS 180-4 known vectors)', () => {
  it('matches the empty-string SHA-256 vector', () => {
    // FIPS 180-4 / NIST CAVS: SHA-256("")
    expect(sha256Hex(new Uint8Array(0))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
  })

  it('matches the "abc" vector', () => {
    expect(sha256Hex(utf8('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  it('matches the 1,000,000 "a" vector', () => {
    const millionAs = new Uint8Array(1_000_000).fill(0x61)
    expect(sha256Hex(millionAs)).toBe(
      'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
    )
  })

  it('matches the 448-bit message just shy of the padding boundary', () => {
    // 55 bytes: one byte short of the SHA-256 block-fill boundary at 56.
    const fiftyFive = utf8(
      'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
    )
    expect(sha256Hex(fiftyFive)).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    )
  })

  it('matches the 56-byte message that needs an extra padding block', () => {
    // 56 bytes: padding byte forces a second block.
    const fiftySix = utf8(
      'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopqr',
    )
    expect(sha256Hex(fiftySix.subarray(0, 56))).toBe(
      nodeSha256Hex(fiftySix.subarray(0, 56)),
    )
  })
})

describe('streaming-sha256 (chunk-size equivalence)', () => {
  // Streaming the same bytes in different chunk sizes must
  // produce an identical final digest, equal to a single one-shot
  // crypto.subtle.digest over the same bytes (node:crypto is the
  // canonical reference in Node).
  it('produces the same digest regardless of how chunks are split', () => {
    const sizes = [0, 1, 13, 55, 56, 63, 64, 65, 128, 4096, 100_003]
    for (const size of sizes) {
      const bytes = randomBytes(size)
      const expected = nodeSha256Hex(bytes)

      const chunkSizes = [1, 7, 17, 64, 65, 113, 1024, size + 1, size]
      for (const chunkSize of chunkSizes) {
        if (chunkSize <= 0) continue
        const hasher = createStreamingSha256()
        for (let offset = 0; offset < bytes.length; offset += chunkSize) {
          hasher.update(
            bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)),
          )
        }
        expect(hasher.digestHex()).toBe(expected)
      }
    }
  })

  it('handles a typical OPFS-style chunked write of 1 MB random bytes', () => {
    const bytes = randomBytes(1 << 20)
    const expected = nodeSha256Hex(bytes)
    const hasher = createStreamingSha256()
    // 17-byte and 64-KiB chunks, alternating — exercises buffer-fill +
    // direct-block paths in update().
    let offset = 0
    let toggle = false
    while (offset < bytes.length) {
      const chunk = toggle ? 17 : 1 << 16
      hasher.update(
        bytes.subarray(offset, Math.min(offset + chunk, bytes.length)),
      )
      offset += chunk
      toggle = !toggle
    }
    expect(hasher.digestHex()).toBe(expected)
  })
})

describe('streaming-sha256 (API contract)', () => {
  it('returns the same digest from repeated digest() calls', () => {
    const hasher = createStreamingSha256().update(utf8('hello world'))
    const a = hasher.digestHex()
    const b = hasher.digestHex()
    expect(a).toBe(b)
    expect(a).toBe(nodeSha256Hex(utf8('hello world')))
  })

  it('rejects update() after digest()', () => {
    const hasher = createStreamingSha256().update(utf8('frozen'))
    hasher.digest()
    expect(() => hasher.update(utf8('more'))).toThrow(
      /SHA256_FINALIZED|STREAMING_SHA256_FINALIZED/,
    )
  })

  it('digest() returns a fresh buffer each call (caller cannot mutate state)', () => {
    const hasher = createStreamingSha256().update(utf8('abc'))
    const first = hasher.digest()
    first[0] = 0
    const second = hasher.digest()
    expect(second[0]).not.toBe(0)
  })
})
