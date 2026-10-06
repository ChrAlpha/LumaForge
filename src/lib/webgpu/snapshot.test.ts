import { LUT_SIZE } from '@lumaforge/luma-color-runtime'
import { describe, expect, it } from 'vitest'

import { planSnapshotRender } from './snapshot'
import { UNIFORM_BUFFER_SIZE } from './uniform-layout'

describe('webGPU tiled snapshot memory budget', () => {
  it('includes padded row bytes before accepting a narrow full-frame readback', () => {
    const plan = planSnapshotRender({
      width: 1,
      height: 1024,
      maxTextureSize: 8192,
      lutSize: 0,
      exportOptions: { memoryBudgetBytes: 32768 },
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
        exportOptions: { memoryBudgetBytes: budget },
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
        exportOptions: { memoryBudgetBytes: 2 * 1024 * 1024 },
      }),
    ).toMatchObject({ strategy: 'fail', reason: 'gpu-limit' })
  })
})
