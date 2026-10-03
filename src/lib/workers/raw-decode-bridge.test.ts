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
})
