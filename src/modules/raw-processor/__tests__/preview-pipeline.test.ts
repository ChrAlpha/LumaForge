import type { ProgressivePreviewPlan } from '@lumaforge/render-engine/preview'
import { QUICK_PREVIEW_MAX_PIXELS } from '@lumaforge/render-engine/preview'
import { describe, expect, it, vi } from 'vitest'

import type { PreviewEvent } from '../services/preview/preview-pipeline'
import { runPreviewPipeline } from '../services/preview/preview-pipeline'

function decodePlan(maxOutputPixels = 12_000_000): ProgressivePreviewPlan {
  return {
    quick: {
      source: 'quick',
      maxOutputPixels: QUICK_PREVIEW_MAX_PIXELS,
      purpose: 'first-interactive-preview',
    },
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

function skipPlan(reason: string): ProgressivePreviewPlan {
  return {
    quick: {
      source: 'quick',
      maxOutputPixels: QUICK_PREVIEW_MAX_PIXELS,
      purpose: 'first-interactive-preview',
    },
    boundedHq: { kind: 'skip', reason },
  }
}

describe('runPreviewPipeline', () => {
  it('falls back to quick preview when embedded preview is unavailable', async () => {
    const onEvent = vi.fn()

    const result = await runPreviewPipeline({
      runtimeSession: {
        extractEmbeddedPreview: vi.fn().mockResolvedValue(null),
        decodeQuickRaw: vi.fn().mockResolvedValue({ width: 800, height: 600 }),
        decodeBoundedHqRaw: vi
          .fn()
          .mockResolvedValue({ width: 4000, height: 3000 }),
      },
      previewPlan: decodePlan(),
      onEvent,
    })
    await result.boundedHqPromise

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'quick-ready', width: 800, height: 600 }),
    )
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'bounded-hq-ready',
        width: 4000,
        height: 3000,
      }),
    )
  })

  it('passes the bounded-HQ upgrade target cap to runtime decode', async () => {
    const decodeBoundedHqRaw = vi
      .fn()
      .mockResolvedValue({ width: 3266, height: 2449 })

    const result = await runPreviewPipeline({
      runtimeSession: {
        extractEmbeddedPreview: vi.fn().mockResolvedValue(null),
        decodeQuickRaw: vi
          .fn()
          .mockResolvedValue({ width: 1600, height: 1000 }),
        decodeBoundedHqRaw,
      },
      previewPlan: decodePlan(8_000_000),
      onEvent: vi.fn(),
    })
    await result.boundedHqPromise

    expect(decodeBoundedHqRaw).toHaveBeenCalledWith({
      maxOutputPixels: 8_000_000,
    })
  })

  it('keeps the quick preview path observable when bounded HQ decode fails', async () => {
    const onEvent = vi.fn()

    const result = await runPreviewPipeline({
      runtimeSession: {
        extractEmbeddedPreview: vi.fn().mockResolvedValue(null),
        decodeQuickRaw: vi.fn().mockResolvedValue({ width: 800, height: 600 }),
        decodeBoundedHqRaw: vi
          .fn()
          .mockRejectedValue(new Error('decode failed')),
      },
      previewPlan: decodePlan(),
      onEvent,
    })
    await result.boundedHqPromise

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'quick-ready', width: 800, height: 600 }),
    )
    expect(onEvent).toHaveBeenCalledWith({
      type: 'bounded-hq-failed',
      errorCode: 'RAW_HQ_DECODE_FAILED',
    })
  })

  it('reports quick decode failure without marking quick or HQ preview ready', async () => {
    const onEvent = vi.fn()
    const decodeBoundedHqRaw = vi.fn()
    const error = Object.assign(new Error('quick decode failed'), {
      code: 'RAW_QUICK_DECODE_FAILED',
    })

    const result = await runPreviewPipeline({
      runtimeSession: {
        extractEmbeddedPreview: vi.fn().mockResolvedValue({
          width: 1600,
          height: 1067,
          data: new Uint8Array([1, 2, 3]),
          mimeType: 'image/jpeg',
        }),
        decodeQuickRaw: vi.fn().mockRejectedValue(error),
        decodeBoundedHqRaw,
      },
      previewPlan: decodePlan(),
      onEvent,
    })

    expect(result).toEqual({ boundedHqPromise: null })
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'embedded-ready' }),
    )
    expect(onEvent).toHaveBeenCalledWith({
      type: 'quick-failed',
      errorCode: 'RAW_QUICK_DECODE_FAILED',
      message: 'quick decode failed',
    })
    expect(onEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'quick-ready' }),
    )
    expect(onEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'bounded-hq-ready' }),
    )
    expect(decodeBoundedHqRaw).not.toHaveBeenCalled()
  })

  it('still runs quick decode after an embedded preview is found', async () => {
    const onEvent = vi.fn()
    const decodeQuickRaw = vi
      .fn()
      .mockResolvedValue({ width: 800, height: 600 })
    const embeddedData = new Uint8Array([1, 2, 3])

    const result = await runPreviewPipeline({
      runtimeSession: {
        extractEmbeddedPreview: vi.fn().mockResolvedValue({
          width: 1600,
          height: 1067,
          data: embeddedData,
          mimeType: 'image/jpeg',
          timings: { total: 8 },
        }),
        decodeQuickRaw,
        decodeBoundedHqRaw: vi
          .fn()
          .mockResolvedValue({ width: 4000, height: 3000 }),
      },
      previewPlan: decodePlan(),
      onEvent,
    })
    await result.boundedHqPromise

    expect(decodeQuickRaw).toHaveBeenCalledTimes(1)
    expect(onEvent.mock.calls[0][0]).toMatchObject({
      type: 'embedded-ready',
      width: 1600,
      height: 1067,
      data: embeddedData,
      mimeType: 'image/jpeg',
      timings: { total: 8 },
    })
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'quick-ready', width: 800, height: 600 }),
    )
  })

  it('emits embedded preview bytes before quick and bounded HQ decode events', async () => {
    const events: PreviewEvent[] = []
    const embeddedData = new Uint8Array([9, 8, 7])

    const result = await runPreviewPipeline({
      runtimeSession: {
        extractEmbeddedPreview: vi.fn().mockResolvedValue({
          width: 1600,
          height: 1067,
          data: embeddedData,
          mimeType: 'image/jpeg',
          timings: { total: 12, thumbnail: 4 },
        }),
        decodeQuickRaw: vi.fn().mockResolvedValue({ width: 800, height: 600 }),
        decodeBoundedHqRaw: vi
          .fn()
          .mockResolvedValue({ width: 4000, height: 3000 }),
      },
      previewPlan: decodePlan(),
      onEvent: (event) => events.push(event),
    })
    await result.boundedHqPromise

    expect(events.map((event) => event.type)).toEqual([
      'embedded-ready',
      'quick-ready',
      'bounded-hq-ready',
    ])
    expect(events[0]).toMatchObject({
      type: 'embedded-ready',
      width: 1600,
      height: 1067,
      data: embeddedData,
      mimeType: 'image/jpeg',
      timings: { total: 12, thumbnail: 4 },
    })
  })

  it('continues to quick decode when embedded preview extraction fails', async () => {
    const onEvent = vi.fn()
    const decodeQuickRaw = vi
      .fn()
      .mockResolvedValue({ width: 800, height: 600 })

    const result = await runPreviewPipeline({
      runtimeSession: {
        extractEmbeddedPreview: vi
          .fn()
          .mockRejectedValue(new Error('thumbnail unavailable')),
        decodeQuickRaw,
        decodeBoundedHqRaw: vi
          .fn()
          .mockResolvedValue({ width: 4000, height: 3000 }),
      },
      previewPlan: decodePlan(),
      onEvent,
    })
    await result.boundedHqPromise

    expect(decodeQuickRaw).toHaveBeenCalledTimes(1)
    expect(onEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'embedded-ready' }),
    )
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'quick-ready', width: 800, height: 600 }),
    )
  })

  it('preserves stable runtime error codes from bounded HQ failures', async () => {
    const onEvent = vi.fn()
    const error = Object.assign(new Error('cross-origin isolation required'), {
      code: 'RAW_CROSS_ORIGIN_ISOLATION_REQUIRED',
    })

    const result = await runPreviewPipeline({
      runtimeSession: {
        extractEmbeddedPreview: vi.fn().mockResolvedValue(null),
        decodeQuickRaw: vi.fn().mockResolvedValue({ width: 800, height: 600 }),
        decodeBoundedHqRaw: vi.fn().mockRejectedValue(error),
      },
      previewPlan: decodePlan(),
      onEvent,
    })
    await result.boundedHqPromise

    expect(onEvent).toHaveBeenCalledWith({
      type: 'bounded-hq-failed',
      errorCode: 'RAW_CROSS_ORIGIN_ISOLATION_REQUIRED',
    })
  })

  it('returns after quick preview while bounded HQ continues in the background', async () => {
    const events: PreviewEvent[] = []
    let resolveBoundedHq!: (value: { width: number; height: number }) => void
    const boundedHqPromise = new Promise<{ width: number; height: number }>(
      (resolve) => {
        resolveBoundedHq = resolve
      },
    )

    const result = await runPreviewPipeline({
      runtimeSession: {
        extractEmbeddedPreview: vi.fn().mockResolvedValue(null),
        decodeQuickRaw: vi
          .fn()
          .mockResolvedValue({ width: 1600, height: 1000 }),
        decodeBoundedHqRaw: vi.fn().mockReturnValue(boundedHqPromise),
      },
      previewPlan: decodePlan(),
      onEvent: (event) => events.push(event),
    })

    expect(events.map((event) => event.type)).toEqual(['quick-ready'])
    expect(result.boundedHqPromise).toBeInstanceOf(Promise)

    resolveBoundedHq({ width: 4000, height: 3000 })
    await result.boundedHqPromise

    expect(events.map((event) => event.type)).toEqual([
      'quick-ready',
      'bounded-hq-ready',
    ])
  })

  it('skips bounded HQ decode after quick preview when policy says to skip', async () => {
    const events: PreviewEvent[] = []
    const decodeBoundedHqRaw = vi.fn()
    const skipReason = 'Source fits within quick preview cap 2500000.'

    const result = await runPreviewPipeline({
      runtimeSession: {
        extractEmbeddedPreview: vi.fn().mockResolvedValue(null),
        decodeQuickRaw: vi.fn().mockResolvedValue({ width: 1200, height: 900 }),
        decodeBoundedHqRaw,
      },
      previewPlan: skipPlan(skipReason),
      onEvent: (event) => events.push(event),
    })

    expect(result).toEqual({ boundedHqPromise: null })
    expect(decodeBoundedHqRaw).not.toHaveBeenCalled()
    expect(events).toEqual([
      { type: 'quick-ready', width: 1200, height: 900 },
      { type: 'bounded-hq-skipped', reason: skipReason },
    ])
  })

  it('keeps quick preview when bounded HQ fails', async () => {
    const events: PreviewEvent[] = []
    const error = Object.assign(new Error('bounded failed'), {
      code: 'RAW_HQ_DECODE_FAILED',
    })

    const result = await runPreviewPipeline({
      runtimeSession: {
        extractEmbeddedPreview: vi.fn().mockResolvedValue(null),
        decodeQuickRaw: vi
          .fn()
          .mockResolvedValue({ width: 1600, height: 1000 }),
        decodeBoundedHqRaw: vi.fn().mockRejectedValue(error),
      },
      previewPlan: decodePlan(),
      onEvent: (event) => events.push(event),
    })

    await result.boundedHqPromise

    expect(events).toContainEqual({
      type: 'bounded-hq-failed',
      errorCode: 'RAW_HQ_DECODE_FAILED',
    })
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'quick-ready' }),
    )
  })
})
