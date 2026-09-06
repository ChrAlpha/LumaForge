import type { ProcessingParams } from '@lumaforge/luma-color-runtime'
import { describe, expect, it, vi } from 'vitest'

import {
  captureTransformSource,
  transformInputKey,
} from './capture-transform-source'

describe('current-photo transform source', () => {
  it('requests bounded processed pixels from the existing pipeline', async () => {
    const data = new Uint8ClampedArray(1600 * 1067 * 4).fill(120)
    const renderToHiddenCanvas = vi
      .fn()
      .mockResolvedValue({
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
          renderToHiddenCanvas: vi
            .fn()
            .mockResolvedValue({
              width: 50,
              height: 50,
              getContext: () => ({}),
            }),
        },
      }),
    ).rejects.toThrow('transform-source-unavailable')
  })

  it('refreshes for color, LUT and decode changes but not comparison movement', () => {
    const params = {
      userExposureEv: 0,
      viewMode: 'processed',
      compareSplit: 0.5,
    } as ProcessingParams
    const key = transformInputKey(1, 1, params)
    expect(
      transformInputKey(1, 1, {
        ...params,
        viewMode: 'compare',
        compareSplit: 0.2,
      }),
    ).toBe(key)
    expect(transformInputKey(1, 1, { ...params, userExposureEv: 1 })).not.toBe(
      key,
    )
    expect(transformInputKey(1, 2, params)).not.toBe(key)
    expect(transformInputKey(2, 1, params)).not.toBe(key)
  })
})
