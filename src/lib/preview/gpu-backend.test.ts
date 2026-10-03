import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { acquireWebGPUDevice } from '~/lib/webgpu/device'

import {
  getPreviewBackendSnapshot,
  getPreviewBackendState,
  reportGpuPreviewFailure,
  resetPreviewBackendForTest,
  resolvePreviewBackend,
  subscribePreviewBackend,
} from './gpu-backend'

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

beforeEach(() => {
  resetPreviewBackendForTest()
  vi.clearAllMocks()
  window.history.replaceState(null, '', '/')
  vi.mocked(acquireWebGPUDevice).mockRejectedValue(new Error('no WebGPU'))
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
    expect(await first).toEqual({
      backend: 'webgpu',
      maxTextureSize: 8192,
      reason: null,
    })
    expect(await second).toBe(await first)
    expect(acquireWebGPUDevice).toHaveBeenCalledTimes(1)
    expect(lease.release).toHaveBeenCalledTimes(1)
    expect(await resolvePreviewBackend()).toBe(await first)
  })

  it('falls back to the CPU executor when WebGPU is unavailable', async () => {
    expect(await resolvePreviewBackend()).toEqual({
      backend: 'cpu',
      maxTextureSize: 0,
      reason: 'webgpu-unavailable',
    })
    expect(getPreviewBackendState().status).toBe('ready')
  })

  it('forces CPU locally without requesting WebGPU', async () => {
    window.history.replaceState(null, '', '/raw?forcePreview=cpu')
    expect(await resolvePreviewBackend()).toMatchObject({
      backend: 'cpu',
      reason: 'forced',
    })
    expect(acquireWebGPUDevice).not.toHaveBeenCalled()
  })

  it('ignores retired backend overrides', async () => {
    vi.mocked(acquireWebGPUDevice).mockResolvedValue(createLease())
    for (const value of ['webgl2', 'webgpu']) {
      resetPreviewBackendForTest()
      window.history.replaceState(null, '', `/raw?forcePreview=${value}`)
      expect((await resolvePreviewBackend()).backend).toBe('webgpu')
    }
  })

  it('publishes runtime failures to subscribers and prevents late probe promotion', async () => {
    const request = deferred<Awaited<ReturnType<typeof acquireWebGPUDevice>>>()
    vi.mocked(acquireWebGPUDevice).mockReturnValue(request.promise)
    const listener = vi.fn()
    const unsubscribe = subscribePreviewBackend(listener)
    const pending = resolvePreviewBackend()
    reportGpuPreviewFailure()
    expect(getPreviewBackendSnapshot()).toMatchObject({
      backend: 'cpu',
      reason: 'gpu-preview-failed',
    })
    const lease = createLease()
    request.resolve(lease)
    expect((await pending).backend).toBe('cpu')
    expect(lease.release).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
    reportGpuPreviewFailure()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('switches a selected WebGPU backend to CPU after a runtime failure', async () => {
    vi.mocked(acquireWebGPUDevice).mockResolvedValue(createLease())
    expect((await resolvePreviewBackend()).backend).toBe('webgpu')
    reportGpuPreviewFailure()
    expect(await resolvePreviewBackend()).toMatchObject({
      backend: 'cpu',
      reason: 'gpu-preview-failed',
    })
  })

  it('times out a stuck probe and releases a lease if it arrives later', async () => {
    vi.useFakeTimers()
    const request = deferred<Awaited<ReturnType<typeof acquireWebGPUDevice>>>()
    vi.mocked(acquireWebGPUDevice).mockReturnValue(request.promise)
    const pending = resolvePreviewBackend()
    await vi.advanceTimersByTimeAsync(5000)
    expect(await pending).toMatchObject({
      backend: 'cpu',
      reason: 'webgpu-unavailable',
    })
    const lease = createLease()
    request.resolve(lease)
    await Promise.resolve()
    expect(lease.release).toHaveBeenCalledTimes(1)
  })
})
