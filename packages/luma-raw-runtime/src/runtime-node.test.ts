/// <reference types="node" />

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { LumaRawRuntimeError } from './errors'
import { createLumaRawRuntimeForNode } from './runtime-node'

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const artifactsDir = resolve(packageDir, '..', 'luma-native-artifacts')
const NATIVE_AVAILABLE =
  existsSync(join(artifactsDir, 'native/desktop/luma_raw.wasm')) &&
  existsSync(join(artifactsDir, 'native/low-memory/luma_raw.wasm'))
const FIXTURE_PATH = join(
  packageDir,
  'fixtures/.cache/public/raw-pixls-iphone-se.dng',
)
const FIXTURE_AVAILABLE = existsSync(FIXTURE_PATH)

const describeWithNative = NATIVE_AVAILABLE ? describe : describe.skip
const describeWithFixture =
  NATIVE_AVAILABLE && FIXTURE_AVAILABLE ? describe : describe.skip

async function loadFixture(): Promise<{
  data: Uint8Array
  name: string
  size: number
}> {
  const buffer = await readFile(FIXTURE_PATH)
  return {
    data: new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength),
    name: 'raw-pixls-iphone-se.dng',
    size: buffer.byteLength,
  }
}

describeWithNative('createLumaRawRuntimeForNode (input validation)', () => {
  it('init returns runtime info', async () => {
    const runtime = await createLumaRawRuntimeForNode()
    try {
      const info = await runtime.init()
      expect(info.runtime).toBe('luma')
      expect(info.memoryProfile).toBe('desktop')
      expect(info.crossOriginIsolated).toBeTypeOf('boolean')
      expect(typeof info.version).toBe('string')
    } finally {
      runtime.dispose()
    }
  }, 30_000)

  it('honors memoryProfile=low-memory', async () => {
    const runtime = await createLumaRawRuntimeForNode({
      memoryProfile: 'low-memory',
    })
    try {
      const info = await runtime.init()
      expect(info.memoryProfile).toBe('low-memory')
    } finally {
      runtime.dispose()
    }
  }, 30_000)
})

describeWithFixture('createLumaRawRuntimeForNode (live decode)', () => {
  it('probes a DNG and returns metadata', async () => {
    const runtime = await createLumaRawRuntimeForNode()
    try {
      const input = await loadFixture()
      const probe = await runtime.probe(input)
      expect(probe.make).toMatch(/apple/i)
      expect(probe.width).toBeGreaterThan(0)
      expect(probe.height).toBeGreaterThan(0)
      expect(probe.supportLevel).not.toBe('unsupported')
    } finally {
      runtime.dispose()
    }
  }, 60_000)

  it('extracts an embedded preview from the DNG', async () => {
    const runtime = await createLumaRawRuntimeForNode()
    try {
      const input = await loadFixture()
      const preview = await runtime.extractEmbeddedPreview(input)
      expect(preview).not.toBeNull()
      expect(preview!.width).toBeGreaterThan(0)
      expect(preview!.height).toBeGreaterThan(0)
      expect(preview!.data).toBeInstanceOf(Uint8Array)
      expect(preview!.data.length).toBeGreaterThan(0)
    } finally {
      runtime.dispose()
    }
  }, 60_000)

  it('decodes a quick preview to RGB16', async () => {
    const runtime = await createLumaRawRuntimeForNode()
    try {
      const input = await loadFixture()
      const frame = await runtime.decodeQuick(input)
      expect(frame.layout).toBe('rgb')
      expect(frame.bitDepth).toBe(16)
      expect(frame.colorSpace).toBe('linear-prophoto-rgb')
      expect(frame.data).toBeInstanceOf(Uint16Array)
      expect(frame.data.length).toBe(frame.width * frame.height * 3)
    } finally {
      runtime.dispose()
    }
  }, 60_000)

  it('openSession exposes a session API and reports metadata up front', async () => {
    const runtime = await createLumaRawRuntimeForNode()
    try {
      const input = await loadFixture()
      const session = await runtime.openSession(input)
      try {
        expect(session.sessionId).toMatch(/^raw-session-/)
        expect(session.probe.make).toMatch(/apple/i)
        expect(session.probe.supportLevel).not.toBe('unsupported')
        expect(typeof session.decodeQuick).toBe('function')
        expect(typeof session.extractEmbeddedPreview).toBe('function')
      } finally {
        session.dispose()
      }
    } finally {
      runtime.dispose()
    }
  }, 60_000)

  it('probes export capability with explicit native color and orientation facts', async () => {
    const runtime = await createLumaRawRuntimeForNode()
    try {
      const input = await loadFixture()
      const session = await runtime.openSession(input)
      try {
        const capability = await session.probeExportCapability()

        expect(capability.supported).toBe(true)
        expect(capability.reasons).toEqual([])
        expect(capability.orientation).toEqual({
          code: expect.any(Number),
          supported: true,
          outputWidth: capability.width,
          outputHeight: capability.height,
        })
        expect(capability.color).toEqual({
          workingSpace: 'linear-prophoto-rgb',
          librawOutputColor: 'prophoto',
          gamma: 'linear',
          cameraWhiteBalanceAppliedByRuntime: true,
          cameraMatrixAppliedByRuntime: true,
          whiteBalance: expect.any(Array),
          cameraToWorkingRgb: expect.any(Array),
        })
        expect(capability.color?.whiteBalance).toHaveLength(4)
        expect(capability.color?.cameraToWorkingRgb).toHaveLength(9)
        expect(session.probe.orientation).toBeTypeOf('number')
      } finally {
        session.dispose()
      }
    } finally {
      runtime.dispose()
    }
  }, 60_000)

  it('rejects an empty buffer with a typed runtime error', async () => {
    const runtime = await createLumaRawRuntimeForNode()
    try {
      await expect(
        runtime.probe({ data: new Uint8Array(0), name: 'empty.bin' }),
      ).rejects.toBeInstanceOf(LumaRawRuntimeError)
    } finally {
      runtime.dispose()
    }
  }, 30_000)

  it('honors AbortSignal that is already aborted before the call', async () => {
    const runtime = await createLumaRawRuntimeForNode()
    try {
      const input = await loadFixture()
      const controller = new AbortController()
      controller.abort()
      await expect(
        runtime.probe(input, controller.signal),
      ).rejects.toBeInstanceOf(LumaRawRuntimeError)
    } finally {
      runtime.dispose()
    }
  }, 30_000)
})

if (!NATIVE_AVAILABLE) {
  describe('createLumaRawRuntimeForNode — SKIPPED (native)', () => {
    it('native WASM missing; run native build or pnpm native:prepare', () => {
      expect(NATIVE_AVAILABLE).toBe(false)
    })
  })
} else if (!FIXTURE_AVAILABLE) {
  describe('createLumaRawRuntimeForNode (live decode) — SKIPPED', () => {
    it('fixture missing; run `pnpm fixtures:fetch-public` to populate it', () => {
      expect(FIXTURE_AVAILABLE).toBe(false)
    })
  })
}
