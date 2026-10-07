import type { LumaRawRuntime } from '@lumaforge/luma-raw-runtime'
import { describe, expect, it, vi } from 'vitest'

import { RawDecodeBridge } from './raw-decode-bridge'

function fakeRuntime(): LumaRawRuntime {
  return {
    init: vi.fn(async () => ({}) as never),
    dispose: vi.fn(),
    openSession: vi.fn(async () => ({}) as never),
    probe: vi.fn(async () => ({}) as never),
    extractEmbeddedPreview: vi.fn(async () => null),
    decodeQuick: vi.fn(async () => ({}) as never),
    decodeBoundedHq: vi.fn(async () => ({}) as never),
  } as unknown as LumaRawRuntime
}

describe('rawDecodeBridge', () => {
  it('lazy-creates the runtime exactly once across concurrent decodes', async () => {
    const factory = vi.fn(fakeRuntime)
    const bridge = new RawDecodeBridge({
      runtimeFactory: factory,
      idleMs: 10_000,
    })
    const signal = new AbortController().signal

    await Promise.all([
      bridge.decodeEmbedded(signal, new File([], 'a.dng')),
      bridge.decodeQuick(signal, new File([], 'a.dng')),
    ])

    expect(factory).toHaveBeenCalledTimes(1)
  })

  it('re-creates the runtime after terminate()', async () => {
    const factory = vi.fn(fakeRuntime)
    const bridge = new RawDecodeBridge({ runtimeFactory: factory })
    const signal = new AbortController().signal

    await bridge.decodeEmbedded(signal, new File([], 'a.dng'))
    await bridge.terminate()
    await bridge.decodeEmbedded(signal, new File([], 'a.dng'))

    expect(factory).toHaveBeenCalledTimes(2)
  })

  it('keeps the runtime alive while an opened session is open', async () => {
    vi.useFakeTimers()
    try {
      const runtime = fakeRuntime()
      const sessionDispose = vi.fn()
      vi.mocked(runtime.openSession).mockResolvedValue({
        sessionId: 'session-1',
        dispose: sessionDispose,
      } as never)
      const bridge = new RawDecodeBridge({
        runtimeFactory: () => runtime,
        idleMs: 100,
      })

      const session = await bridge.openSession(
        new AbortController().signal,
        new File([], 'a.raf'),
      )
      await vi.advanceTimersByTimeAsync(1_000)
      expect(runtime.dispose).not.toHaveBeenCalled()

      session.dispose()
      expect(sessionDispose).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(100)
      expect(runtime.dispose).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('still disposes the runtime on an explicit terminate while a session is open', async () => {
    const runtime = fakeRuntime()
    vi.mocked(runtime.openSession).mockResolvedValue({
      sessionId: 'session-1',
      dispose: vi.fn(),
    } as never)
    const bridge = new RawDecodeBridge({ runtimeFactory: () => runtime })

    await bridge.openSession(
      new AbortController().signal,
      new File([], 'a.raf'),
    )
    await bridge.terminate()

    expect(runtime.dispose).toHaveBeenCalledTimes(1)
  })

  it('prewarms by calling runtime init through the bridge', async () => {
    const runtime = fakeRuntime()
    const bridge = new RawDecodeBridge({ runtimeFactory: () => runtime })

    await bridge.prewarm(new AbortController().signal)

    expect(runtime.init).toHaveBeenCalledTimes(1)
  })

  it('runs bridge calls serially in submission order', async () => {
    const runtime = fakeRuntime()
    const order: string[] = []
    const gate: { open: (() => void) | null } = { open: null }
    vi.mocked(runtime.probe).mockImplementation(async () => {
      order.push('probe:start')
      await new Promise<void>((resolve) => {
        gate.open = resolve
      })
      order.push('probe:end')
      return {} as never
    })
    vi.mocked(runtime.decodeQuick).mockImplementation(async () => {
      order.push('quick')
      return {} as never
    })
    const bridge = new RawDecodeBridge({ runtimeFactory: () => runtime })
    const signal = new AbortController().signal

    const probe = bridge.probe(signal, new File([], 'a.dng'))
    const quick = bridge.decodeQuick(signal, new File([], 'a.dng'))
    await vi.waitFor(() => expect(gate.open).toBeTypeOf('function'))
    expect(order).toEqual(['probe:start'])
    gate.open?.()
    await Promise.all([probe, quick])

    expect(order).toEqual(['probe:start', 'probe:end', 'quick'])
    await bridge.terminate()
  })

  it('disposes the runtime exactly once when a released session outlives an explicit terminate', async () => {
    vi.useFakeTimers()
    try {
      const runtime = fakeRuntime()
      vi.mocked(runtime.openSession).mockResolvedValue({
        sessionId: 'session-1',
        dispose: vi.fn(),
      } as never)
      const bridge = new RawDecodeBridge({
        runtimeFactory: () => runtime,
        idleMs: 100,
      })
      const session = await bridge.openSession(
        new AbortController().signal,
        new File([], 'a.raf'),
      )

      await bridge.terminate()
      session.dispose()
      await vi.advanceTimersByTimeAsync(1_000)

      expect(runtime.dispose).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  describe('lifecycle observations', () => {
    it('separates a live runtime from a successfully initialized one', async () => {
      const runtime = fakeRuntime()
      const bridge = new RawDecodeBridge({ runtimeFactory: () => runtime })
      const initial = bridge.getLifecycleSnapshot()
      expect(initial).toEqual({
        generation: 0,
        workerAlive: false,
        initialized: false,
        lastTermination: null,
      })
      expect(bridge.getLifecycleSnapshot()).toBe(initial)

      await bridge.decodeEmbedded(
        new AbortController().signal,
        new File([], 'a.dng'),
      )
      expect(bridge.getLifecycleSnapshot()).toEqual({
        generation: 1,
        workerAlive: true,
        initialized: false,
        lastTermination: null,
      })

      await bridge.prewarm(new AbortController().signal)
      expect(bridge.getLifecycleSnapshot()).toEqual({
        generation: 1,
        workerAlive: true,
        initialized: true,
        lastTermination: null,
      })
      await bridge.terminate()
    })

    it('does not report initialization when runtime init fails', async () => {
      const runtime = fakeRuntime()
      vi.mocked(runtime.init).mockRejectedValue(new Error('init failed'))
      const bridge = new RawDecodeBridge({ runtimeFactory: () => runtime })

      await expect(
        bridge.prewarm(new AbortController().signal),
      ).rejects.toThrow('init failed')

      expect(bridge.getLifecycleSnapshot()).toMatchObject({
        generation: 1,
        workerAlive: true,
        initialized: false,
      })
      await bridge.terminate()
    })

    it('follows idle termination instead of the earlier prewarm success', async () => {
      vi.useFakeTimers()
      try {
        const runtime = fakeRuntime()
        const bridge = new RawDecodeBridge({
          runtimeFactory: () => runtime,
          idleMs: 100,
        })
        const listener = vi.fn()
        bridge.subscribeLifecycle(listener)

        await bridge.prewarm(new AbortController().signal)
        expect(bridge.getLifecycleSnapshot().initialized).toBe(true)
        listener.mockClear()

        await vi.advanceTimersByTimeAsync(100)

        expect(runtime.dispose).toHaveBeenCalledTimes(1)
        expect(listener).toHaveBeenCalledTimes(1)
        expect(bridge.getLifecycleSnapshot()).toEqual({
          generation: 1,
          workerAlive: false,
          initialized: false,
          lastTermination: { generation: 1, reason: 'idle' },
        })
      } finally {
        vi.useRealTimers()
      }
    })

    it('stays live while a session lease outlasts the idle window, then reports idle after release', async () => {
      vi.useFakeTimers()
      try {
        const runtime = fakeRuntime()
        vi.mocked(runtime.openSession).mockResolvedValue({
          sessionId: 'session-1',
          dispose: vi.fn(),
        } as never)
        const bridge = new RawDecodeBridge({
          runtimeFactory: () => runtime,
          idleMs: 100,
        })
        await bridge.prewarm(new AbortController().signal)
        const session = await bridge.openSession(
          new AbortController().signal,
          new File([], 'a.raf'),
        )

        await vi.advanceTimersByTimeAsync(1_000)
        expect(bridge.getLifecycleSnapshot()).toMatchObject({
          workerAlive: true,
          initialized: true,
        })

        session.dispose()
        await vi.advanceTimersByTimeAsync(100)
        expect(bridge.getLifecycleSnapshot()).toMatchObject({
          workerAlive: false,
          initialized: false,
          lastTermination: { generation: 1, reason: 'idle' },
        })
      } finally {
        vi.useRealTimers()
      }
    })

    it('ignores an init that completes after its generation was terminated', async () => {
      const runtimes: LumaRawRuntime[] = []
      const pendingInit: { resolve: (() => void) | null } = { resolve: null }
      const factory = vi.fn(() => {
        const runtime = fakeRuntime()
        if (runtimes.length === 0) {
          vi.mocked(runtime.init).mockImplementation(
            () =>
              new Promise((resolve) => {
                pendingInit.resolve = () => resolve({} as never)
              }),
          )
        }
        runtimes.push(runtime)
        return runtime
      })
      const bridge = new RawDecodeBridge({ runtimeFactory: factory })
      const listener = vi.fn()
      bridge.subscribeLifecycle(listener)

      const staleInit = bridge.prewarm(new AbortController().signal)
      await vi.waitFor(() => expect(pendingInit.resolve).toBeTypeOf('function'))
      await bridge.terminate()
      const nextCall = bridge.decodeQuick(
        new AbortController().signal,
        new File([], 'a.dng'),
      )
      pendingInit.resolve?.()
      await staleInit
      await nextCall

      expect(factory).toHaveBeenCalledTimes(2)
      expect(bridge.getLifecycleSnapshot()).toEqual({
        generation: 2,
        workerAlive: true,
        initialized: false,
        lastTermination: { generation: 1, reason: 'explicit' },
      })
      // The stale completion publishes nothing at all.
      expect(listener.mock.calls.map(([snapshot]) => snapshot)).toEqual([
        {
          generation: 1,
          workerAlive: true,
          initialized: false,
          lastTermination: null,
        },
        {
          generation: 1,
          workerAlive: false,
          initialized: false,
          lastTermination: { generation: 1, reason: 'explicit' },
        },
        {
          generation: 2,
          workerAlive: true,
          initialized: false,
          lastTermination: { generation: 1, reason: 'explicit' },
        },
      ])
      await bridge.terminate()
    })

    it('ignores an init that completes after an abort terminated its generation', async () => {
      const runtime = fakeRuntime()
      const pendingInit: { resolve: (() => void) | null } = { resolve: null }
      vi.mocked(runtime.init).mockImplementation(
        () =>
          new Promise((resolve) => {
            pendingInit.resolve = () => resolve({} as never)
          }),
      )
      const bridge = new RawDecodeBridge({ runtimeFactory: () => runtime })
      const controller = new AbortController()

      const prewarm = bridge.prewarm(controller.signal)
      await vi.waitFor(() => expect(pendingInit.resolve).toBeTypeOf('function'))
      controller.abort()
      pendingInit.resolve?.()
      await prewarm.catch(() => undefined)

      expect(runtime.dispose).toHaveBeenCalledTimes(1)
      expect(bridge.getLifecycleSnapshot()).toEqual({
        generation: 1,
        workerAlive: false,
        initialized: false,
        lastTermination: { generation: 1, reason: 'abort' },
      })
    })

    it('never delivers a superseded snapshot after a subscriber terminates during notification', async () => {
      const runtime = fakeRuntime()
      const bridge = new RawDecodeBridge({ runtimeFactory: () => runtime })
      bridge.subscribeLifecycle((snapshot) => {
        if (snapshot.initialized) void bridge.terminate()
      })
      const received: unknown[] = []
      bridge.subscribeLifecycle((snapshot) => received.push(snapshot))

      await bridge.prewarm(new AbortController().signal)

      expect(runtime.dispose).toHaveBeenCalledTimes(1)
      expect(bridge.getLifecycleSnapshot()).toEqual({
        generation: 1,
        workerAlive: false,
        initialized: false,
        lastTermination: { generation: 1, reason: 'explicit' },
      })
      expect(received.at(-1)).toBe(bridge.getLifecycleSnapshot())
    })

    it('isolates a throwing subscriber from the RAW calls', async () => {
      const consoleError = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {})
      try {
        const runtime = fakeRuntime()
        const bridge = new RawDecodeBridge({ runtimeFactory: () => runtime })
        const after = vi.fn()
        bridge.subscribeLifecycle(() => {
          throw new Error('observer failed')
        })
        bridge.subscribeLifecycle(after)

        await expect(
          bridge.prewarm(new AbortController().signal),
        ).resolves.toBeDefined()
        await bridge.terminate()

        expect(after).toHaveBeenCalledTimes(3)
        expect(runtime.dispose).toHaveBeenCalledTimes(1)
        expect(consoleError).toHaveBeenCalled()
      } finally {
        consoleError.mockRestore()
      }
    })
  })
})
