/// <reference types="node" />
// @vitest-environment node

import { Buffer } from 'node:buffer'
import { createHash, randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'
import { beforeAll, describe, expect, expectTypeOf, it } from 'vitest'

import * as rootEntry from '../index'
import * as manifestEntry from './index'
import type { SourceContentIdResult } from './source-content-id'
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

describe('sourceContentIdFromFile (inputs and fallback)', () => {
  it('accepts a plain Blob, not only a File, and caches it by identity', async () => {
    const bytes = randomBytes(300)
    const blob = new Blob([bytes])
    const result = await sourceContentIdFromFile(blob)
    expect(result).toEqual({
      sha256: nodeSha256Hex(bytes),
      byteSize: bytes.byteLength,
    })
    expect(__TEST_ONLY__.fileCache?.get(blob)).toBe(result)
    expectTypeOf(sourceContentIdFromFile).parameter(0).toEqualTypeOf<Blob>()
    expectTypeOf(
      sourceContentIdFromFile,
    ).returns.resolves.toEqualTypeOf<SourceContentIdResult>()
  })

  it('hashes with the pure-JS fallback when WebCrypto is unavailable', async () => {
    const bytes = randomBytes(4099)
    const file = new File([bytes], 'fallback.bin')
    const ownSubtle = Object.getOwnPropertyDescriptor(
      globalThis.crypto,
      'subtle',
    )
    Object.defineProperty(globalThis.crypto, 'subtle', {
      configurable: true,
      value: undefined,
    })
    try {
      expect(globalThis.crypto.subtle).toBeUndefined()
      const result = await sourceContentIdFromFile(file)
      expect(result).toEqual({
        sha256: nodeSha256Hex(bytes),
        byteSize: bytes.byteLength,
      })
    } finally {
      if (ownSubtle) {
        Object.defineProperty(globalThis.crypto, 'subtle', ownSubtle)
      } else {
        Reflect.deleteProperty(globalThis.crypto, 'subtle')
      }
    }
    expect(globalThis.crypto.subtle).toBeDefined()
  })
})

describe('deprecated manifest helpers on the public entries', () => {
  const entries = {
    root: fileURLToPath(new URL('../index.ts', import.meta.url)),
    manifest: fileURLToPath(new URL('./index.ts', import.meta.url)),
  }

  let program: ts.Program

  beforeAll(() => {
    program = ts.createProgram({
      rootNames: Object.values(entries),
      options: {
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        target: ts.ScriptTarget.ESNext,
        noEmit: true,
        types: [],
      },
    })
  }, 30_000)

  /** The `@deprecated` text a consumer of `entry` sees on `name`, if any. */
  function deprecationOf(entry: string, name: string): string | null {
    const checker = program.getTypeChecker()
    const source = program.getSourceFile(entry)
    const moduleSymbol = source && checker.getSymbolAtLocation(source)
    const exported =
      moduleSymbol && checker.tryGetMemberInModuleExports(name, moduleSymbol)
    if (!exported) throw new Error(`${name} is not exported from ${entry}`)
    const declared =
      exported.flags & ts.SymbolFlags.Alias
        ? checker.getAliasedSymbol(exported)
        : exported
    const tag = declared
      .getJsDocTags(checker)
      .find((candidate) => candidate.name === 'deprecated')
    return tag ? ts.displayPartsToString(tag.text) : null
  }

  it('keeps the helpers exported, with the same values, from both entries', () => {
    expect(rootEntry.sourceContentIdFromFile).toBe(sourceContentIdFromFile)
    expect(manifestEntry.sourceContentIdFromFile).toBe(sourceContentIdFromFile)
    expect(rootEntry.sourceContentIdFromBytes).toBe(sourceContentIdFromBytes)
    expect(manifestEntry.sourceContentIdFromBytes).toBe(
      sourceContentIdFromBytes,
    )
  })

  it('marks the File helper deprecated on both entries', () => {
    for (const entry of Object.values(entries)) {
      // The replacement is real content hashing, never file metadata.
      expect(deprecationOf(entry, 'sourceContentIdFromFile')).toContain(
        'sourceContentIdFromBytes',
      )
    }
  })

  it('leaves the bytes helper and its result type supported', () => {
    for (const entry of Object.values(entries)) {
      expect(deprecationOf(entry, 'sourceContentIdFromBytes')).toBeNull()
      expect(deprecationOf(entry, 'SourceContentIdResult')).toBeNull()
    }
  })
})
