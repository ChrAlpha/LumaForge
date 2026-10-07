/// <reference types="node" />
// @vitest-environment node

import { createHash, randomBytes } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import * as rootEntry from '../index'
import * as manifestEntry from './index'
import { sourceContentIdFromBytes } from './source-content-id'
import { createStreamingSha256 } from './streaming-sha256'

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

  it('hashes only the bytes a subarray view describes', async () => {
    const backing = randomBytes(4096)
    const view = backing.subarray(100, 3100)
    const result = await sourceContentIdFromBytes(view)
    expect(result).toEqual({
      sha256: nodeSha256Hex(view),
      byteSize: 3000,
    })
  })

  it('agrees with a Blob hashed chunk by chunk through the streaming SHA-256', async () => {
    const bytes = randomBytes(200_003)
    const blob = new Blob([bytes])
    const hasher = createStreamingSha256()
    const reader = blob.stream().getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      hasher.update(value)
    }
    const streamed = hasher.digestHex()
    const whole = await sourceContentIdFromBytes(bytes)
    expect(streamed).toBe(whole.sha256)
    expect(whole.byteSize).toBe(blob.size)
  })

  it('is exported with the same identity from the root and manifest entries', () => {
    expect(rootEntry.sourceContentIdFromBytes).toBe(sourceContentIdFromBytes)
    expect(manifestEntry.sourceContentIdFromBytes).toBe(
      sourceContentIdFromBytes,
    )
    expect(rootEntry.createStreamingSha256).toBe(createStreamingSha256)
    expect(manifestEntry.createStreamingSha256).toBe(createStreamingSha256)
  })
})
