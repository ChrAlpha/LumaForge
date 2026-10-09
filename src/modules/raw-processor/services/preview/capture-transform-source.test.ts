import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import type { ColorGraphIntent } from '@lumaforge/luma-color-runtime'
import {
  NEUTRAL_SELECTIVE_COLOR,
  NEUTRAL_USER_COLOR_INTENT,
} from '@lumaforge/luma-color-runtime'
import { describe, expect, it, vi } from 'vitest'

import type { DecodedPreviewFrame } from '~/lib/preview/preview-frame'

import {
  captureTransformSource,
  decodedFrameIdentity,
  transformInputKey,
} from './capture-transform-source'

const INTENT: ColorGraphIntent = {
  ...NEUTRAL_USER_COLOR_INTENT,
  styleKind: 'custom',
  builtinPreset: null,
  intensity: 0.37,
}

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
    const key = transformInputKey(FRAME, 1, INTENT)
    // A legacy record that still carries view fields keys the same.
    expect(
      transformInputKey(FRAME, 1, {
        ...INTENT,
        viewMode: 'compare',
        compareSplit: 0.2,
      } as ColorGraphIntent),
    ).toBe(key)
    expect(
      transformInputKey(FRAME, 1, { ...INTENT, userExposureEv: 1 }),
    ).not.toBe(key)
    expect(transformInputKey(FRAME, 2, INTENT)).not.toBe(key)
    expect(
      transformInputKey(
        { ...FRAME, frameId: 'decoded-frame-2', stage: 'bounded-hq' },
        1,
        INTENT,
      ),
    ).not.toBe(key)
  })

  it('keys the decoded source by the accepted frame identity alone', () => {
    const key = transformInputKey(FRAME, 1, INTENT)
    // Another descriptor object naming the same accepted frame is that frame.
    expect(transformInputKey({ ...FRAME }, 1, INTENT)).toBe(key)
    // A frame decoded again for the same source is a new frame, however
    // alike its size and exposure are.
    expect(
      transformInputKey({ ...FRAME, frameId: 'decoded-frame-7' }, 1, INTENT),
    ).not.toBe(key)
    // So is the same frame ID minted for another source session.
    expect(
      transformInputKey({ ...FRAME, sessionId: 'session-b' }, 1, INTENT),
    ).not.toBe(key)
    // No accepted frame names no decoded source.
    expect(transformInputKey(null, 1, INTENT)).not.toBe(key)
    expect(decodedFrameIdentity(null)).not.toBe(decodedFrameIdentity(FRAME))
    expect(decodedFrameIdentity({ ...FRAME })).toBe(decodedFrameIdentity(FRAME))
  })

  it('keys every continuous color input the frame is drawn with', () => {
    const key = transformInputKey(FRAME, 1, INTENT)
    expect(
      transformInputKey(FRAME, 1, { ...INTENT, intensity: 0.62 }),
    ).not.toBe(key)
    expect(
      transformInputKey(FRAME, 1, { ...INTENT, intensity: 0.371 }),
    ).not.toBe(key)
    expect(
      transformInputKey(FRAME, 1, {
        ...INTENT,
        styleKind: 'builtin',
        builtinPreset: 'warm',
      }),
    ).not.toBe(key)
    expect(
      transformInputKey(FRAME, 1, {
        ...INTENT,
        selectiveColor: {
          ...NEUTRAL_SELECTIVE_COLOR,
          red: { ...NEUTRAL_SELECTIVE_COLOR.red, hue: 12 },
        },
      }),
    ).not.toBe(key)
  })

  it('keys the color as the graph reads it, not how the record is spelled', () => {
    const key = transformInputKey(FRAME, 1, INTENT)
    const { selectiveColor: _hsl, ...withoutHsl } = INTENT
    expect(transformInputKey(FRAME, 1, withoutHsl)).toBe(key)
    const reordered = Object.fromEntries(
      Object.entries(INTENT).reverse(),
    ) as unknown as ColorGraphIntent
    expect(transformInputKey(FRAME, 1, reordered)).toBe(key)
  })
})

describe('current-photo transform source ownership', () => {
  it('bounds and types the frame with production helpers only', () => {
    const source = readFileSync(
      resolve(
        process.cwd(),
        'src/modules/raw-processor/services/preview/capture-transform-source.ts',
      ),
      'utf8',
    )
    expect(source).not.toMatch(/transform-demo/)
  })
})
