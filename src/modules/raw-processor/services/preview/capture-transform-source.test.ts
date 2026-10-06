import type { ColorGraphIntent } from '@lumaforge/luma-color-runtime'
import {
  NEUTRAL_SELECTIVE_COLOR,
  NEUTRAL_USER_COLOR_INTENT,
} from '@lumaforge/luma-color-runtime'
import { describe, expect, it, vi } from 'vitest'

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

describe('current-photo transform source', () => {
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
      name: 'current.nef',
      pipeline: { renderToHiddenCanvas },
    })
    expect(renderToHiddenCanvas).toHaveBeenCalledWith({
      width: 1600,
      height: 1067,
    })
    expect(result.frame.data).toBe(data)
    expect(result.name).toBe('current.nef')
  })

  it('rejects missing or inconsistent capture output', async () => {
    await expect(
      captureTransformSource({ width: 100, height: 100, name: 'x' }),
    ).rejects.toThrow('transform-source-unavailable')
    await expect(
      captureTransformSource({
        width: 100,
        height: 100,
        name: 'x',
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
    const key = transformInputKey(1, 1, INTENT)
    // A legacy record that still carries view fields keys the same.
    expect(
      transformInputKey(1, 1, {
        ...INTENT,
        viewMode: 'compare',
        compareSplit: 0.2,
      } as ColorGraphIntent),
    ).toBe(key)
    expect(transformInputKey(1, 1, { ...INTENT, userExposureEv: 1 })).not.toBe(
      key,
    )
    expect(transformInputKey(1, 2, INTENT)).not.toBe(key)
    expect(transformInputKey(2, 1, INTENT)).not.toBe(key)
  })

  it('keys every continuous color input the frame is drawn with', () => {
    const key = transformInputKey(1, 1, INTENT)
    expect(transformInputKey(1, 1, { ...INTENT, intensity: 0.62 })).not.toBe(
      key,
    )
    expect(transformInputKey(1, 1, { ...INTENT, intensity: 0.371 })).not.toBe(
      key,
    )
    expect(
      transformInputKey(1, 1, {
        ...INTENT,
        styleKind: 'builtin',
        builtinPreset: 'warm',
      }),
    ).not.toBe(key)
    expect(
      transformInputKey(1, 1, {
        ...INTENT,
        selectiveColor: {
          ...NEUTRAL_SELECTIVE_COLOR,
          red: { ...NEUTRAL_SELECTIVE_COLOR.red, hue: 12 },
        },
      }),
    ).not.toBe(key)
  })

  it('keys the color as the graph reads it, not how the record is spelled', () => {
    const key = transformInputKey(1, 1, INTENT)
    const { selectiveColor: _hsl, ...withoutHsl } = INTENT
    expect(transformInputKey(1, 1, withoutHsl)).toBe(key)
    const reordered = Object.fromEntries(
      Object.entries(INTENT).reverse(),
    ) as unknown as ColorGraphIntent
    expect(transformInputKey(1, 1, reordered)).toBe(key)
  })
})
