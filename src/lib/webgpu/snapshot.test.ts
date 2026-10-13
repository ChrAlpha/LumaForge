import { LUT_SIZE } from '@lumaforge/luma-color-runtime'
import { describe, expect, it } from 'vitest'

import {
  cropSnapshotSource,
  planSnapshotRender,
  snapshotTiles,
} from './snapshot'
import { UNIFORM_BUFFER_SIZE } from './uniform-layout'

describe('webGPU tiled snapshot memory budget', () => {
  it('includes padded row bytes before accepting a narrow full-frame readback', () => {
    const plan = planSnapshotRender({
      width: 1,
      height: 1024,
      maxTextureSize: 8192,
      lutSize: 0,
      budgetBytes: 32768,
    })
    expect(plan.strategy).toBe('tiled')
    if (plan.strategy !== 'tiled') throw new Error('expected tiled plan')
    const bytes =
      plan.tileWidth * plan.tileHeight * 20 +
      256 * plan.tileHeight +
      LUT_SIZE * 16 +
      16 +
      UNIFORM_BUFFER_SIZE
    expect(bytes).toBeLessThanOrEqual(32768)
  })
  it.each([0, 33])(
    'bounds RGB16 source, RGBA16F process and readback targets with a %s LUT',
    (lutSize) => {
      const budget = 2 * 1024 * 1024
      const plan = planSnapshotRender({
        width: 1024,
        height: 1024,
        maxTextureSize: 8192,
        lutSize,
        budgetBytes: budget,
      })
      expect(plan.strategy).toBe('tiled')
      if (plan.strategy !== 'tiled') throw new Error('expected tiled plan')
      const pixels = plan.tileWidth * plan.tileHeight
      const fixed = lutSize ** 3 * 16 + LUT_SIZE * 16 + 16 + UNIFORM_BUFFER_SIZE
      const working =
        pixels * (8 + 8 + 4) +
        Math.ceil((plan.tileWidth * 4) / 256) * 256 * plan.tileHeight +
        fixed
      expect(working).toBeLessThanOrEqual(budget)
      expect(plan.tileWidth).toBeLessThan(1024)
    },
  )
  it('fails closed when even fixed snapshot resources exceed the budget', () => {
    expect(
      planSnapshotRender({
        width: 1024,
        height: 1024,
        maxTextureSize: 8192,
        lutSize: 129,
        budgetBytes: 2 * 1024 * 1024,
      }),
    ).toMatchObject({ strategy: 'fail', reason: 'gpu-limit' })
  })

  it('plans one full frame when the texture limit and budget hold it', () => {
    expect(
      planSnapshotRender({
        width: 4000,
        height: 3000,
        maxTextureSize: 8192,
        lutSize: 33,
      }),
    ).toEqual({ strategy: 'full-frame', width: 4000, height: 3000 })
  })

  it('tiles a frame past the texture limit at no more than that limit', () => {
    expect(
      planSnapshotRender({
        width: 9000,
        height: 6000,
        maxTextureSize: 4096,
        lutSize: 0,
      }),
    ).toMatchObject({
      strategy: 'tiled',
      reason: 'texture-limit',
      tileWidth: 4096,
      tileHeight: 4096,
    })
  })

  it.each([
    [{ width: 20000, height: 12000, maxTextureSize: 8192 }, 'canvas-limit'],
    [{ width: 0, height: 12, maxTextureSize: 8192 }, 'canvas-limit'],
    [{ width: 1024, height: 1024, maxTextureSize: 0 }, 'gpu-limit'],
  ])('fails closed on %o with %s', (size, reason) => {
    expect(planSnapshotRender({ ...size, lutSize: 0 })).toMatchObject({
      strategy: 'fail',
      reason,
    })
  })
})

describe('tiled RGB16 source crops', () => {
  const source = {
    data: Uint16Array.from({ length: 3 * 2 * 3 }, (_, index) => index),
    width: 3,
    height: 2,
    renderExposureEv: 1,
    renderExposureMultiplier: 2,
  }

  it('reassembles the source, exposure included, from its tiles', () => {
    const tiles = snapshotTiles({
      strategy: 'tiled',
      reason: 'memory-budget',
      width: 3,
      height: 2,
      tileWidth: 2,
      tileHeight: 1,
    })
    const restored = new Uint16Array(source.data.length)
    for (const tile of tiles) {
      const crop = cropSnapshotSource(source, tile)
      expect(crop).toMatchObject({
        width: tile.width,
        height: tile.height,
        renderExposureEv: 1,
        renderExposureMultiplier: 2,
      })
      for (let row = 0; row < tile.height; row++)
        restored.set(
          crop.data.subarray(row * tile.width * 3, (row + 1) * tile.width * 3),
          ((tile.y + row) * source.width + tile.x) * 3,
        )
    }
    expect(restored).toEqual(source.data)
  })
})
