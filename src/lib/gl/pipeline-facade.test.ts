import { beforeEach, describe, expect, it, vi } from 'vitest'

import { RawProcessingPipeline } from './pipeline'

const backend = vi.hoisted(() => ({
  initialize: vi.fn<() => Promise<void>>(),
  render: vi.fn(),
  readProcessedPixels: vi.fn<() => Float32Array | null>(),
  renderToHiddenCanvas: vi.fn(),
  dispose: vi.fn(),
}))

vi.mock('./webgl-pipeline', () => ({
  RawProcessingPipeline: vi.fn(() => backend),
}))

describe('preview pipeline facade', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    backend.initialize.mockResolvedValue()
  })

  function createPipeline() {
    const finish = vi.fn()
    const canvas = document.createElement('canvas')
    const context = { finish } as unknown as WebGL2RenderingContext
    vi.spyOn(canvas, 'getContext').mockImplementation(((contextId: string) =>
      contextId === 'webgl2'
        ? context
        : null) as HTMLCanvasElement['getContext'])
    return { pipeline: new RawProcessingPipeline(canvas), finish }
  }

  it('waits for a submitted frame without rendering it a second time', async () => {
    const { pipeline, finish } = createPipeline()
    await pipeline.initialize()
    pipeline.render({ waitForGpu: false })
    expect(finish).not.toHaveBeenCalled()

    await pipeline.waitForGpu()

    expect(pipeline.backend).toBe('webgl2')
    expect(backend.render).toHaveBeenCalledExactlyOnceWith({
      waitForGpu: false,
    })
    expect(finish).toHaveBeenCalledOnce()
  })

  it('preserves readback ownership and rejects asynchronous read failures', async () => {
    const { pipeline } = createPipeline()
    const pixels = new Float32Array([0.2, 0.4, 0.6, 1])
    backend.readProcessedPixels.mockReturnValue(pixels)
    await expect(pipeline.readProcessedPixelsAsync()).resolves.toBe(pixels)

    backend.readProcessedPixels.mockReturnValue(null)
    await expect(pipeline.readProcessedPixelsAsync()).resolves.toBeNull()

    const failure = new Error('readback failed')
    backend.readProcessedPixels.mockImplementation(() => {
      throw failure
    })
    await expect(pipeline.readProcessedPixelsAsync()).rejects.toBe(failure)
  })

  it('keeps initialization failure visible and forwards evacuation disposal', async () => {
    const { pipeline } = createPipeline()
    const failure = new Error('initialization failed')
    backend.initialize.mockRejectedValue(failure)

    await expect(pipeline.initialize()).rejects.toBe(failure)
    pipeline.dispose({ releaseContext: true })

    expect(backend.dispose).toHaveBeenCalledExactlyOnceWith({
      releaseContext: true,
    })
  })

  it('preserves the hidden 2D canvas and render limits used by export and Transform', async () => {
    const { pipeline } = createPipeline()
    const output = document.createElement('canvas')
    backend.renderToHiddenCanvas.mockResolvedValue(output)
    const options = {
      width: 64,
      height: 32,
      exportOptions: { memoryBudgetBytes: 4096 },
    }

    await expect(pipeline.renderToHiddenCanvas(options)).resolves.toBe(output)
    expect(backend.renderToHiddenCanvas).toHaveBeenCalledExactlyOnceWith(
      options,
    )
  })
})
