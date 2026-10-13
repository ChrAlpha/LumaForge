import type { RawRenderExposure } from '@lumaforge/luma-color-runtime'
import { resolveRawRenderExposure } from '@lumaforge/luma-color-runtime'
import type { LumaRawFrame } from '@lumaforge/luma-raw-runtime'
import { describe, expect, it } from 'vitest'

import { frameToDecodedImage } from './decoded-image'

function makeFrame(
  level: number,
  metadata: Partial<LumaRawFrame['metadata']> = {},
): LumaRawFrame {
  const width = 4
  const height = 4
  return {
    jobId: 'quick-job',
    sessionId: 'session-1',
    source: 'quick',
    width,
    height,
    data: new Uint16Array(width * height * 3).fill(level),
    layout: 'rgb',
    bitDepth: 16,
    colorSpace: 'linear-prophoto-rgb',
    orientation: 1,
    metadata: { supportLevel: 'experimental', ...metadata },
    timings: { total: 1 },
  }
}

function estimateFor(frame: LumaRawFrame): RawRenderExposure {
  return resolveRawRenderExposure({
    metadata: { baselineExposure: frame.metadata.baselineExposure },
    image: { data: frame.data, width: frame.width, height: frame.height },
  })
}

describe('frameToDecodedImage', () => {
  it('keeps the RGB16 Linear ProPhoto frame data and maps its metadata', () => {
    const frame = makeFrame(20_000, { make: 'Sony', model: 'A7' })

    const image = frameToDecodedImage(frame)

    expect(image.data).toBe(frame.data)
    expect(image).toMatchObject({
      width: 4,
      height: 4,
      channels: 3,
      bitsPerChannel: 16,
      layout: 'rgb-u16',
      colorSpace: 'linear-prophoto-rgb',
      source: 'quick',
      metadata: {
        make: 'Sony',
        model: 'A7',
        width: 4,
        height: 4,
        orientation: 1,
      },
    })
  })

  it('estimates exposure from the image unless DNG baseline exposure is present', () => {
    const statistical = frameToDecodedImage(makeFrame(20_000))
    const baseline = frameToDecodedImage(
      makeFrame(20_000, { baselineExposure: 1 }),
    )

    expect(statistical.renderExposure).toEqual(estimateFor(makeFrame(20_000)))
    expect(statistical.renderExposure.source).toBe('image-statistics')
    expect(baseline.renderExposure).toEqual({
      ev: 1,
      multiplier: 2,
      source: 'dng-baseline',
    })
  })

  it('carries a pinned exposure, zero included, as a copy instead of re-estimating', () => {
    const frame = makeFrame(40_000)
    const zero: RawRenderExposure = {
      ev: 0,
      multiplier: 1,
      source: 'image-statistics',
    }

    const image = frameToDecodedImage(frame, { pinnedExposure: zero })

    expect(estimateFor(frame).ev).not.toBe(0)
    expect(image.renderExposure).toEqual(zero)
    expect(image.renderExposure).not.toBe(zero)
  })
})
