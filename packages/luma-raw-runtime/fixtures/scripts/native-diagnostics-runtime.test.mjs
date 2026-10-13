import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  diagnoseNativeFixture,
  normalizeMetadata,
} from './native-diagnostics-runtime.mjs'

const fixture = { name: 'pixel', file: 'pixel.dng' }
const supportedCapability = {
  supported: true,
  strategy: 'libraw-processed-window',
  width: 400,
  height: 300,
  windows: { librawProcessed: true },
}

function fakeRuntime({ capability = supportedCapability, preview = {} } = {}) {
  const calls = []
  const session = {
    probe: { make: 'Google', model: 'Pixel 8 Pro', width: 400, height: 300 },
    async extractEmbeddedPreview() {
      calls.push('thumbnail')
      return preview
    },
    async decodeQuick(options) {
      calls.push(['quick', options])
    },
    async decodeBoundedHq(options) {
      calls.push(['boundedHq', options])
    },
    async probeExportCapability() {
      calls.push('exportCapability')
      return capability
    },
    async readProcessedWindow(request) {
      calls.push(['processedWindow', request.outputRect])
    },
    dispose() {
      calls.push('dispose')
    },
  }
  return {
    calls,
    async init() {
      return { version: '9.9.9' }
    },
    async openSession(input, options) {
      calls.push(['open', input.data.byteLength, options])
      return session
    },
  }
}

describe('native diagnostics on the Node runtime', () => {
  let dir
  let fixturePath

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'luma-raw-diagnostics-'))
    fixturePath = path.join(dir, 'pixel.dng')
    await writeFile(fixturePath, new Uint8Array([1, 2, 3]))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('runs every stage on one session and disposes it', async () => {
    const runtime = fakeRuntime()

    const result = await diagnoseNativeFixture({ fixture, fixturePath, runtime })

    expect(runtime.calls).toEqual([
      ['open', 3, { maxOutputPixels: 2_500_000 }],
      'thumbnail',
      ['quick', { maxOutputPixels: 2_500_000 }],
      ['boundedHq', { maxOutputPixels: 8_000_000 }],
      'exportCapability',
      ['processedWindow', { x: 168, y: 118, width: 64, height: 64 }],
      'dispose',
    ])
    expect(result).toMatchObject({
      runtime: { version: '9.9.9', memoryProfile: 'desktop' },
      metadata: { make: 'Google', model: 'Pixel 8 Pro' },
      capability: supportedCapability,
    })
    expect(Object.values(result.stages).every((stage) => stage.ok)).toBe(true)
  })

  it('reports a missing thumbnail and skips the window read without export support', async () => {
    const runtime = fakeRuntime({
      capability: { supported: false, reasons: ['unsupported-sensor'] },
      preview: null,
    })

    const { stages } = await diagnoseNativeFixture({
      fixture,
      fixturePath,
      runtime,
    })

    expect(stages.thumbnail).toMatchObject({
      ok: false,
      message: 'thumbnail unavailable',
    })
    expect(stages.processedWindow).toMatchObject({
      ok: false,
      message:
        'processed-window not attempted because export capability is unsupported',
    })
    expect(runtime.calls).not.toContainEqual(
      expect.arrayContaining(['processedWindow']),
    )
  })

  it('marks every later stage not attempted when the session does not open', async () => {
    const runtime = {
      async init() {
        return { version: '9.9.9' }
      },
      async openSession() {
        throw Object.assign(new Error('open failed'), { code: 'RAW_OPEN_FAILED' })
      },
    }

    const { stages } = await diagnoseNativeFixture({
      fixture,
      fixturePath,
      runtime,
    })

    expect(stages.open).toMatchObject({
      ok: false,
      code: 'RAW_OPEN_FAILED',
    })
    expect(stages.quick).toMatchObject({
      ok: false,
      message: 'quick not attempted',
    })
  })

  it('keeps only report-safe metadata fields', () => {
    expect(
      normalizeMetadata({
        jobId: 'job',
        make: 'Google',
        width: 4080,
        iso: 100,
        thumbnail: { width: 640, height: 480, format: 'jpeg' },
      }),
    ).toEqual({
      make: 'Google',
      width: 4080,
      thumbnail: { width: 640, height: 480, format: 'jpeg' },
    })
  })
})
