import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  getPreviewBackendSnapshot,
  reportGpuPreviewFailure,
  resolvePreviewBackend,
} from '~/lib/preview/gpu-backend'

import { RawProcessingPipeline } from './pipeline'

const fixtures = vi.hoisted(() => ({
  gpu: {
    initialize: vi.fn(),
    dispose: vi.fn(),
    waitForGpu: vi.fn(),
    onLost: vi.fn(),
    readProcessedPixelsAsync: vi.fn(),
    getResourceStats: vi.fn(),
  },
  gl: { initialize: vi.fn(), dispose: vi.fn() },
  createGpu: vi.fn(),
  createGl: vi.fn(),
}))
vi.mock('~/lib/preview/gpu-backend', () => ({
  getPreviewBackendSnapshot: vi.fn(),
  resolvePreviewBackend: vi.fn(),
  reportGpuPreviewFailure: vi.fn(),
}))
vi.mock('~/lib/webgpu/pipeline', () => ({
  WebGPUProcessingPipeline: vi.fn(() => {
    fixtures.createGpu()
    return fixtures.gpu
  }),
}))
vi.mock('./webgl-pipeline', () => ({
  RawProcessingPipeline: vi.fn(() => {
    fixtures.createGl()
    return fixtures.gl
  }),
}))

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('navigator', { gpu: {} })
  fixtures.gpu.initialize.mockResolvedValue(undefined)
  fixtures.gl.initialize.mockResolvedValue(undefined)
  fixtures.gpu.waitForGpu.mockResolvedValue(undefined)
  vi.mocked(getPreviewBackendSnapshot).mockReturnValue(null)
  vi.mocked(resolvePreviewBackend).mockResolvedValue({
    backend: 'webgpu',
    maxTextureSize: 8192,
    maxRenderbufferSize: 8192,
    toneHighPrecision: true,
    reason: null,
  })
})
afterEach(() => vi.unstubAllGlobals())

describe('preview backend integration', () => {
  it('initializes WebGPU without acquiring a WebGL context and forwards asynchronous readback', async () => {
    const canvas = document.createElement('canvas')
    const context = vi.spyOn(canvas, 'getContext')
    const pipeline = new RawProcessingPipeline(canvas)
    await pipeline.initialize()
    expect(pipeline.backend).toBe('webgpu')
    expect(canvas.dataset.renderBackend).toBe('webgpu')
    expect(context).not.toHaveBeenCalled()
    expect(fixtures.createGl).not.toHaveBeenCalled()
    await pipeline.waitForGpu()
    expect(fixtures.gpu.waitForGpu).toHaveBeenCalledOnce()
    const pixels = new Float32Array([0.5, 0.2, 0.1, 1])
    fixtures.gpu.readProcessedPixelsAsync.mockResolvedValue(pixels)
    expect(await pipeline.readProcessedPixelsAsync()).toBe(pixels)
    pipeline.dispose()
  })
  it('keeps the compatibility backend selected by the capability probe', async () => {
    vi.mocked(resolvePreviewBackend).mockResolvedValue({
      backend: 'webgl2',
      maxTextureSize: 4096,
      maxRenderbufferSize: 4096,
      toneHighPrecision: true,
      reason: null,
    })
    const pipeline = new RawProcessingPipeline(document.createElement('canvas'))
    await pipeline.initialize()
    expect(pipeline.backend).toBe('webgl2')
    expect(fixtures.createGpu).not.toHaveBeenCalled()
    expect(fixtures.gl.initialize).toHaveBeenCalledOnce()
    pipeline.dispose()
  })
  it('reports initialization and device-loss failures to the capability gate', async () => {
    const failure = new Error('GPU compile failed')
    fixtures.gpu.initialize.mockRejectedValueOnce(failure)
    const failed = new RawProcessingPipeline(document.createElement('canvas'))
    await expect(failed.initialize()).rejects.toBe(failure)
    expect(reportGpuPreviewFailure).toHaveBeenCalledWith(failure)
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
    resolve({
      backend: 'webgpu',
      maxTextureSize: 8192,
      maxRenderbufferSize: 8192,
      toneHighPrecision: true,
      reason: null,
    })
    await expect(init).rejects.toThrow('PREVIEW_PIPELINE_DISPOSED')
    expect(fixtures.createGpu).not.toHaveBeenCalled()
    expect(reportGpuPreviewFailure).not.toHaveBeenCalled()
  })
})
