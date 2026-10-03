import { describe, expect, it, vi } from 'vitest'

import { WorkerBridge } from './worker-bridge'

interface FakeApi {
  echo: (value: number) => Promise<number>
}

function createFakeBridge() {
  const calls: number[] = []
  const startWorker = vi.fn(() => {
    const api: FakeApi = {
      echo: async (value) => {
        calls.push(value)
        await Promise.resolve()
        return value
      },
    }
    return { api, terminate: vi.fn() }
  })
  const bridge = new WorkerBridge<FakeApi>({ startWorker, idleMs: 10_000 })
  return { bridge, startWorker, calls }
}

describe('workerBridge', () => {
  it('runs calls serially in submission order', async () => {
    const { bridge, calls } = createFakeBridge()
    const signal = new AbortController().signal
    const results = await Promise.all([
      bridge.call('echo', signal, 1),
      bridge.call('echo', signal, 2),
      bridge.call('echo', signal, 3),
    ])
    expect(results).toEqual([1, 2, 3])
    expect(calls).toEqual([1, 2, 3])
  })

  it('keeps running queued calls after a rejected call', async () => {
    let n = 0
    const startWorker = vi.fn(() => ({
      api: {
        echo: async (value: number) => {
          n += 1
          if (n === 1) throw new Error('boom')
          return value
        },
      } as FakeApi,
      terminate: vi.fn(),
    }))
    const bridge = new WorkerBridge<FakeApi>({ startWorker, idleMs: 10_000 })
    const signal = new AbortController().signal
    await expect(bridge.call('echo', signal, 1)).rejects.toThrow('boom')
    await expect(bridge.call('echo', signal, 2)).resolves.toBe(2)
  })

  it('does not spawn a worker when a queued call is aborted before its turn', async () => {
    const pendingA: { release: (() => void) | null } = { release: null }
    const startWorker = vi.fn(async () => ({
      api: {
        echo: async (value: number) => {
          await new Promise<void>((resolve) => {
            pendingA.release = resolve
          })
          return value
        },
      } as FakeApi,
      terminate: vi.fn(),
    }))
    const bridge = new WorkerBridge<FakeApi>({ startWorker })
    const cA = new AbortController()
    const cB = new AbortController()
    const a = bridge.call('echo', cA.signal, 1)
    const b = bridge.call('echo', cB.signal, 2)
    cB.abort()
    await vi.waitFor(() => expect(pendingA.release).toBeTypeOf('function'))
    pendingA.release?.()
    await a
    await expect(b).rejects.toThrow(/aborted/i)
    expect(startWorker).toHaveBeenCalledTimes(1)
  })

  it('terminates the worker when an active call is aborted', async () => {
    const terminate = vi.fn()
    const pendingCall: { resolve: ((value: number) => void) | null } = {
      resolve: null,
    }
    const startWorker = vi.fn(() => ({
      api: {
        echo: (value: number) =>
          new Promise<number>((resolve) => {
            pendingCall.resolve = () => resolve(value)
          }),
      } as FakeApi,
      terminate,
    }))
    const bridge = new WorkerBridge<FakeApi>({ startWorker })
    const c = new AbortController()
    const p = bridge.call('echo', c.signal, 1)
    await vi.waitFor(() => expect(pendingCall.resolve).toBeTypeOf('function'))
    c.abort()
    pendingCall.resolve?.(1)
    await p.catch(() => undefined)
    expect(terminate).toHaveBeenCalledTimes(1)
  })

  it('terminates after idle window on success', async () => {
    vi.useFakeTimers()
    try {
      const terminate = vi.fn()
      const startWorker = vi.fn(() => ({
        api: { echo: async (v: number) => v } as FakeApi,
        terminate,
      }))
      const bridge = new WorkerBridge<FakeApi>({ startWorker, idleMs: 100 })
      await bridge.call('echo', new AbortController().signal, 1)
      vi.advanceTimersByTime(100)
      await Promise.resolve()
      expect(terminate).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('terminates after idle window on failure', async () => {
    vi.useFakeTimers()
    try {
      const terminate = vi.fn()
      const startWorker = vi.fn(() => ({
        api: {
          echo: async () => {
            throw new Error('boom')
          },
        } as FakeApi,
        terminate,
      }))
      const bridge = new WorkerBridge<FakeApi>({ startWorker, idleMs: 100 })
      await bridge
        .call('echo', new AbortController().signal, 1)
        .catch(() => undefined)
      vi.advanceTimersByTime(100)
      await Promise.resolve()
      expect(terminate).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels idle timer on new call within window', async () => {
    vi.useFakeTimers()
    try {
      const terminate = vi.fn()
      const startWorker = vi.fn(() => ({
        api: { echo: async (v: number) => v } as FakeApi,
        terminate,
      }))
      const bridge = new WorkerBridge<FakeApi>({ startWorker, idleMs: 100 })
      await bridge.call('echo', new AbortController().signal, 1)
      vi.advanceTimersByTime(50)
      await bridge.call('echo', new AbortController().signal, 2)
      vi.advanceTimersByTime(50)
      await Promise.resolve()
      expect(terminate).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the worker past the idle window until a retained result is released', async () => {
    vi.useFakeTimers()
    try {
      const terminate = vi.fn()
      const startWorker = vi.fn(() => ({
        api: { echo: async (v: number) => v } as FakeApi,
        terminate,
      }))
      const bridge = new WorkerBridge<FakeApi>({ startWorker, idleMs: 100 })
      const { value, release } = await bridge.callRetained(
        'echo',
        new AbortController().signal,
        7,
      )
      expect(value).toBe(7)

      await vi.advanceTimersByTimeAsync(1_000)
      expect(terminate).not.toHaveBeenCalled()

      release()
      release()
      await vi.advanceTimersByTimeAsync(100)
      expect(terminate).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not idle-terminate an in-flight call when a lease is released mid-call', async () => {
    vi.useFakeTimers()
    try {
      const terminate = vi.fn()
      const pending: { resolve: ((value: number) => void) | null } = {
        resolve: null,
      }
      let first = true
      const startWorker = vi.fn(() => ({
        api: {
          echo: (v: number) => {
            if (first) {
              first = false
              return Promise.resolve(v)
            }
            return new Promise<number>((resolve) => {
              pending.resolve = resolve
            })
          },
        } as FakeApi,
        terminate,
      }))
      const bridge = new WorkerBridge<FakeApi>({ startWorker, idleMs: 100 })
      const { release } = await bridge.callRetained(
        'echo',
        new AbortController().signal,
        1,
      )
      const slow = bridge.call('echo', new AbortController().signal, 2)
      await vi.waitFor(() => expect(pending.resolve).toBeTypeOf('function'))

      release()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(terminate).not.toHaveBeenCalled()

      pending.resolve?.(2)
      await expect(slow).resolves.toBe(2)
      await vi.advanceTimersByTimeAsync(100)
      expect(terminate).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops leases on terminate so a stale release cannot pin or idle the next worker', async () => {
    vi.useFakeTimers()
    try {
      const terminate = vi.fn()
      const startWorker = vi.fn(() => ({
        api: { echo: async (v: number) => v } as FakeApi,
        terminate,
      }))
      const bridge = new WorkerBridge<FakeApi>({ startWorker, idleMs: 100 })
      const { release } = await bridge.callRetained(
        'echo',
        new AbortController().signal,
        1,
      )

      await bridge.terminate()
      expect(terminate).toHaveBeenCalledTimes(1)

      const next = await bridge.callRetained(
        'echo',
        new AbortController().signal,
        2,
      )
      expect(startWorker).toHaveBeenCalledTimes(2)
      release()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(terminate).toHaveBeenCalledTimes(1)

      next.release()
      await vi.advanceTimersByTimeAsync(100)
      expect(terminate).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
