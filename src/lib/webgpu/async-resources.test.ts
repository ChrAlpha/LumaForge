import { describe, expect, it, vi } from 'vitest'

import { GPUReadbackJobs } from './async-resources'

describe('gPU asynchronous resource ownership', () => {
  it('evacuates pending jobs immediately and rejects late allocations', () => {
    const jobs = new GPUReadbackJobs()
    const first = jobs.create()
    const second = jobs.create()
    const a = first.track({ destroy: vi.fn() }, 1024)
    const b = second.track({ destroy: vi.fn() }, 2048)
    expect(jobs.estimatedBytes).toBe(3072)
    jobs.dispose()
    expect(jobs.estimatedBytes).toBe(0)
    expect(a.destroy).toHaveBeenCalledOnce()
    expect(b.destroy).toHaveBeenCalledOnce()
    expect(() => first.assertActive()).toThrow('GPU_READBACK_CANCELLED')
    const late = { destroy: vi.fn() }
    expect(() => first.track(late, 256)).toThrow('GPU_READBACK_CANCELLED')
    expect(late.destroy).toHaveBeenCalledOnce()
    first.release(a)
    first.dispose()
    expect(a.destroy).toHaveBeenCalledOnce()
  })
  it('updates pooled texture estimates and isolates normal job completion', () => {
    const jobs = new GPUReadbackJobs()
    const scope = jobs.create()
    const other = jobs.create()
    let bytes = 256
    const pooled = scope.track({ destroy: vi.fn() }, () => bytes)
    other.track({ destroy: vi.fn() }, 128)
    bytes = 512
    expect(jobs.estimatedBytes).toBe(640)
    scope.release(pooled)
    scope.dispose()
    expect(jobs.estimatedBytes).toBe(128)
    expect(pooled.destroy).toHaveBeenCalledOnce()
    jobs.dispose()
  })
})
