import { describe, expect, it, vi } from 'vitest'

import { WebGPUProcessingPipeline } from './pipeline'

type LossDriver = { fail: (error: Error) => void }

describe('webGPU processing pipeline loss notification', () => {
  it('replays a loss to subscribers that arrive after it', () => {
    const pipeline = new WebGPUProcessingPipeline(
      document.createElement('canvas'),
    )
    const early = vi.fn()
    pipeline.onLost(early)
    const loss = new Error('WEBGPU_DEVICE_LOST: test')
    ;(pipeline as unknown as LossDriver).fail(loss)
    const late = vi.fn()
    pipeline.onLost(late)
    expect(early).toHaveBeenCalledExactlyOnceWith(loss)
    expect(late).toHaveBeenCalledExactlyOnceWith(loss)
  })

  it('does not replay a loss after disposal', () => {
    const pipeline = new WebGPUProcessingPipeline(
      document.createElement('canvas'),
    )
    ;(pipeline as unknown as LossDriver).fail(new Error('lost'))
    pipeline.dispose()
    const late = vi.fn()
    pipeline.onLost(late)
    expect(late).not.toHaveBeenCalled()
  })
})
