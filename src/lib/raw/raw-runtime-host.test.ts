import type {
  LumaRawDecodeSession,
  LumaRawExportCapability,
  LumaRawFrame,
  LumaRawRuntime,
  LumaRawRuntimeInfo,
} from '@lumaforge/luma-raw-runtime'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { RawDecodeBridge } from '~/lib/workers/raw-decode-bridge'

import { QUICK_PREVIEW_MAX_PIXELS } from './decoder'
import type { RawRuntimeHostSnapshot } from './raw-runtime-host'
import { createRawRuntimeHost } from './raw-runtime-host'

function makeRuntimeInfo(): LumaRawRuntimeInfo {
  return {
    runtime: 'luma',
    version: '0.1.0',
    simd: true,
    pthreads: true,
    crossOriginIsolated: true,
    memoryTier: 'normal',
    memoryProfile: 'desktop',
    workerPoolSize: 2,
  }
}

function makeFrame(
  source: LumaRawFrame['source'],
  metadata: Partial<LumaRawFrame['metadata']> = {},
): LumaRawFrame {
  return {
    jobId: `${source}-1`,
    source,
    width: 1,
    height: 1,
    data: new Uint16Array([0, 32768, 65535]),
    layout: 'rgb',
    bitDepth: 16,
    colorSpace: 'linear-prophoto-rgb',
    orientation: 1,
    metadata: {
      width: 1,
      height: 1,
      make: 'Sony',
      model: 'A7',
      supportLevel: 'experimental',
      ...metadata,
    },
    timings: { total: 1 },
  }
}

function makeCapability(): LumaRawExportCapability {
  return {
    supported: true,
    width: 6240,
    height: 4168,
    rawWidth: 6240,
    rawHeight: 4168,
    visibleCrop: { x: 0, y: 0, width: 6240, height: 4168 },
    cfa: { pattern: 'rggb', xPhase: 0, yPhase: 0 },
    blackLevel: 0,
    whiteLevel: 65535,
    strategy: 'libraw-processed-window',
    orientation: { code: 1, supported: true },
    color: {
      workingSpace: 'linear-prophoto-rgb',
      librawOutputColor: 'prophoto',
      gamma: 'linear',
      cameraWhiteBalanceAppliedByRuntime: true,
      cameraMatrixAppliedByRuntime: true,
    },
    sensor: {
      layout: 'bayer',
      colorCount: 3,
      cfa: { pattern: 'rggb', xPhase: 0, yPhase: 0 },
      phaseIsWindowLocal: false,
    },
    levels: { black: 0, white: 65535 },
    windows: { librawProcessed: true, rawMosaic: false },
    diagnostics: {
      hasRawImage: true,
      hasColor3Image: false,
      hasColor4Image: false,
      hasXTransTable: false,
    },
    reasons: [],
  }
}

function makeSession(
  overrides: Partial<LumaRawDecodeSession> = {},
): LumaRawDecodeSession {
  return {
    sessionId: 'session-1',
    probe: {
      jobId: 'probe',
      width: 6240,
      height: 4168,
      supportLevel: 'experimental',
      timings: { total: 1 },
    },
    timings: { total: 1 },
    extractEmbeddedPreview: vi.fn().mockResolvedValue(null),
    probeExportCapability: vi.fn().mockResolvedValue(makeCapability()),
    readRawWindow: vi.fn(),
    readProcessedWindow: vi.fn(),
    decodeQuick: vi.fn().mockResolvedValue(makeFrame('quick')),
    decodeBoundedHq: vi.fn().mockResolvedValue(makeFrame('bounded-hq')),
    applyCalibration: vi.fn().mockResolvedValue({ applied: true } as const),
    dispose: vi.fn(),
    ...overrides,
  }
}

function makeRuntime(overrides: Partial<LumaRawRuntime> = {}) {
  return {
    init: vi.fn<LumaRawRuntime['init']>().mockResolvedValue(makeRuntimeInfo()),
    probe: vi.fn<LumaRawRuntime['probe']>(),
    extractEmbeddedPreview: vi
      .fn<LumaRawRuntime['extractEmbeddedPreview']>()
      .mockResolvedValue(null),
    decodeQuick: vi
      .fn<LumaRawRuntime['decodeQuick']>()
      .mockResolvedValue(makeFrame('quick')),
    decodeBoundedHq: vi
      .fn<LumaRawRuntime['decodeBoundedHq']>()
      .mockResolvedValue(makeFrame('bounded-hq')),
    openSession: vi
      .fn<LumaRawRuntime['openSession']>()
      .mockResolvedValue(makeSession()),
    dispose: vi.fn<LumaRawRuntime['dispose']>(),
    ...overrides,
  } satisfies LumaRawRuntime
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function coiError() {
  return Object.assign(new Error('Cross-origin isolation is required.'), {
    code: 'RAW_CROSS_ORIGIN_ISOLATION_REQUIRED',
  })
}

afterEach(() => {
  vi.useRealTimers()
})

describe('raw runtime host', () => {
  it('starts idle with no runtime generation and a stable snapshot', () => {
    const runtimeFactory = vi.fn(() => makeRuntime())
    const host = createRawRuntimeHost({ runtimeFactory })

    const snapshot = host.getSnapshot()

    expect(snapshot).toMatchObject({
      initialization: 'idle',
      outcome: null,
      runtime: {
        generation: 0,
        workerAlive: false,
        initialized: false,
        lastTermination: null,
      },
    })
    expect(host.getSnapshot()).toBe(snapshot)
    expect(host.getPrewarmState()).toBe('idle')
    expect(runtimeFactory).not.toHaveBeenCalled()
  })

  it('keeps independent hosts on separate runtimes and histories', async () => {
    const runtimeA = makeRuntime()
    const runtimeB = makeRuntime()
    const hostA = createRawRuntimeHost({ runtimeFactory: () => runtimeA })
    const hostB = createRawRuntimeHost({ runtimeFactory: () => runtimeB })

    await expect(hostA.prewarm()).resolves.toEqual({ status: 'ready' })

    expect(hostA.getSnapshot()).toMatchObject({
      initialization: 'ready',
      runtime: { workerAlive: true, initialized: true },
    })
    expect(hostB.getSnapshot()).toMatchObject({
      initialization: 'idle',
      runtime: { generation: 0, workerAlive: false },
    })
    expect(runtimeB.init).not.toHaveBeenCalled()

    await hostB.decodeQuickRaw(new File(['raw'], 'b.ARW'))
    await hostA.terminateDecodeBridge()

    expect(runtimeA.dispose).toHaveBeenCalledTimes(1)
    expect(runtimeB.dispose).not.toHaveBeenCalled()
    expect(hostB.getSnapshot().runtime).toMatchObject({ workerAlive: true })
  })

  it('shares one in-flight prewarm across concurrent callers', async () => {
    const init = deferred<LumaRawRuntimeInfo>()
    const runtime = makeRuntime({
      init: vi.fn<LumaRawRuntime['init']>(() => init.promise),
    })
    const runtimeFactory = vi.fn(() => runtime)
    const host = createRawRuntimeHost({ runtimeFactory })

    const first = host.prewarm()
    const second = host.prewarm()

    expect(second).toBe(first)
    expect(host.getSnapshot().initialization).toBe('pending')

    await vi.waitFor(() => expect(runtime.init).toHaveBeenCalledTimes(1))
    init.resolve(makeRuntimeInfo())

    await expect(Promise.all([first, second])).resolves.toEqual([
      { status: 'ready' },
      { status: 'ready' },
    ])
    expect(runtimeFactory).toHaveBeenCalledTimes(1)
    expect(runtime.init).toHaveBeenCalledTimes(1)
  })

  it('does not re-initialize a live, initialized runtime on a repeated prewarm', async () => {
    const runtime = makeRuntime()
    const host = createRawRuntimeHost({ runtimeFactory: () => runtime })

    const first = await host.prewarm()
    const second = await host.prewarm()

    expect(second).toBe(first)
    expect(runtime.init).toHaveBeenCalledTimes(1)
  })

  it('retries a recoverable prewarm failure on the next call', async () => {
    const runtime = makeRuntime()
    vi.mocked(runtime.init).mockRejectedValueOnce(new Error('network blip'))
    const host = createRawRuntimeHost({ runtimeFactory: () => runtime })

    await expect(host.prewarm()).resolves.toEqual({
      status: 'failed',
      reason: 'network blip',
      recoverable: true,
    })
    expect(host.getSnapshot()).toMatchObject({
      initialization: 'failed',
      outcome: { status: 'failed', recoverable: true },
      runtime: { initialized: false },
    })

    await expect(host.prewarm()).resolves.toEqual({ status: 'ready' })
    expect(host.getSnapshot()).toMatchObject({
      initialization: 'ready',
      runtime: { initialized: true },
    })
    expect(runtime.init).toHaveBeenCalledTimes(2)
  })

  it('keeps a cross-origin isolation failure sticky until dispose', async () => {
    const runtime = makeRuntime()
    vi.mocked(runtime.init).mockRejectedValue(coiError())
    const host = createRawRuntimeHost({ runtimeFactory: () => runtime })

    const first = await host.prewarm()
    const second = await host.prewarm()

    expect(first).toMatchObject({ status: 'failed', recoverable: false })
    expect(first.reason).toContain('Cross-origin isolation')
    expect(second).toBe(first)
    expect(runtime.init).toHaveBeenCalledTimes(1)

    host.dispose()
    expect(host.getSnapshot()).toMatchObject({
      initialization: 'idle',
      outcome: null,
    })

    vi.mocked(runtime.init).mockResolvedValue(makeRuntimeInfo())
    await expect(host.prewarm()).resolves.toEqual({ status: 'ready' })
    expect(runtime.init).toHaveBeenCalledTimes(2)
  })

  it('reports idle termination as lost liveness while keeping initialization history, then rewarms', async () => {
    vi.useFakeTimers()
    const runtime = makeRuntime()
    const host = createRawRuntimeHost({
      runtimeFactory: () => runtime,
      idleMs: 1_000,
    })
    const snapshots: RawRuntimeHostSnapshot[] = []
    host.subscribe(() => snapshots.push(host.getSnapshot()))

    await host.prewarm()
    const ready = host.getSnapshot()
    expect(ready).toMatchObject({
      initialization: 'ready',
      runtime: { generation: 1, workerAlive: true, initialized: true },
    })

    await vi.advanceTimersByTimeAsync(1_000)

    const idle = host.getSnapshot()
    expect(runtime.dispose).toHaveBeenCalledTimes(1)
    expect(idle).not.toBe(ready)
    expect(idle).toMatchObject({
      initialization: 'ready',
      outcome: { status: 'ready' },
      runtime: {
        generation: 1,
        workerAlive: false,
        initialized: false,
        lastTermination: { generation: 1, reason: 'idle' },
      },
    })
    expect(snapshots.at(-1)).toBe(idle)

    await expect(host.prewarm()).resolves.toEqual({ status: 'ready' })
    expect(runtime.init).toHaveBeenCalledTimes(2)
    expect(host.getSnapshot()).toMatchObject({
      initialization: 'ready',
      runtime: { generation: 2, workerAlive: true, initialized: true },
    })
  })

  it('ignores a prewarm that completes after its runtime was terminated', async () => {
    const init = deferred<LumaRawRuntimeInfo>()
    const runtime = makeRuntime({
      init: vi.fn<LumaRawRuntime['init']>(() => init.promise),
    })
    const host = createRawRuntimeHost({ runtimeFactory: () => runtime })

    const prewarm = host.prewarm()
    await vi.waitFor(() => expect(runtime.init).toHaveBeenCalledTimes(1))
    await host.terminateDecodeBridge()
    init.resolve(makeRuntimeInfo())

    await expect(prewarm).resolves.toMatchObject({
      status: 'failed',
      recoverable: true,
    })
    expect(host.getSnapshot()).toMatchObject({
      initialization: 'idle',
      outcome: null,
      runtime: {
        workerAlive: false,
        initialized: false,
        lastTermination: { reason: 'explicit' },
      },
    })
  })

  it('ignores a prewarm failure caused by terminating its runtime', async () => {
    const init = deferred<LumaRawRuntimeInfo>()
    const runtime = makeRuntime({
      init: vi.fn<LumaRawRuntime['init']>(() => init.promise),
    })
    const host = createRawRuntimeHost({ runtimeFactory: () => runtime })

    const prewarm = host.prewarm()
    await vi.waitFor(() => expect(runtime.init).toHaveBeenCalledTimes(1))
    await host.terminateDecodeBridge()
    init.reject(new Error('RAW runtime worker was disposed.'))

    await expect(prewarm).resolves.toMatchObject({ status: 'failed' })
    expect(host.getSnapshot()).toMatchObject({
      initialization: 'idle',
      outcome: null,
    })

    vi.mocked(runtime.init).mockResolvedValue(makeRuntimeInfo())
    await expect(host.prewarm()).resolves.toEqual({ status: 'ready' })
    expect(runtime.init).toHaveBeenCalledTimes(2)
  })

  it('lets an obsolete prewarm neither overwrite a reset nor clear a newer attempt', async () => {
    const stale = deferred<LumaRawRuntimeInfo>()
    const fresh = deferred<LumaRawRuntimeInfo>()
    const runtime = makeRuntime({
      init: vi
        .fn<LumaRawRuntime['init']>()
        .mockImplementationOnce(() => stale.promise)
        .mockImplementationOnce(() => fresh.promise),
    })
    const host = createRawRuntimeHost({ runtimeFactory: () => runtime })

    const obsolete = host.prewarm()
    await vi.waitFor(() => expect(runtime.init).toHaveBeenCalledTimes(1))
    host.dispose()
    expect(host.getSnapshot().initialization).toBe('idle')

    const current = host.prewarm()
    expect(current).not.toBe(obsolete)
    stale.resolve(makeRuntimeInfo())
    await expect(obsolete).resolves.toMatchObject({ status: 'failed' })

    await vi.waitFor(() => expect(runtime.init).toHaveBeenCalledTimes(2))
    expect(host.getSnapshot().initialization).toBe('pending')
    expect(host.prewarm()).toBe(current)

    fresh.resolve(makeRuntimeInfo())
    await expect(current).resolves.toEqual({ status: 'ready' })
    expect(host.getSnapshot()).toMatchObject({
      initialization: 'ready',
      runtime: { workerAlive: true, initialized: true },
    })
  })

  it('lets a disposed attempt that fails late neither record its failure nor end the newer attempt', async () => {
    const stale = deferred<LumaRawRuntimeInfo>()
    const fresh = deferred<LumaRawRuntimeInfo>()
    const runtime = makeRuntime({
      init: vi
        .fn<LumaRawRuntime['init']>()
        .mockImplementationOnce(() => stale.promise)
        .mockImplementationOnce(() => fresh.promise),
    })
    const host = createRawRuntimeHost({ runtimeFactory: () => runtime })

    const attemptA = host.prewarm()
    await vi.waitFor(() => expect(runtime.init).toHaveBeenCalledTimes(1))
    host.dispose()
    const attemptB = host.prewarm()
    expect(attemptB).not.toBe(attemptA)

    // A sticky failure from the disposed attempt must not become history.
    stale.reject(coiError())
    await expect(attemptA).resolves.toMatchObject({ status: 'failed' })

    expect(host.getSnapshot()).toMatchObject({
      initialization: 'pending',
      outcome: null,
    })
    expect(host.prewarm()).toBe(attemptB)
    await vi.waitFor(() => expect(runtime.init).toHaveBeenCalledTimes(2))

    fresh.resolve(makeRuntimeInfo())
    await expect(attemptB).resolves.toEqual({ status: 'ready' })
    expect(host.getSnapshot()).toMatchObject({
      initialization: 'ready',
      outcome: { status: 'ready' },
    })
  })

  it('isolates a throwing subscriber and stops notifying after unsubscribe', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const host = createRawRuntimeHost({ runtimeFactory: () => makeRuntime() })
      const throwing = vi.fn(() => {
        throw new Error('observer exploded')
      })
      const observer = vi.fn()
      host.subscribe(throwing)
      const unsubscribe = host.subscribe(observer)

      await expect(host.prewarm()).resolves.toEqual({ status: 'ready' })
      expect(throwing).toHaveBeenCalled()
      expect(observer).toHaveBeenCalled()

      unsubscribe()
      observer.mockClear()
      await host.terminateDecodeBridge()
      expect(observer).not.toHaveBeenCalled()
    } finally {
      consoleError.mockRestore()
    }
  })

  it('builds its bridge through the injected bridge factory', async () => {
    const runtime = makeRuntime()
    const createBridge = vi.fn(
      (options: ConstructorParameters<typeof RawDecodeBridge>[0]) =>
        new RawDecodeBridge(options),
    )
    const host = createRawRuntimeHost({
      runtimeFactory: () => runtime,
      idleMs: 1_234,
      createBridge,
    })

    await host.prewarm()

    expect(createBridge).toHaveBeenCalledTimes(1)
    expect(createBridge.mock.calls[0]?.[0]).toMatchObject({ idleMs: 1_234 })
    expect(runtime.init).toHaveBeenCalledTimes(1)
  })

  it('opens sessions with the shared conversion and export capability gate', async () => {
    const session = makeSession({
      decodeQuick: vi
        .fn()
        .mockResolvedValue(makeFrame('quick', { baselineExposure: 1 })),
    })
    const runtime = makeRuntime({
      openSession: vi
        .fn<LumaRawRuntime['openSession']>()
        .mockResolvedValue(session),
    })
    const jpegRuntimeAvailabilityProbe = vi.fn().mockReturnValue(false)
    const host = createRawRuntimeHost({
      runtimeFactory: () => runtime,
      jpegRuntimeAvailabilityProbe,
    })
    const file = new File(['raw'], 'a.DNG')
    const signal = new AbortController().signal

    const opened = await host.openSession(file, signal)
    const image = await opened.decodeQuickRaw(undefined, signal)

    expect(runtime.openSession).toHaveBeenCalledWith(
      file,
      { maxOutputPixels: QUICK_PREVIEW_MAX_PIXELS },
      signal,
    )
    expect(opened.sourceDimensions).toEqual({ width: 6240, height: 4168 })
    expect(image).toMatchObject({
      layout: 'rgb-u16',
      colorSpace: 'linear-prophoto-rgb',
      source: 'quick',
      metadata: { make: 'Sony', model: 'A7', width: 1, height: 1 },
      renderExposure: { ev: 1, multiplier: 2, source: 'dng-baseline' },
    })
    await expect(opened.probeExportCapability?.()).rejects.toThrow()
    expect(jpegRuntimeAvailabilityProbe).toHaveBeenCalledTimes(1)

    opened.dispose()
    expect(session.dispose).toHaveBeenCalledTimes(1)
  })

  describe('session leases', () => {
    function makeLeaseHost(openSession: LumaRawRuntime['openSession']) {
      const runtime = makeRuntime({ openSession: vi.fn(openSession) })
      return {
        runtime,
        host: createRawRuntimeHost({ runtimeFactory: () => runtime }),
      }
    }

    it('opens one source per lease and disposes it once however the lease ends', async () => {
      const session = makeSession()
      const { runtime, host } = makeLeaseHost(async () => session)
      const file = new File(['raw'], 'a.ARW')

      const lease = host.beginSession()
      const opened = await lease.open(file)

      expect(runtime.openSession).toHaveBeenCalledTimes(1)
      expect(runtime.openSession).toHaveBeenCalledWith(
        file,
        { maxOutputPixels: QUICK_PREVIEW_MAX_PIXELS },
        lease.signal,
      )
      expect(opened.sourceDimensions).toEqual({ width: 6240, height: 4168 })
      await expect(lease.open(file)).rejects.toThrow()
      expect(runtime.openSession).toHaveBeenCalledTimes(1)
      expect(lease.signal.aborted).toBe(false)
      expect(session.dispose).not.toHaveBeenCalled()

      // A settled load gives its session back without aborting anything.
      lease.release()
      lease.release()
      lease.cancel()
      host.cancelSession()

      expect(lease.signal.aborted).toBe(false)
      expect(session.dispose).toHaveBeenCalledTimes(1)
    })

    it('aborts work still in flight when a lease is cancelled', async () => {
      const session = makeSession()
      const { host } = makeLeaseHost(async () => session)
      const lease = host.beginSession()
      await lease.open(new File(['raw'], 'a.ARW'))

      host.cancelSession()
      lease.cancel()
      lease.release()

      expect(lease.signal.aborted).toBe(true)
      expect(session.dispose).toHaveBeenCalledTimes(1)
    })

    it('never opens a source on a lease that was already released', async () => {
      const { runtime, host } = makeLeaseHost(async () => makeSession())

      const lease = host.beginSession()
      lease.release()

      await expect(
        lease.open(new File(['raw'], 'a.ARW')),
      ).rejects.toMatchObject({ name: 'AbortError' })
      expect(runtime.openSession).not.toHaveBeenCalled()
    })

    it('cancels the previous lease when the next one begins', async () => {
      const first = makeSession({ sessionId: 'first' })
      const second = makeSession({ sessionId: 'second' })
      const { host } = makeLeaseHost(
        vi
          .fn<LumaRawRuntime['openSession']>()
          .mockResolvedValueOnce(first)
          .mockResolvedValueOnce(second),
      )
      const leaseA = host.beginSession()
      await leaseA.open(new File(['raw'], 'a.ARW'))

      const leaseB = host.beginSession()

      expect(leaseA.signal.aborted).toBe(true)
      expect(first.dispose).toHaveBeenCalledTimes(1)
      await leaseB.open(new File(['raw'], 'b.ARW'))
      expect(leaseB.signal.aborted).toBe(false)

      // A late end of the superseded lease leaves the active one alone.
      leaseA.release()
      leaseA.cancel()
      expect(second.dispose).not.toHaveBeenCalled()
      expect(leaseB.signal.aborted).toBe(false)

      host.cancelSession()
      expect(leaseB.signal.aborted).toBe(true)
      expect(second.dispose).toHaveBeenCalledTimes(1)
    })

    it('disposes a session that opens after its lease was cancelled', async () => {
      const lateOpen = deferred<LumaRawDecodeSession>()
      const late = makeSession({ sessionId: 'late' })
      const { runtime, host } = makeLeaseHost(() => lateOpen.promise)

      const lease = host.beginSession()
      const opening = lease.open(new File(['raw'], 'a.ARW'))
      await vi.waitFor(() => expect(runtime.openSession).toHaveBeenCalled())
      lease.cancel()
      lateOpen.resolve(late)

      await expect(opening).rejects.toMatchObject({ name: 'AbortError' })
      expect(late.dispose).toHaveBeenCalledTimes(1)
    })

    it('cancels the active lease when the host is disposed', async () => {
      const session = makeSession()
      const { host } = makeLeaseHost(async () => session)
      const lease = host.beginSession()
      await lease.open(new File(['raw'], 'a.ARW'))

      host.dispose()

      expect(lease.signal.aborted).toBe(true)
      expect(session.dispose).toHaveBeenCalledTimes(1)
    })
  })

  it('normalizes stage failures to RAW adapter error codes', async () => {
    const runtime = makeRuntime({
      decodeQuick: vi
        .fn<LumaRawRuntime['decodeQuick']>()
        .mockRejectedValue(new Error('quick exploded')),
      openSession: vi
        .fn<LumaRawRuntime['openSession']>()
        .mockRejectedValue(new Error('open exploded')),
    })
    const host = createRawRuntimeHost({ runtimeFactory: () => runtime })

    await expect(
      host.decodeQuickRaw(new File(['raw'], 'a.ARW')),
    ).rejects.toMatchObject({
      name: 'RawAdapterError',
      code: 'RAW_QUICK_DECODE_FAILED',
      message: 'quick exploded',
    })
    await expect(
      host.openSession(new File(['raw'], 'a.ARW')),
    ).rejects.toMatchObject({
      name: 'RawAdapterError',
      code: 'RAW_OPEN_FAILED',
      message: 'open exploded',
    })
  })
})
