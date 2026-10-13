import type { ColorGraphIntent } from '@lumaforge/luma-color-runtime'
import {
  generateIdentityLUT,
  NEUTRAL_SELECTIVE_COLOR,
  NEUTRAL_USER_COLOR_INTENT,
  toLUTData,
} from '@lumaforge/luma-color-runtime'
import { describe, expect, expectTypeOf, it, vi } from 'vitest'

import type { DecodedPreviewFrame } from '~/lib/preview/preview-frame'

import {
  captureTransformSource,
  transformInputKey,
} from './capture-transform-source'

const INTENT: ColorGraphIntent = {
  ...NEUTRAL_USER_COLOR_INTENT,
  styleKind: 'custom',
  builtinPreset: null,
  intensity: 0.37,
}

const LUT = toLUTData(generateIdentityLUT(2))

const FRAME: DecodedPreviewFrame = {
  sessionId: 'session-a',
  frameId: 'decoded-frame-1',
  stage: 'quick',
  width: 80,
  height: 60,
  exposure: {
    kind: 'source-pin',
    value: { ev: 0.5, multiplier: 2 ** 0.5, source: 'image-statistics' },
  },
  quickPredecessorFrameId: null,
}

describe('current-photo transform source', () => {
  it('keys a Transform frame by the complete color intent', () => {
    expectTypeOf(transformInputKey)
      .parameter(2)
      .toEqualTypeOf<ColorGraphIntent>()
  })

  it('requests bounded processed pixels from the existing pipeline', async () => {
    const data = new Uint8ClampedArray(1600 * 1067 * 4).fill(120)
    const renderToHiddenCanvas = vi.fn().mockResolvedValue({
      width: 1600,
      height: 1067,
      getContext: () => ({ getImageData: () => ({ data }) }),
    })
    const result = await captureTransformSource({
      width: 6000,
      height: 4000,
      pipeline: { renderToHiddenCanvas },
    })
    expect(renderToHiddenCanvas).toHaveBeenCalledWith({
      width: 1600,
      height: 1067,
    })
    expect(result.frame.data).toBe(data)
  })

  it('reads the snapshot back from a CPU-backed context', async () => {
    const data = new Uint8ClampedArray(4)
    const getContext = vi.fn(() => ({ getImageData: () => ({ data }) }))
    await captureTransformSource({
      width: 1,
      height: 1,
      pipeline: {
        renderToHiddenCanvas: vi
          .fn()
          .mockResolvedValue({ width: 1, height: 1, getContext }),
      },
    })
    expect(getContext).toHaveBeenCalledWith('2d', { willReadFrequently: true })
  })

  it('takes a CPU frame already at the Transform edge without a canvas', async () => {
    const createElement = vi.spyOn(document, 'createElement')
    const rgba = new Uint8ClampedArray(120 * 80 * 4).fill(7)
    const result = await captureTransformSource({
      width: 6000,
      height: 4000,
      cpuFrame: { width: 120, height: 80, rgba } as never,
    })
    expect(createElement).not.toHaveBeenCalled()
    expect(result.frame).toMatchObject({ width: 120, height: 80 })
    expect(result.frame.data).toEqual(rgba)
    expect(result.frame.data).not.toBe(rgba)
    createElement.mockRestore()
  })

  it('rejects missing or inconsistent capture output', async () => {
    await expect(
      captureTransformSource({ width: 100, height: 100 }),
    ).rejects.toThrow('transform-source-unavailable')
    await expect(
      captureTransformSource({
        width: 100,
        height: 100,
        pipeline: {
          renderToHiddenCanvas: vi.fn().mockResolvedValue({
            width: 50,
            height: 50,
            getContext: () => ({}),
          }),
        },
      }),
    ).rejects.toThrow('transform-source-unavailable')
  })

  it('refreshes for color, LUT and decode changes but not comparison movement', () => {
    const key = transformInputKey(FRAME, LUT, INTENT)
    // A legacy record that still carries view fields keys the same.
    expect(
      transformInputKey(FRAME, LUT, {
        ...INTENT,
        viewMode: 'compare',
        compareSplit: 0.2,
      } as ColorGraphIntent),
    ).toBe(key)
    expect(
      transformInputKey(FRAME, LUT, { ...INTENT, userExposureEv: 1 }),
    ).not.toBe(key)
    // A new LUT record is a new LUT, even over the same table.
    expect(transformInputKey(FRAME, { ...LUT }, INTENT)).not.toBe(key)
    expect(transformInputKey(FRAME, null, INTENT)).not.toBe(key)
    expect(
      transformInputKey(
        { ...FRAME, frameId: 'decoded-frame-2', stage: 'bounded-hq' },
        LUT,
        INTENT,
      ),
    ).not.toBe(key)
  })

  it('keys the decoded source by the accepted frame identity alone', () => {
    const key = transformInputKey(FRAME, LUT, INTENT)
    // Another descriptor object naming the same accepted frame is that frame.
    expect(transformInputKey({ ...FRAME }, LUT, INTENT)).toBe(key)
    // A frame decoded again for the same source is a new frame, however
    // alike its size and exposure are.
    expect(
      transformInputKey({ ...FRAME, frameId: 'decoded-frame-7' }, LUT, INTENT),
    ).not.toBe(key)
    // So is the same frame ID minted for another source session.
    expect(
      transformInputKey({ ...FRAME, sessionId: 'session-b' }, LUT, INTENT),
    ).not.toBe(key)
    // No accepted frame names no decoded source.
    expect(transformInputKey(null, LUT, INTENT)).not.toBe(key)
  })

  it('keys every continuous color input the frame is drawn with', () => {
    const key = transformInputKey(FRAME, LUT, INTENT)
    expect(
      transformInputKey(FRAME, LUT, { ...INTENT, intensity: 0.62 }),
    ).not.toBe(key)
    expect(
      transformInputKey(FRAME, LUT, { ...INTENT, intensity: 0.371 }),
    ).not.toBe(key)
    expect(
      transformInputKey(FRAME, LUT, {
        ...INTENT,
        styleKind: 'builtin',
        builtinPreset: 'warm',
      }),
    ).not.toBe(key)
    expect(
      transformInputKey(FRAME, LUT, {
        ...INTENT,
        selectiveColor: {
          ...NEUTRAL_SELECTIVE_COLOR,
          red: { ...NEUTRAL_SELECTIVE_COLOR.red, hue: 12 },
        },
      }),
    ).not.toBe(key)
  })

  it('keys the color as the graph reads it, not how the record is spelled', () => {
    const key = transformInputKey(FRAME, LUT, INTENT)
    const spelledNeutral: ColorGraphIntent = {
      ...INTENT,
      selectiveColor: structuredClone(NEUTRAL_SELECTIVE_COLOR),
    }
    expect(transformInputKey(FRAME, LUT, spelledNeutral)).toBe(key)
    const reordered = Object.fromEntries(
      Object.entries(INTENT).reverse(),
    ) as unknown as ColorGraphIntent
    expect(transformInputKey(FRAME, LUT, reordered)).toBe(key)
  })
})
