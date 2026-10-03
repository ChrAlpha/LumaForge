import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  reportGpuPreviewFailure,
  resolvePreviewBackend,
} from '~/lib/preview/gpu-backend'

import { RawProcessingPipeline } from './raw-processing-pipeline'

const fixtures = vi.hoisted(() => ({
  gpu: {
    initialize: vi.fn<() => Promise<void>>(),
    dispose: vi.fn(),
    render: vi.fn(),
    waitForGpu: vi.fn<() => Promise<void>>(),
    onLost: vi.fn(),
    readProcessedPixelsAsync: vi.fn<() => Promise<Float32Array | null>>(),
    renderToHiddenCanvas: vi.fn(),
    getResourceStats: vi.fn(),
  },
  createGpu: vi.fn(),
}))
vi.mock('~/lib/preview/gpu-backend', () => ({
  resolvePreviewBackend: vi.fn(),
  reportGpuPreviewFailure: vi.fn(),
}))
vi.mock('./pipeline', () => ({
  WebGPUProcessingPipeline: vi.fn(() => {
    fixtures.createGpu()
    return fixtures.gpu
  }),
}))

const WEBGPU_FACTS = {
  backend: 'webgpu',
  maxTextureSize: 8192,
  reason: null,
} as const

beforeEach(() => {
  vi.resetAllMocks()
  fixtures.gpu.initialize.mockResolvedValue(undefined)
  fixtures.gpu.waitForGpu.mockResolvedValue(undefined)
  vi.mocked(resolvePreviewBackend).mockResolvedValue(WEBGPU_FACTS)
})
afterEach(() => vi.unstubAllGlobals())

describe('preview pipeline facade', () => {
  it('initializes WebGPU lazily and forwards asynchronous readback', async () => {
    const canvas = document.createElement('canvas')
    const context = vi.spyOn(canvas, 'getContext')
    const pipeline = new RawProcessingPipeline(canvas)
    expect(fixtures.createGpu).not.toHaveBeenCalled()
    await pipeline.initialize()
    expect(pipeline.backend).toBe('webgpu')
    expect(canvas.dataset.renderBackend).toBe('webgpu')
    expect(context).not.toHaveBeenCalled()
    await pipeline.waitForGpu()
    expect(fixtures.gpu.waitForGpu).toHaveBeenCalledOnce()
    const pixels = new Float32Array([0.5, 0.2, 0.1, 1])
    fixtures.gpu.readProcessedPixelsAsync.mockResolvedValue(pixels)
    expect(await pipeline.readProcessedPixelsAsync()).toBe(pixels)
    pipeline.dispose()
  })

  it('waits for a submitted frame without rendering it a second time', async () => {
    const pipeline = new RawProcessingPipeline(document.createElement('canvas'))
    await pipeline.initialize()
    pipeline.render({ waitForGpu: false })
    await pipeline.waitForGpu()
    expect(fixtures.gpu.render).toHaveBeenCalledExactlyOnceWith({
      waitForGpu: false,
    })
  })

  it('never constructs a renderer when the resolved backend is the CPU executor', async () => {
    vi.mocked(resolvePreviewBackend).mockResolvedValue({
      backend: 'cpu',
      maxTextureSize: 0,
      reason: 'webgpu-unavailable',
    })
    const pipeline = new RawProcessingPipeline(document.createElement('canvas'))
    await expect(pipeline.initialize()).rejects.toThrow(
      'GPU_PREVIEW_UNAVAILABLE',
    )
    expect(pipeline.backend).toBeNull()
    expect(fixtures.createGpu).not.toHaveBeenCalled()
    expect(reportGpuPreviewFailure).not.toHaveBeenCalled()
  })

  it('reports initialization and device-loss failures to the capability gate', async () => {
    const failure = new Error('GPU compile failed')
    fixtures.gpu.initialize.mockRejectedValueOnce(failure)
    const failed = new RawProcessingPipeline(document.createElement('canvas'))
    await expect(failed.initialize()).rejects.toBe(failure)
    expect(reportGpuPreviewFailure).toHaveBeenCalledOnce()
    failed.dispose()
    const active = new RawProcessingPipeline(document.createElement('canvas'))
    await active.initialize()
    const listener = fixtures.gpu.onLost.mock.calls[0][0]
    listener(failure)
    expect(reportGpuPreviewFailure).toHaveBeenCalledTimes(2)
    active.dispose()
    listener(failure)
    expect(reportGpuPreviewFailure).toHaveBeenCalledTimes(2)
  })

  it('cancels before backend selection without creating a late renderer or changing the global gate', async () => {
    let resolve!: (
      facts: Awaited<ReturnType<typeof resolvePreviewBackend>>,
    ) => void
    vi.mocked(resolvePreviewBackend).mockReturnValue(
      new Promise((done) => {
        resolve = done
      }),
    )
    const pipeline = new RawProcessingPipeline(document.createElement('canvas'))
    const init = pipeline.initialize()
    pipeline.dispose()
    resolve(WEBGPU_FACTS)
    await expect(init).rejects.toThrow('PREVIEW_PIPELINE_DISPOSED')
    expect(fixtures.createGpu).not.toHaveBeenCalled()
    expect(reportGpuPreviewFailure).not.toHaveBeenCalled()
  })

  it('keeps initialization failure visible and forwards evacuation disposal', async () => {
    const failure = new Error('initialization failed')
    fixtures.gpu.initialize.mockRejectedValue(failure)
    const pipeline = new RawProcessingPipeline(document.createElement('canvas'))
    await expect(pipeline.initialize()).rejects.toBe(failure)
    pipeline.dispose({ releaseContext: true })
    expect(fixtures.gpu.dispose).toHaveBeenCalledExactlyOnceWith({
      releaseContext: true,
    })
  })

  it('preserves the hidden 2D canvas and render limits used by export and Transform', async () => {
    const pipeline = new RawProcessingPipeline(document.createElement('canvas'))
    await pipeline.initialize()
    const output = document.createElement('canvas')
    fixtures.gpu.renderToHiddenCanvas.mockResolvedValue(output)
    const options = {
      width: 64,
      height: 32,
      exportOptions: { memoryBudgetBytes: 4096 },
    }
    await expect(pipeline.renderToHiddenCanvas(options)).resolves.toBe(output)
    expect(fixtures.gpu.renderToHiddenCanvas).toHaveBeenCalledExactlyOnceWith(
      options,
    )
  })
})
