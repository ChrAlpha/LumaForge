// @vitest-environment node
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { loadNativeModuleForNode } from './load-for-node.mjs'

const RAW_DESKTOP_WASM = fileURLToPath(
  new URL('./native/desktop/luma_raw.wasm', import.meta.url),
)
const RAW_LOW_MEMORY_WASM = fileURLToPath(
  new URL('./native/low-memory/luma_raw.wasm', import.meta.url),
)
const JPEG_WASM = fileURLToPath(
  new URL('./native/luma_jpeg.wasm', import.meta.url),
)

const ARTIFACTS_PRESENT =
  existsSync(RAW_DESKTOP_WASM) &&
  existsSync(RAW_LOW_MEMORY_WASM) &&
  existsSync(JPEG_WASM)

describe('loadNativeModuleForNode (input validation)', () => {
  it('rejects missing options', async () => {
    await expect(loadNativeModuleForNode()).rejects.toThrow(
      /options must be an object/,
    )
  })

  it('rejects null options', async () => {
    await expect(loadNativeModuleForNode(null)).rejects.toThrow(
      /options must be an object/,
    )
  })

  it('rejects unknown kind', async () => {
    await expect(loadNativeModuleForNode({ kind: 'banana' })).rejects.toThrow(
      /kind must be/,
    )
  })

  it('rejects an empty or non-path nativeDir', async () => {
    for (const nativeDir of ['', 42]) {
      await expect(
        loadNativeModuleForNode({ kind: 'jpeg', nativeDir }),
      ).rejects.toThrow(/nativeDir/)
    }
  })

  it('rejects unknown memoryProfile for raw', async () => {
    await expect(
      loadNativeModuleForNode({ kind: 'raw', memoryProfile: 'huge' }),
    ).rejects.toThrow(/memoryProfile must be/)
  })
})

const describeWithArtifacts = ARTIFACTS_PRESENT ? describe : describe.skip

describeWithArtifacts('loadNativeModuleForNode (live)', () => {
  it(
    'loads raw/desktop and exposes LumaRawProcessor',
    async () => {
      const m = await loadNativeModuleForNode({
        kind: 'raw',
        memoryProfile: 'desktop',
      })
      expect(typeof m).toBe('object')
      expect(typeof m.LumaRawProcessor).toBe('function')
    },
    20_000,
  )

  it(
    'loads raw/low-memory and exposes LumaRawProcessor',
    async () => {
      const m = await loadNativeModuleForNode({
        kind: 'raw',
        memoryProfile: 'low-memory',
      })
      expect(typeof m.LumaRawProcessor).toBe('function')
    },
    20_000,
  )

  it(
    'defaults memoryProfile to desktop when kind=raw',
    async () => {
      const m = await loadNativeModuleForNode({ kind: 'raw' })
      expect(typeof m.LumaRawProcessor).toBe('function')
    },
    20_000,
  )

  it(
    'loads from an explicit nativeDir with the packaged layout',
    async () => {
      const m = await loadNativeModuleForNode({
        kind: 'raw',
        nativeDir: fileURLToPath(new URL('./native', import.meta.url)),
      })
      expect(typeof m.LumaRawProcessor).toBe('function')
    },
    20_000,
  )

  it(
    'loads jpeg and exposes LumaJpegEncoder',
    async () => {
      const m = await loadNativeModuleForNode({ kind: 'jpeg' })
      expect(typeof m).toBe('object')
      expect(typeof m.LumaJpegEncoder).toBe('function')
    },
    20_000,
  )
})

if (!ARTIFACTS_PRESENT) {
  describe('loadNativeModuleForNode (live) — SKIPPED', () => {
    it('artifacts missing; run `pnpm native:prepare` to populate native/', () => {
      expect(ARTIFACTS_PRESENT).toBe(false)
    })
  })
}
