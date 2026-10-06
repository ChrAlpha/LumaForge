// @vitest-environment node

import { resolveRawRenderExposure } from '@lumaforge/luma-color-runtime'
import {
  BOUNDED_HQ_PREVIEW_MAX_PIXELS,
  QUICK_PREVIEW_MAX_PIXELS,
} from '@lumaforge/render-engine/preview'
import { describe, expect, it } from 'vitest'

import type { LmfgRuntime } from '../runtime/node-runtime'
import { createLmfgRuntime } from '../runtime/node-runtime'
import type { LoadedSource } from '../runtime/source-loader'
import { loadSourceFile } from '../runtime/source-loader'
import { parseRenderParams } from '../schemas/params'
import {
  describeWithFixture,
  FIXTURE_PATH,
} from '../test-support/describe-with-fixture'
import { renderPreview } from './preview'

describeWithFixture('renderPreview', () => {
  it('decodes a quick frame, renders through the CPU graph, and encodes a JPEG', async () => {
    const runtime = createLmfgRuntime({ memoryProfile: 'desktop' })
    try {
      const source = await loadSourceFile(FIXTURE_PATH, '/')
      const result = await renderPreview({
        runtime,
        source,
        params: parseRenderParams({ contrast: 20 }),
        lut: null,
        maxPixels: 500_000,
        quality: 0.8,
      })
      expect(result.frame.decode).toBe('quick')
      expect(result.frame.width * result.frame.height).toBeLessThanOrEqual(
        500_000,
      )
      expect(result.rendered.jpeg[0]).toBe(0xFF)
      expect(result.rendered.jpeg[1]).toBe(0xD8)
      expect(result.rendered.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(result.exposure.source).toBe('dng-baseline')
      expect(result.rendered.rgba.length).toBe(
        result.frame.width * result.frame.height * 4,
      )
    } finally {
      runtime.dispose()
    }
  }, 60_000)
})

/** A uniform linear RGB frame; its auto EV is log2(0.75 / level). */
function uniformFrame(width: number, height: number, level: number) {
  return {
    data: new Uint16Array(width * height * 3).fill(Math.round(level * 65535)),
    width,
    height,
  }
}

// Each decode has different statistics, so an EV measured on the wrong frame
// shows up as a different value.
const SMALL_QUICK = uniformFrame(4, 3, 0.2)
const STANDARD_QUICK = uniformFrame(8, 6, 0.3)
const BOUNDED_HQ = uniformFrame(16, 12, 0.5)
const STANDARD_AUTO = resolveRawRenderExposure({
  metadata: {},
  image: STANDARD_QUICK,
})

type DecodeCall = { stage: 'quick' | 'bounded-hq'; maxOutputPixels?: number }

function fakeRuntime(
  options: {
    baselineExposure?: number
    onDecode?: (call: DecodeCall, signal?: AbortSignal) => void
  } = {},
) {
  const calls: DecodeCall[] = []
  let disposed = 0
  let encoders = 0
  const frame = (
    stage: DecodeCall['stage'],
    image: ReturnType<typeof uniformFrame>,
  ) => ({ ...image, source: stage, metadata: {} })
  const session = {
    probe: { baselineExposure: options.baselineExposure },
    probeExportCapability: async () => ({
      supported: true,
      width: 64,
      height: 48,
      reasons: [],
    }),
    decodeQuick: async (
      quick: { maxOutputPixels?: number } = {},
      signal?: AbortSignal,
    ) => {
      const call: DecodeCall = {
        stage: 'quick',
        maxOutputPixels: quick.maxOutputPixels,
      }
      calls.push(call)
      options.onDecode?.(call, signal)
      return frame(
        'quick',
        quick.maxOutputPixels === QUICK_PREVIEW_MAX_PIXELS
          ? STANDARD_QUICK
          : SMALL_QUICK,
      )
    },
    decodeBoundedHq: async (
      hq: { maxOutputPixels: number },
      signal?: AbortSignal,
    ) => {
      const call: DecodeCall = {
        stage: 'bounded-hq',
        maxOutputPixels: hq.maxOutputPixels,
      }
      calls.push(call)
      options.onDecode?.(call, signal)
      return frame('bounded-hq', BOUNDED_HQ)
    },
    dispose: () => {
      disposed += 1
    },
  }
  const runtime = {
    memoryProfile: 'desktop',
    raw: async () => ({ openSession: async () => session }),
    jpeg: async () => ({
      createEncoder: () => {
        encoders += 1
        return {
          writeRows: async () => {},
          finish: async () => new Uint8Array([0xFF, 0xD8, 0xFF, 0xD9]),
          abort: () => {},
        }
      },
    }),
    dispose: () => {},
  } as unknown as LmfgRuntime
  return {
    runtime,
    calls,
    disposed: () => disposed,
    encoders: () => encoders,
  }
}

const SOURCE = { input: {} } as unknown as LoadedSource

describe('renderPreview automatic exposure', () => {
  async function render(
    fake: ReturnType<typeof fakeRuntime>,
    maxPixels: number,
    params = parseRenderParams({}),
    extra: Partial<Parameters<typeof renderPreview>[0]> = {},
  ) {
    return renderPreview({
      runtime: fake.runtime,
      source: SOURCE,
      params,
      lut: null,
      maxPixels,
      quality: 0.8,
      ...extra,
    })
  }

  it('measures a small quick render on the standard quick frame', async () => {
    const fake = fakeRuntime()
    const result = await render(fake, 500_000)
    expect(result.frame).toMatchObject({ decode: 'quick', width: 4 })
    expect(result.exposure).toEqual(STANDARD_AUTO)
    expect(result.exposure.source).toBe('image-statistics')
    expect(fake.calls).toEqual([
      { stage: 'quick', maxOutputPixels: 500_000 },
      { stage: 'quick', maxOutputPixels: QUICK_PREVIEW_MAX_PIXELS },
    ])
    expect(result.timings.exposure_ms).toBeGreaterThanOrEqual(0)
    expect(fake.disposed()).toBe(1)
  })

  it('reuses the standard quick render instead of decoding it again', async () => {
    const fake = fakeRuntime()
    const result = await render(fake, QUICK_PREVIEW_MAX_PIXELS)
    expect(result.exposure).toEqual(STANDARD_AUTO)
    expect(fake.calls).toEqual([
      { stage: 'quick', maxOutputPixels: QUICK_PREVIEW_MAX_PIXELS },
    ])
    expect(result.timings.exposure_ms).toBeUndefined()
  })

  it('measures a bounded HQ render on the standard quick frame', async () => {
    const fake = fakeRuntime()
    const result = await render(fake, BOUNDED_HQ_PREVIEW_MAX_PIXELS)
    expect(result.frame).toMatchObject({ decode: 'bounded-hq', width: 16 })
    expect(result.exposure).toEqual(STANDARD_AUTO)
    expect(fake.calls).toEqual([
      { stage: 'bounded-hq', maxOutputPixels: BOUNDED_HQ_PREVIEW_MAX_PIXELS },
      { stage: 'quick', maxOutputPixels: QUICK_PREVIEW_MAX_PIXELS },
    ])
  })

  it('resolves the same auto EV at every output size', async () => {
    const evs = []
    for (const maxPixels of [
      300_000,
      QUICK_PREVIEW_MAX_PIXELS,
      8_000_000,
      BOUNDED_HQ_PREVIEW_MAX_PIXELS,
    ]) {
      evs.push((await render(fakeRuntime(), maxPixels)).exposure)
    }
    expect(new Set(evs.map((exposure) => exposure.ev))).toEqual(
      new Set([STANDARD_AUTO.ev]),
    )
  })

  it('keeps an explicit raw-render exposure of zero without an extra decode', async () => {
    const fake = fakeRuntime()
    const result = await render(
      fake,
      500_000,
      parseRenderParams({ raw_render_exposure: 0 }),
    )
    expect(result.exposure).toEqual({ ev: 0, multiplier: 1, source: 'user' })
    expect(fake.calls).toEqual([{ stage: 'quick', maxOutputPixels: 500_000 }])
  })

  it('keeps a recorded exposure without an extra decode', async () => {
    const fake = fakeRuntime()
    const recorded = {
      ev: 1.25,
      multiplier: 2 ** 1.25,
      source: 'image-statistics' as const,
    }
    const result = await render(
      fake,
      BOUNDED_HQ_PREVIEW_MAX_PIXELS,
      undefined,
      {
        exposure: recorded,
      },
    )
    expect(result.exposure).toEqual(recorded)
    expect(fake.calls.map((call) => call.stage)).toEqual(['bounded-hq'])
  })

  it('takes the DNG baseline exposure without decoding the standard quick frame', async () => {
    const fake = fakeRuntime({ baselineExposure: -0.5 })
    const result = await render(fake, BOUNDED_HQ_PREVIEW_MAX_PIXELS)
    expect(result.exposure).toMatchObject({ ev: -0.5, source: 'dng-baseline' })
    expect(fake.calls.map((call) => call.stage)).toEqual(['bounded-hq'])
  })

  it('stops and disposes the session when aborted during the exposure decode', async () => {
    const controller = new AbortController()
    const fake = fakeRuntime({
      onDecode: (call, signal) => {
        if (call.maxOutputPixels !== QUICK_PREVIEW_MAX_PIXELS) return
        controller.abort()
        signal?.throwIfAborted()
      },
    })
    await expect(
      render(fake, 500_000, undefined, { signal: controller.signal }),
    ).rejects.toThrow()
    expect(fake.calls).toHaveLength(2)
    expect(fake.encoders()).toBe(0)
    expect(fake.disposed()).toBe(1)
  })
})
