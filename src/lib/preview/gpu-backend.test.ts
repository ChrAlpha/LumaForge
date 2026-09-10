import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createWebGL2Context, detectCapabilities } from '~/lib/gl/context'
import { acquireWebGPUDevice } from '~/lib/webgpu/device'

import {
  getPreviewBackendSnapshot,
  getPreviewBackendState,
  reportGpuPreviewFailure,
  resetPreviewBackendForTest,
  resolvePreviewBackend,
  subscribePreviewBackend,
} from './gpu-backend'

vi.mock('~/lib/gl/context', () => ({
  createWebGL2Context: vi.fn(),
  detectCapabilities: vi.fn(),
}))
vi.mock('~/lib/webgpu/device', () => ({ acquireWebGPUDevice: vi.fn() }))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function createLease() {
  return {
    device: { limits: { maxTextureDimension2D: 8192 } },
    adapter: {},
    release: vi.fn(),
    onLost: vi.fn(),
  } as unknown as Awaited<ReturnType<typeof acquireWebGPUDevice>>
}

const loseContext = vi.fn()
beforeEach(() => {
  resetPreviewBackendForTest()
  vi.clearAllMocks()
  window.history.replaceState(null, '', '/')
  vi.mocked(acquireWebGPUDevice).mockRejectedValue(new Error('no WebGPU'))
  vi.mocked(createWebGL2Context).mockReturnValue({
    MAX_RENDERBUFFER_SIZE: 34024,
    getParameter: () => 4096,
    getExtension: () => ({ loseContext }),
  } as unknown as WebGL2RenderingContext)
  vi.mocked(detectCapabilities).mockReturnValue({
    webgl2: true,
    maxTextureSize: 8192,
    toneHighPrecision: true,
  } as ReturnType<typeof detectCapabilities>)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  window.history.replaceState(null, '', '/')
})

describe('preview backend selection', () => {
  it('awaits a real WebGPU lease, deduplicates probes and releases its reference', async () => {
    const request = deferred<Awaited<ReturnType<typeof acquireWebGPUDevice>>>()
    vi.mocked(acquireWebGPUDevice).mockReturnValue(request.promise)
    const first = resolvePreviewBackend()
    const second = resolvePreviewBackend()
    expect(getPreviewBackendSnapshot()).toBeNull()
    expect(getPreviewBackendState().status).toBe('pending')
    const lease = createLease()
    request.resolve(lease)
    expect(await first).toMatchObject({
      backend: 'webgpu',
      maxTextureSize: 8192,
      maxRenderbufferSize: 8192,
      toneHighPrecision: true,
    })
    expect(await second).toBe(await first)
    expect(acquireWebGPUDevice).toHaveBeenCalledTimes(1)
    expect(lease.release).toHaveBeenCalledTimes(1)
    expect(createWebGL2Context).not.toHaveBeenCalled()
    expect(await resolvePreviewBackend()).toBe(await first)
  })

  it('falls back to real WebGL limits and releases the probe context', async () => {
    expect(await resolvePreviewBackend()).toMatchObject({
      backend: 'webgl2',
      maxTextureSize: 8192,
      maxRenderbufferSize: 4096,
      toneHighPrecision: true,
    })
    expect(detectCapabilities).toHaveBeenCalledWith(expect.any(Object))
    expect(loseContext).toHaveBeenCalledTimes(1)
  })

  it('selects CPU when both APIs are unavailable or WebGL precision is insufficient', async () => {
    vi.mocked(createWebGL2Context).mockReturnValueOnce(null)
    expect(await resolvePreviewBackend()).toMatchObject({
      backend: 'cpu',
      reason: 'webgl2-missing',
    })
    resetPreviewBackendForTest()
    vi.mocked(detectCapabilities).mockReturnValueOnce({
      webgl2: true,
      toneHighPrecision: false,
    } as ReturnType<typeof detectCapabilities>)
    expect(await resolvePreviewBackend()).toMatchObject({
      backend: 'cpu',
      reason: 'tone-float-precision-low',
    })
  })

  it('forces CPU locally without requesting either GPU API', async () => {
    window.history.replaceState(null, '', '/raw?forcePreview=cpu')
    expect(await resolvePreviewBackend()).toMatchObject({ backend: 'cpu' })
    expect(acquireWebGPUDevice).not.toHaveBeenCalled()
    expect(createWebGL2Context).not.toHaveBeenCalled()
  })

  it('supports an explicit WebGL baseline without probing WebGPU', async () => {
    window.history.replaceState(null, '', '/raw?forcePreview=webgl2')
    expect(await resolvePreviewBackend()).toMatchObject({ backend: 'webgl2' })
    expect(acquireWebGPUDevice).not.toHaveBeenCalled()
  })

  it('surfaces unavailable forced WebGPU instead of selecting WebGL', async () => {
    window.history.replaceState(null, '', '/raw?forcePreview=webgpu')
    await expect(resolvePreviewBackend()).rejects.toThrow(
      'WebGPU preview is unavailable',
    )
    expect(createWebGL2Context).not.toHaveBeenCalled()
    expect(getPreviewBackendState().status).toBe('failed')
  })

  it('publishes runtime failures to subscribers and prevents late probe promotion', async () => {
    const request = deferred<Awaited<ReturnType<typeof acquireWebGPUDevice>>>()
    vi.mocked(acquireWebGPUDevice).mockReturnValue(request.promise)
    const listener = vi.fn()
    const unsubscribe = subscribePreviewBackend(listener)
    const pending = resolvePreviewBackend()
    reportGpuPreviewFailure(new Error('device lost'))
    expect(getPreviewBackendSnapshot()?.backend).toBe('cpu')
    const lease = createLease()
    request.resolve(lease)
    expect((await pending).backend).toBe('cpu')
    expect(lease.release).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
    reportGpuPreviewFailure(new Error('late failure'))
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('keeps a forced backend failure terminal', async () => {
    window.history.replaceState(null, '', '/raw?forcePreview=webgpu')
    vi.mocked(acquireWebGPUDevice).mockResolvedValue(createLease())
    await resolvePreviewBackend()
    reportGpuPreviewFailure(new Error('device lost'))
    await expect(resolvePreviewBackend()).rejects.toThrow('device lost')
    expect(getPreviewBackendSnapshot()).toBeNull()
  })

  it('times out a stuck probe and releases a lease if it arrives later', async () => {
    vi.useFakeTimers()
    const request = deferred<Awaited<ReturnType<typeof acquireWebGPUDevice>>>()
    vi.mocked(acquireWebGPUDevice).mockReturnValue(request.promise)
    const pending = resolvePreviewBackend()
    await vi.advanceTimersByTimeAsync(5000)
    expect((await pending).backend).toBe('webgl2')
    const lease = createLease()
    request.resolve(lease)
    await Promise.resolve()
    expect(lease.release).toHaveBeenCalledTimes(1)
  })
})
