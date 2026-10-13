import type { ProgressivePreviewPlan } from '@lumaforge/render-engine/preview'
import { QUICK_PREVIEW_MAX_PIXELS } from '@lumaforge/render-engine/preview'
import { describe, expect, it, vi } from 'vitest'

import type { PreviewEvent } from '../services/preview/preview-pipeline'
import { runPreviewPipeline } from '../services/preview/preview-pipeline'

const QUICK = {
  source: 'quick',
  maxOutputPixels: QUICK_PREVIEW_MAX_PIXELS,
  purpose: 'first-interactive-preview',
} as const

function decodePlan(maxOutputPixels = 12_000_000): ProgressivePreviewPlan {
  return {
    quick: QUICK,
    boundedHq: {
      kind: 'decode',
      target: {
        source: 'bounded-hq',
        maxOutputPixels,
        purpose: 'detail-upgrade',
        upgradesFrom: 'quick',
      },
    },
  }
}

const EMBEDDED = {
  width: 1600,
  height: 1067,
  data: new Uint8Array([9, 8, 7]),
  mimeType: 'image/jpeg',
  timings: { total: 12, thumbnail: 4 },
}

type RuntimeSession = Parameters<typeof runPreviewPipeline>[0]['runtimeSession']

function session(overrides: Partial<RuntimeSession> = {}): RuntimeSession {
  return {
    extractEmbeddedPreview: vi.fn().mockResolvedValue(null),
    decodeQuickRaw: vi.fn().mockResolvedValue({ width: 800, height: 600 }),
    decodeBoundedHqRaw: vi
      .fn()
      .mockResolvedValue({ width: 4000, height: 3000 }),
    ...overrides,
  }
}

async function run(
  runtimeSession: RuntimeSession,
  previewPlan: ProgressivePreviewPlan = decodePlan(),
) {
  const events: PreviewEvent[] = []
  const result = await runPreviewPipeline({
    runtimeSession,
    previewPlan,
    onEvent: (event) => events.push(event),
  })
  return { events, result }
}

describe('runPreviewPipeline', () => {
  it('emits the embedded bytes, then the quick frame, then the bounded-HQ frame', async () => {
    const { events, result } = await run(
      session({ extractEmbeddedPreview: vi.fn().mockResolvedValue(EMBEDDED) }),
    )
    await result.boundedHqPromise

    expect(events.map((event) => event.type)).toEqual([
      'embedded-ready',
      'quick-ready',
      'bounded-hq-ready',
    ])
    expect(events[0]).toMatchObject({ type: 'embedded-ready', ...EMBEDDED })
    expect(events[1]).toMatchObject({ width: 800, height: 600 })
    expect(events[2]).toMatchObject({ width: 4000, height: 3000 })
  })

  it.each([
    ['is unavailable', vi.fn().mockResolvedValue(null)],
    ['fails', vi.fn().mockRejectedValue(new Error('thumbnail unavailable'))],
  ])(
    'goes on to the quick frame when the embedded preview %s',
    async (_case, extractEmbeddedPreview) => {
      const { events, result } = await run(session({ extractEmbeddedPreview }))
      await result.boundedHqPromise

      expect(events.map((event) => event.type)).toEqual([
        'quick-ready',
        'bounded-hq-ready',
      ])
    },
  )

  it('hands the bounded-HQ target cap to the runtime decode', async () => {
    const decodeBoundedHqRaw = vi
      .fn()
      .mockResolvedValue({ width: 3266, height: 2449 })
    const { result } = await run(
      session({ decodeBoundedHqRaw }),
      decodePlan(8_000_000),
    )
    await result.boundedHqPromise

    expect(decodeBoundedHqRaw).toHaveBeenCalledWith({
      maxOutputPixels: 8_000_000,
    })
  })

  it('reports a quick decode failure without marking any frame ready or decoding HQ', async () => {
    const decodeBoundedHqRaw = vi.fn()
    const { events, result } = await run(
      session({
        extractEmbeddedPreview: vi.fn().mockResolvedValue(EMBEDDED),
        decodeQuickRaw: vi.fn().mockRejectedValue(
          Object.assign(new Error('quick decode failed'), {
            code: 'RAW_QUICK_DECODE_FAILED',
          }),
        ),
        decodeBoundedHqRaw,
      }),
    )

    expect(result).toEqual({ boundedHqPromise: null })
    expect(events.map((event) => event.type)).toEqual([
      'embedded-ready',
      'quick-failed',
    ])
    expect(events[1]).toEqual({
      type: 'quick-failed',
      errorCode: 'RAW_QUICK_DECODE_FAILED',
      message: 'quick decode failed',
    })
    expect(decodeBoundedHqRaw).not.toHaveBeenCalled()
  })

  it.each([
    ['a generic code', new Error('decode failed'), 'RAW_HQ_DECODE_FAILED'],
    [
      'its stable runtime code',
      Object.assign(new Error('cross-origin isolation required'), {
        code: 'RAW_CROSS_ORIGIN_ISOLATION_REQUIRED',
      }),
      'RAW_CROSS_ORIGIN_ISOLATION_REQUIRED',
    ],
  ])(
    'keeps the quick frame when bounded HQ fails, under %s',
    async (_case, error, errorCode) => {
      const { events, result } = await run(
        session({ decodeBoundedHqRaw: vi.fn().mockRejectedValue(error) }),
      )
      await result.boundedHqPromise

      expect(events).toEqual([
        { type: 'quick-ready', width: 800, height: 600 },
        { type: 'bounded-hq-failed', errorCode },
      ])
    },
  )

  it('returns after the quick frame while bounded HQ continues in the background', async () => {
    let resolveBoundedHq!: (value: { width: number; height: number }) => void
    const pending = new Promise<{ width: number; height: number }>(
      (resolve) => {
        resolveBoundedHq = resolve
      },
    )
    const { events, result } = await run(
      session({ decodeBoundedHqRaw: vi.fn().mockReturnValue(pending) }),
    )

    expect(events.map((event) => event.type)).toEqual(['quick-ready'])
    resolveBoundedHq({ width: 4000, height: 3000 })
    await result.boundedHqPromise
    expect(events.map((event) => event.type)).toEqual([
      'quick-ready',
      'bounded-hq-ready',
    ])
  })

  it('skips the bounded-HQ decode when the plan says to', async () => {
    const decodeBoundedHqRaw = vi.fn()
    const reason = 'Source fits within quick preview cap 2500000.'
    const { events, result } = await run(session({ decodeBoundedHqRaw }), {
      quick: QUICK,
      boundedHq: { kind: 'skip', reason },
    })

    expect(result).toEqual({ boundedHqPromise: null })
    expect(decodeBoundedHqRaw).not.toHaveBeenCalled()
    expect(events).toEqual([
      { type: 'quick-ready', width: 800, height: 600 },
      { type: 'bounded-hq-skipped', reason },
    ])
  })
})
