import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { WebGPUDeviceLease } from './device'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function lossInfo(
  reason: GPUDeviceLostReason,
  message = '',
): GPUDeviceLostInfo {
  return { reason, message } as GPUDeviceLostInfo
}

function createDevice() {
  const lost = deferred<GPUDeviceLostInfo>()
  const device = {
    lost: lost.promise,
    destroy: vi.fn(() => {
      lost.resolve(lossInfo('destroyed'))
    }),
  } as unknown as GPUDevice
  return { device, lose: lost.resolve }
}

function installGpu({ filterable = false, max2D = 32768 } = {}) {
  const first = createDevice()
  const adapter = {
    features: new Set(filterable ? ['float32-filterable'] : []),
    limits: { maxTextureDimension2D: max2D, maxTextureDimension3D: 2048 },
    requestDevice: vi.fn().mockResolvedValue(first.device),
  }
  const gpu = { requestAdapter: vi.fn().mockResolvedValue(adapter) }
  vi.stubGlobal('navigator', { gpu })
  return { adapter, gpu, ...first }
}

let acquire: typeof import('./device').acquireWebGPUDevice
let leases: WebGPUDeviceLease[] = []

beforeEach(async () => {
  leases = []
  vi.resetModules()
  acquire = (await import('./device')).acquireWebGPUDevice
})

afterEach(() => {
  for (const lease of leases) lease.release()
  vi.unstubAllGlobals()
})

async function leaseDevice() {
  const lease = await acquire()
  leases.push(lease)
  return lease
}

describe('shared WebGPU device leases', () => {
  it('deduplicates concurrent requests and destroys after the last release', async () => {
    const { adapter, gpu, device } = installGpu()
    const [first, second] = await Promise.all([leaseDevice(), leaseDevice()])

    expect(gpu.requestAdapter).toHaveBeenCalledTimes(1)
    expect(adapter.requestDevice).toHaveBeenCalledTimes(1)
    expect(first.device).toBe(device)
    expect(second.device).toBe(device)
    expect(first.adapter).toBe(adapter)
    first.release()
    first.release()
    expect(device.destroy).not.toHaveBeenCalled()
    second.release()
    expect(device.destroy).toHaveBeenCalledTimes(1)
  })

  it('counts an acquisition waiting on an already ready device before release', async () => {
    const { device, gpu } = installGpu()
    const first = await leaseDevice()
    const pending = leaseDevice()
    first.release()
    expect(device.destroy).not.toHaveBeenCalled()
    const second = await pending
    expect(second.device).toBe(device)
    expect(gpu.requestAdapter).toHaveBeenCalledTimes(1)
    second.release()
    expect(device.destroy).toHaveBeenCalledTimes(1)
  })

  it.each([false, true])(
    'requests bounded limits and optional filtering: %s',
    async (filterable) => {
      const { adapter } = installGpu({ filterable })
      await leaseDevice()
      expect(adapter.requestDevice).toHaveBeenCalledWith({
        requiredFeatures: filterable ? ['float32-filterable'] : [],
        requiredLimits: {
          maxTextureDimension2D: 16384,
          maxTextureDimension3D: 256,
        },
      })
    },
  )

  it('does not exceed the adapter texture limit', async () => {
    const { adapter } = installGpu({ max2D: 8192 })
    await leaseDevice()
    expect(adapter.requestDevice.mock.calls[0][0].requiredLimits).toEqual({
      maxTextureDimension2D: 8192,
      maxTextureDimension3D: 256,
    })
  })

  it('releases a lease acquired after its consumer has cancelled', async () => {
    const { adapter, device } = installGpu()
    const request = deferred<GPUDevice>()
    adapter.requestDevice.mockReturnValueOnce(request.promise)
    const pending = leaseDevice()
    request.resolve(device)
    ;(await pending).release()
    expect(device.destroy).toHaveBeenCalledTimes(1)
  })

  it('reports loss to active listeners and permits a fresh device', async () => {
    const { adapter, device, lose, gpu } = installGpu()
    const first = await leaseDevice()
    const released = await leaseDevice()
    const listener = vi.fn()
    const removedListener = vi.fn()
    const releasedListener = vi.fn()
    first.onLost(listener)
    first.onLost(removedListener)()
    released.onLost(releasedListener)
    released.release()

    const loss = lossInfo('unknown', 'GPU reset')
    lose(loss)
    await vi.waitFor(() => expect(listener).toHaveBeenCalledWith(loss))
    expect(removedListener).not.toHaveBeenCalled()
    expect(releasedListener).not.toHaveBeenCalled()

    const replacement = createDevice()
    adapter.requestDevice.mockResolvedValueOnce(replacement.device)
    const next = await leaseDevice()
    expect(next.device).toBe(replacement.device)
    first.release()
    expect(device.destroy).toHaveBeenCalledTimes(1)
    expect(replacement.device.destroy).not.toHaveBeenCalled()
    expect((await leaseDevice()).device).toBe(replacement.device)
    expect(gpu.requestAdapter).toHaveBeenCalledTimes(2)
  })

  it('notifies late subscribers of a loss but never released leases', async () => {
    const { lose } = installGpu()
    const first = await leaseDevice()
    const loss = lossInfo('unknown', 'GPU reset')
    lose(loss)
    await Promise.resolve()
    const late = vi.fn()
    first.onLost(late)
    await vi.waitFor(() => expect(late).toHaveBeenCalledWith(loss))
    first.release()
    const released = vi.fn()
    first.onLost(released)
    await Promise.resolve()
    expect(released).not.toHaveBeenCalled()
  })

  it('does not report an intentional final destroy as an unexpected loss', async () => {
    installGpu()
    const first = await leaseDevice()
    const listener = vi.fn()
    first.onLost(listener)
    first.release()
    await Promise.resolve()
    expect(listener).not.toHaveBeenCalled()
  })

  it('clears a rejected request so concurrent callers fail and retry can succeed', async () => {
    const { adapter, gpu, device } = installGpu()
    adapter.requestDevice.mockRejectedValueOnce(new Error('request failed'))
    const results = await Promise.allSettled([leaseDevice(), leaseDevice()])
    expect(results.map((result) => result.status)).toEqual([
      'rejected',
      'rejected',
    ])
    expect(gpu.requestAdapter).toHaveBeenCalledTimes(1)
    expect(device.destroy).not.toHaveBeenCalled()
    expect((await leaseDevice()).device).toBe(device)
    expect(gpu.requestAdapter).toHaveBeenCalledTimes(2)
  })

  it('does not return a device that was lost before initialization finished', async () => {
    const { device, lose, adapter } = installGpu()
    lose(lossInfo('unknown', 'already lost'))
    await expect(leaseDevice()).rejects.toThrow('WEBGPU_DEVICE_LOST')
    expect(device.destroy).toHaveBeenCalledTimes(1)
    const replacement = createDevice()
    adapter.requestDevice.mockResolvedValueOnce(replacement.device)
    expect((await leaseDevice()).device).toBe(replacement.device)
  })

  it('allows retry after no adapter is available', async () => {
    const { gpu } = installGpu()
    gpu.requestAdapter.mockResolvedValueOnce(null)
    await expect(leaseDevice()).rejects.toThrow('WEBGPU_ADAPTER_UNAVAILABLE')
    await expect(leaseDevice()).resolves.toBeDefined()
  })

  it('reports unavailable WebGPU without reading a missing navigator', async () => {
    vi.stubGlobal('navigator', undefined)
    await expect(leaseDevice()).rejects.toThrow('WEBGPU_UNAVAILABLE')
  })
})
