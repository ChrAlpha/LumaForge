import { describe, expect, it, vi } from 'vitest'

import { WorkerBridge } from './worker-bridge'

interface FakeApi {
  echo: (value: number) => Promise<number>
}

interface DeferredStart {
  generation: number
  echo: ReturnType<typeof vi.fn>
  terminate: ReturnType<typeof vi.fn>
  resolve: () => void
  reject: (error: unknown) => void
}

/**
 * Every start is held until the test resolves or rejects it, so cancellation
 * can be exercised while startup is still in flight.
 */
function createDeferredStartBridge() {
  const starts: DeferredStart[] = []
  const startWorker = vi.fn(
    ({ generation }: { generation: number }) =>
      new Promise<{ api: FakeApi; terminate: () => void }>(
        (resolve, reject) => {
          const echo = vi.fn(async (value: number) => value)
          const terminate = vi.fn()
          starts.push({
            generation,
            echo,
            terminate,
            resolve: () => resolve({ api: { echo }, terminate }),
            reject,
          })
        },
      ),
  )
  const bridge = new WorkerBridge<FakeApi>({ startWorker, idleMs: 10_000 })
  return { bridge, startWorker, starts }
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

  it('disposes a worker exactly once when abort and explicit terminate race', async () => {
    const terminate = vi.fn()
    const pending: { resolve: ((value: number) => void) | null } = {
      resolve: null,
    }
    const startWorker = vi.fn(() => ({
      api: {
        echo: (v: number) =>
          new Promise<number>((resolve) => {
            pending.resolve = () => resolve(v)
          }),
      } as FakeApi,
      terminate,
    }))
    const bridge = new WorkerBridge<FakeApi>({ startWorker })
    const c = new AbortController()
    const p = bridge.call('echo', c.signal, 1)
    await vi.waitFor(() => expect(pending.resolve).toBeTypeOf('function'))

    c.abort()
    await bridge.terminate()
    await bridge.terminate()
    pending.resolve?.(1)
    await p.catch(() => undefined)

    expect(terminate).toHaveBeenCalledTimes(1)
  })

  describe('asynchronous startup', () => {
    it('rejects an aborted call before startup resolves and disposes the late worker unused', async () => {
      const { bridge, starts } = createDeferredStartBridge()
      const listener = vi.fn()
      bridge.subscribeLifecycle(listener)
      const c = new AbortController()
      const p = bridge.call('echo', c.signal, 1)
      await vi.waitFor(() => expect(starts).toHaveLength(1))

      c.abort()
      await expect(p).rejects.toThrow(/aborted/i)

      starts[0]!.resolve()
      await vi.waitFor(() =>
        expect(starts[0]!.terminate).toHaveBeenCalledTimes(1),
      )
      expect(starts[0]!.echo).not.toHaveBeenCalled()
      expect(listener).not.toHaveBeenCalled()
      expect(bridge.getLifecycleSnapshot()).toEqual({
        generation: 0,
        alive: false,
        lastTermination: null,
      })
    })

    it('cancels an in-flight startup on explicit terminate', async () => {
      const { bridge, starts } = createDeferredStartBridge()
      const p = bridge.call('echo', new AbortController().signal, 1)
      await vi.waitFor(() => expect(starts).toHaveLength(1))

      await bridge.terminate()
      await expect(p).rejects.toThrow(/terminated/i)

      starts[0]!.resolve()
      await vi.waitFor(() =>
        expect(starts[0]!.terminate).toHaveBeenCalledTimes(1),
      )
      expect(starts[0]!.echo).not.toHaveBeenCalled()
      expect(bridge.getLifecycleSnapshot().alive).toBe(false)
    })

    it('keeps a replacement worker when the obsolete startup resolves late', async () => {
      const { bridge, startWorker, starts } = createDeferredStartBridge()
      const cA = new AbortController()
      const a = bridge.call('echo', cA.signal, 1)
      await vi.waitFor(() => expect(starts).toHaveLength(1))
      await bridge.terminate()
      await expect(a).rejects.toThrow(/terminated/i)

      const b = bridge.call('echo', new AbortController().signal, 2)
      await vi.waitFor(() => expect(starts).toHaveLength(2))
      expect(starts.map((start) => start.generation)).toEqual([1, 2])
      starts[1]!.resolve()
      await expect(b).resolves.toBe(2)

      starts[0]!.resolve()
      await vi.waitFor(() =>
        expect(starts[0]!.terminate).toHaveBeenCalledTimes(1),
      )
      // The old call's signal is no longer wired to the bridge.
      cA.abort()
      await expect(
        bridge.call('echo', new AbortController().signal, 3),
      ).resolves.toBe(3)

      expect(startWorker).toHaveBeenCalledTimes(2)
      expect(starts[0]!.echo).not.toHaveBeenCalled()
      expect(starts[1]!.terminate).not.toHaveBeenCalled()
      expect(starts[1]!.echo).toHaveBeenCalledTimes(2)
      expect(bridge.getLifecycleSnapshot()).toEqual({
        generation: 2,
        alive: true,
        lastTermination: null,
      })
      await bridge.terminate()
      expect(starts[1]!.terminate).toHaveBeenCalledTimes(1)
      expect(starts[0]!.terminate).toHaveBeenCalledTimes(1)
    })

    it('lets the next queued call start a replacement while an aborted startup is still pending', async () => {
      const { bridge, starts } = createDeferredStartBridge()
      const cA = new AbortController()
      const a = bridge.call('echo', cA.signal, 1)
      const b = bridge.call('echo', new AbortController().signal, 2)
      await vi.waitFor(() => expect(starts).toHaveLength(1))

      cA.abort()
      await expect(a).rejects.toThrow(/aborted/i)
      await vi.waitFor(() => expect(starts).toHaveLength(2))
      starts[1]!.resolve()
      await expect(b).resolves.toBe(2)

      starts[0]!.resolve()
      await vi.waitFor(() =>
        expect(starts[0]!.terminate).toHaveBeenCalledTimes(1),
      )
      expect(starts[1]!.terminate).not.toHaveBeenCalled()
      expect(bridge.getLifecycleSnapshot()).toMatchObject({
        generation: 2,
        alive: true,
      })
      await bridge.terminate()
    })

    it('swallows a late startup failure after cancellation', async () => {
      const unhandled = vi.fn()
      process.on('unhandledRejection', unhandled)
      try {
        const { bridge, starts } = createDeferredStartBridge()
        const c = new AbortController()
        const p = bridge.call('echo', c.signal, 1)
        await vi.waitFor(() => expect(starts).toHaveLength(1))
        c.abort()
        await expect(p).rejects.toThrow(/aborted/i)

        starts[0]!.reject(new Error('late boom'))
        // Unhandled rejections are reported once the microtask queue drains,
        // so wait a whole event-loop turn rather than a single tick.
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(unhandled).not.toHaveBeenCalled()
        expect(bridge.getLifecycleSnapshot().alive).toBe(false)

        const next = bridge.call('echo', new AbortController().signal, 2)
        await vi.waitFor(() => expect(starts).toHaveLength(2))
        starts[1]!.resolve()
        await expect(next).resolves.toBe(2)
        await bridge.terminate()
      } finally {
        process.off('unhandledRejection', unhandled)
      }
    })

    it('retries startup on the next call after a startup failure', async () => {
      const { bridge, starts } = createDeferredStartBridge()
      const a = bridge.call('echo', new AbortController().signal, 1)
      const b = bridge.call('echo', new AbortController().signal, 2)
      await vi.waitFor(() => expect(starts).toHaveLength(1))
      starts[0]!.reject(new Error('start failed'))
      await expect(a).rejects.toThrow('start failed')

      await vi.waitFor(() => expect(starts).toHaveLength(2))
      starts[1]!.resolve()
      await expect(b).resolves.toBe(2)
      // A failed start still used up its generation.
      expect(starts[1]!.generation).toBe(2)
      await bridge.terminate()
    })

    it('does not invoke the operation when an observer terminates the worker it just published', async () => {
      const { bridge, starts } = createDeferredStartBridge()
      bridge.subscribeLifecycle((snapshot) => {
        if (snapshot.alive) void bridge.terminate()
      })
      const p = bridge.call('echo', new AbortController().signal, 1)
      await vi.waitFor(() => expect(starts).toHaveLength(1))
      starts[0]!.resolve()

      await expect(p).rejects.toThrow(/terminated/i)
      expect(starts[0]!.echo).not.toHaveBeenCalled()
      expect(starts[0]!.terminate).toHaveBeenCalledTimes(1)
    })
  })

  describe('cancellation between publication and invocation', () => {
    const handoffAborts = [
      ['synchronously by an observer', (c: AbortController) => c.abort()],
      [
        'in a microtask an observer queues',
        (c: AbortController) => queueMicrotask(() => c.abort()),
      ],
    ] as const

    function createPublicationBridge() {
      const handles: Array<{
        echo: ReturnType<typeof vi.fn>
        terminate: ReturnType<typeof vi.fn>
      }> = []
      const startWorker = vi.fn(() => {
        const echo = vi.fn(async (value: number) => value)
        const terminate = vi.fn()
        handles.push({ echo, terminate })
        return { api: { echo } as FakeApi, terminate }
      })
      const bridge = new WorkerBridge<FakeApi>({ startWorker, idleMs: 100 })
      return { bridge, startWorker, handles }
    }

    function abortOnFirstPublication(
      bridge: WorkerBridge<FakeApi>,
      controller: AbortController,
      abort: (controller: AbortController) => void,
    ) {
      const unsubscribe = bridge.subscribeLifecycle((snapshot) => {
        if (!snapshot.alive) return
        unsubscribe()
        abort(controller)
      })
    }

    it.each(handoffAborts)(
      'skips the operation aborted %s and lets the next call reuse the published worker',
      async (_label, abort) => {
        vi.useFakeTimers()
        try {
          const { bridge, startWorker, handles } = createPublicationBridge()
          const c = new AbortController()
          abortOnFirstPublication(bridge, c, abort)

          await expect(bridge.call('echo', c.signal, 1)).rejects.toMatchObject({
            name: 'AbortError',
            message: 'Aborted',
          })
          expect(handles[0]!.echo).not.toHaveBeenCalled()
          expect(handles[0]!.terminate).not.toHaveBeenCalled()
          expect(bridge.getLifecycleSnapshot()).toEqual({
            generation: 1,
            alive: true,
            lastTermination: null,
          })

          await expect(
            bridge.call('echo', new AbortController().signal, 2),
          ).resolves.toBe(2)
          expect(startWorker).toHaveBeenCalledTimes(1)
          expect(handles[0]!.echo).toHaveBeenCalledTimes(1)
          expect(handles[0]!.echo).toHaveBeenCalledWith(2)
          expect(bridge.getLifecycleSnapshot()).toMatchObject({
            generation: 1,
            alive: true,
          })

          await vi.advanceTimersByTimeAsync(100)
          expect(handles[0]!.terminate).toHaveBeenCalledTimes(1)
          expect(bridge.getLifecycleSnapshot()).toEqual({
            generation: 1,
            alive: false,
            lastTermination: { generation: 1, reason: 'idle' },
          })
        } finally {
          vi.useRealTimers()
        }
      },
    )

    it.each(handoffAborts)(
      'idle-disposes the unused published worker exactly once after an abort %s',
      async (_label, abort) => {
        vi.useFakeTimers()
        try {
          const { bridge, startWorker, handles } = createPublicationBridge()
          const c = new AbortController()
          abortOnFirstPublication(bridge, c, abort)
          await expect(bridge.call('echo', c.signal, 1)).rejects.toMatchObject({
            name: 'AbortError',
          })

          await vi.advanceTimersByTimeAsync(99)
          expect(handles[0]!.terminate).not.toHaveBeenCalled()
          await vi.advanceTimersByTimeAsync(1)
          expect(handles[0]!.terminate).toHaveBeenCalledTimes(1)
          await vi.advanceTimersByTimeAsync(1_000)
          expect(handles[0]!.terminate).toHaveBeenCalledTimes(1)

          expect(startWorker).toHaveBeenCalledTimes(1)
          expect(handles[0]!.echo).not.toHaveBeenCalled()
          expect(bridge.getLifecycleSnapshot()).toEqual({
            generation: 1,
            alive: false,
            lastTermination: { generation: 1, reason: 'idle' },
          })
        } finally {
          vi.useRealTimers()
        }
      },
    )

    it('does not let the signal of an earlier generation terminate its replacement', async () => {
      const pending: { resolve: (() => void) | null } = { resolve: null }
      const terminates: Array<ReturnType<typeof vi.fn>> = []
      const startWorker = vi.fn(({ generation }: { generation: number }) => {
        const terminate = vi.fn()
        terminates.push(terminate)
        return {
          api: {
            echo: (value: number) =>
              generation === 1
                ? Promise.resolve(value)
                : new Promise<number>((resolve) => {
                    pending.resolve = () => resolve(value)
                  }),
          } as FakeApi,
          terminate,
        }
      })
      const bridge = new WorkerBridge<FakeApi>({ startWorker, idleMs: 10_000 })
      const cA = new AbortController()
      await expect(bridge.call('echo', cA.signal, 1)).resolves.toBe(1)
      await bridge.terminate()

      const b = bridge.call('echo', new AbortController().signal, 2)
      await vi.waitFor(() => expect(pending.resolve).toBeTypeOf('function'))
      cA.abort()
      expect(bridge.getLifecycleSnapshot()).toEqual({
        generation: 2,
        alive: true,
        lastTermination: { generation: 1, reason: 'explicit' },
      })

      pending.resolve?.()
      await expect(b).resolves.toBe(2)
      expect(terminates[0]).toHaveBeenCalledTimes(1)
      expect(terminates[1]).not.toHaveBeenCalled()
      await bridge.terminate()
      expect(terminates[1]).toHaveBeenCalledTimes(1)
    })
  })

  describe('lifecycle observations', () => {
    it('starts with no live generation and a stable snapshot', () => {
      const { bridge } = createFakeBridge()
      const snapshot = bridge.getLifecycleSnapshot()
      expect(snapshot).toEqual({
        generation: 0,
        alive: false,
        lastTermination: null,
      })
      expect(bridge.getLifecycleSnapshot()).toBe(snapshot)
    })

    it('publishes a new generation when a worker starts and hands it to startWorker', async () => {
      const startWorker = vi.fn((_context: { generation: number }) => ({
        api: { echo: async (v: number) => v } as FakeApi,
        terminate: vi.fn(),
      }))
      const bridge = new WorkerBridge<FakeApi>({ startWorker, idleMs: 10_000 })
      const snapshots: unknown[] = []
      bridge.subscribeLifecycle((snapshot) => snapshots.push(snapshot))

      await bridge.call('echo', new AbortController().signal, 1)
      await bridge.call('echo', new AbortController().signal, 2)

      expect(startWorker).toHaveBeenCalledTimes(1)
      expect(startWorker).toHaveBeenCalledWith({ generation: 1 })
      expect(snapshots).toEqual([
        { generation: 1, alive: true, lastTermination: null },
      ])
      expect(bridge.getLifecycleSnapshot()).toBe(snapshots[0])
    })

    it('reports idle termination of the live generation', async () => {
      vi.useFakeTimers()
      try {
        const { bridge } = createFakeBridge()
        const listener = vi.fn()
        bridge.subscribeLifecycle(listener)
        await bridge.call('echo', new AbortController().signal, 1)
        listener.mockClear()

        await vi.advanceTimersByTimeAsync(10_000)

        expect(listener).toHaveBeenCalledTimes(1)
        expect(bridge.getLifecycleSnapshot()).toEqual({
          generation: 1,
          alive: false,
          lastTermination: { generation: 1, reason: 'idle' },
        })
      } finally {
        vi.useRealTimers()
      }
    })

    it('reports explicit termination once and ignores a terminate with no worker', async () => {
      const { bridge } = createFakeBridge()
      const listener = vi.fn()
      await bridge.call('echo', new AbortController().signal, 1)
      bridge.subscribeLifecycle(listener)

      await bridge.terminate()
      await bridge.terminate()

      expect(listener).toHaveBeenCalledTimes(1)
      expect(listener).toHaveBeenCalledWith({
        generation: 1,
        alive: false,
        lastTermination: { generation: 1, reason: 'explicit' },
      })
    })

    it('reports abort termination and a fresh generation for the next worker', async () => {
      const pending: { resolve: ((value: number) => void) | null } = {
        resolve: null,
      }
      let calls = 0
      const startWorker = vi.fn(() => ({
        api: {
          echo: (v: number) => {
            calls += 1
            if (calls > 1) return Promise.resolve(v)
            return new Promise<number>((resolve) => {
              pending.resolve = () => resolve(v)
            })
          },
        } as FakeApi,
        terminate: vi.fn(),
      }))
      const bridge = new WorkerBridge<FakeApi>({ startWorker, idleMs: 10_000 })
      const c = new AbortController()
      const p = bridge.call('echo', c.signal, 1)
      await vi.waitFor(() => expect(pending.resolve).toBeTypeOf('function'))

      c.abort()
      expect(bridge.getLifecycleSnapshot()).toEqual({
        generation: 1,
        alive: false,
        lastTermination: { generation: 1, reason: 'abort' },
      })
      pending.resolve?.(1)
      await p.catch(() => undefined)

      await bridge.call('echo', new AbortController().signal, 2)
      expect(bridge.getLifecycleSnapshot()).toEqual({
        generation: 2,
        alive: true,
        lastTermination: { generation: 1, reason: 'abort' },
      })
      await bridge.terminate()
    })

    it('isolates a throwing subscriber from other subscribers and the bridge', async () => {
      const consoleError = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {})
      try {
        const { bridge, startWorker } = createFakeBridge()
        const after = vi.fn()
        bridge.subscribeLifecycle(() => {
          throw new Error('observer failed')
        })
        bridge.subscribeLifecycle(after)

        await expect(
          bridge.call('echo', new AbortController().signal, 1),
        ).resolves.toBe(1)
        await expect(bridge.terminate()).resolves.toBeUndefined()

        expect(after).toHaveBeenCalledTimes(2)
        const handle = startWorker.mock.results[0]?.value as {
          terminate: ReturnType<typeof vi.fn>
        }
        expect(handle.terminate).toHaveBeenCalledTimes(1)
        expect(consoleError).toHaveBeenCalledTimes(2)
      } finally {
        consoleError.mockRestore()
      }
    })

    it('never delivers a superseded snapshot after a subscriber terminates during notification', async () => {
      const { bridge } = createFakeBridge()
      bridge.subscribeLifecycle((snapshot) => {
        if (snapshot.alive) void bridge.terminate()
      })
      const received: unknown[] = []
      bridge.subscribeLifecycle((snapshot) => received.push(snapshot))

      await expect(
        bridge.call('echo', new AbortController().signal, 1),
      ).rejects.toThrow(/terminated/i)

      expect(bridge.getLifecycleSnapshot()).toEqual({
        generation: 1,
        alive: false,
        lastTermination: { generation: 1, reason: 'explicit' },
      })
      expect(received.at(-1)).toBe(bridge.getLifecycleSnapshot())
    })

    it('stops notifying after unsubscribe', async () => {
      const { bridge } = createFakeBridge()
      const listener = vi.fn()
      const unsubscribe = bridge.subscribeLifecycle(listener)
      unsubscribe()

      await bridge.call('echo', new AbortController().signal, 1)
      await bridge.terminate()

      expect(listener).not.toHaveBeenCalled()
    })

    it('does not let a subscriber hold the worker past the idle window', async () => {
      vi.useFakeTimers()
      try {
        const { bridge, startWorker } = createFakeBridge()
        bridge.subscribeLifecycle(() => {})
        await bridge.call('echo', new AbortController().signal, 1)

        await vi.advanceTimersByTimeAsync(10_000)

        const handle = startWorker.mock.results[0]?.value as {
          terminate: ReturnType<typeof vi.fn>
        }
        expect(handle.terminate).toHaveBeenCalledTimes(1)
      } finally {
        vi.useRealTimers()
      }
    })
  })
})
