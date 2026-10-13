import type {
  LumaRawDecodeSession,
  LumaRawExportCapability,
  LumaRawFrame,
  LumaRawRuntime,
  LumaRawRuntimeInfo,
} from '@lumaforge/luma-raw-runtime'
import {
  BOUNDED_HQ_PREVIEW_MAX_PIXELS,
  QUICK_PREVIEW_MAX_PIXELS,
} from '@lumaforge/render-engine/preview'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  RawRuntimeHostOptions,
  RawRuntimeHostSnapshot,
} from './raw-runtime-host'
import { createRawRuntimeHost } from './raw-runtime-host'

function makeRuntimeInfo(): LumaRawRuntimeInfo {
  return {
    runtime: 'luma',
    version: '0.1.0',
    crossOriginIsolated: true,
    memoryProfile: 'desktop',
  }
}

function makeFrame(
  source: LumaRawFrame['source'],
  metadata: Partial<LumaRawFrame['metadata']> = {},
): LumaRawFrame {
  return {
    jobId: `${source}-1`,
    sessionId: 'session-1',
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

/** A supported capability carrying every fact the native runtime declares. */
function makeCapability(): LumaRawExportCapability {
  return {
    supported: true,
    width: 6240,
    height: 4168,
    rawWidth: 6240,
    rawHeight: 4168,
    visibleCrop: { x: 0, y: 0, width: 6240, height: 4168 },
    blackLevel: 0,
    whiteLevel: 65535,
    strategy: 'libraw-processed-window',
    orientation: {
      code: 1,
      supported: true,
      outputWidth: 6240,
      outputHeight: 4168,
    },
    color: {
      whiteBalance: [2.0546875, 1, 1.5234375, 1],
      cameraToWorkingRgb: [
        1.6205, -0.4859, -0.1346, -0.1238, 1.3117, -0.1879, 0.0215, -0.2521,
        1.2306,
      ],
      workingSpace: 'linear-prophoto-rgb',
      librawOutputColor: 'prophoto',
      gamma: 'linear',
      cameraWhiteBalanceAppliedByRuntime: true,
      cameraMatrixAppliedByRuntime: true,
    },
    sensor: {
      layout: 'bayer',
      cfa: { pattern: 'rggb', xPhase: 0, yPhase: 0 },
    },
    windows: { librawProcessed: true },
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

type WorkerOperation =
  | 'init'
  | 'openSession'
  | 'extractEmbeddedPreview'
  | 'decodeQuick'
  | 'decodeBoundedHq'

/**
 * A runtime that behaves like the real decode worker: it runs one request
 * at a time and cannot interrupt native work in flight. `dispose` settles
 * nothing, so a held request stays unresolved and every later request on
 * the same runtime waits behind it.
 */
function makeWorkerLikeRuntime() {
  let tail: Promise<unknown> = Promise.resolve()
  const gates = new Map<WorkerOperation, ReturnType<typeof deferred<void>>>()
  function run<T>(operation: WorkerOperation, value: () => T): Promise<T> {
    const job = tail.then(async () => {
      await gates.get(operation)?.promise
      return value()
    })
    tail = job.catch(() => undefined)
    return job
  }
  const session = makeSession({
    extractEmbeddedPreview: vi.fn(() =>
      run('extractEmbeddedPreview', () => null),
    ),
    decodeQuick: vi.fn(() => run('decodeQuick', () => makeFrame('quick'))),
    decodeBoundedHq: vi.fn(() =>
      run('decodeBoundedHq', () => makeFrame('bounded-hq')),
    ),
  })
  const runtime = makeRuntime({
    init: vi.fn<LumaRawRuntime['init']>(() => run('init', makeRuntimeInfo)),
    openSession: vi.fn<LumaRawRuntime['openSession']>(() =>
      run('openSession', () => session),
    ),
  })
  return {
    runtime,
    session,
    /** Holds `operation` until the returned gate opens. */
    hold(operation: WorkerOperation) {
      const gate = deferred<void>()
      gates.set(operation, gate)
      return gate
    },
  }
}

/** One worker-like runtime per runtime generation the host starts. */
function createWorkerLikeRuntimes(
  configure: (
    worker: ReturnType<typeof makeWorkerLikeRuntime>,
    index: number,
  ) => void = () => {},
) {
  const workers: Array<ReturnType<typeof makeWorkerLikeRuntime>> = []
  const runtimeFactory = vi.fn(() => {
    const worker = makeWorkerLikeRuntime()
    configure(worker, workers.length)
    workers.push(worker)
    return worker.runtime
  })
  return { workers, runtimeFactory }
}

async function flushMicrotasks(rounds = 8) {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve()
}

/** Resolves once `promise` fulfils; fails the test if it stays pending. */
async function settled<T>(promise: Promise<T>) {
  let outcome: { value: T } | null = null
  void promise.then((value) => {
    outcome = { value }
  })
  await vi.waitFor(() => expect(outcome).not.toBeNull())
  return outcome!.value
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

    await hostB.prewarm()
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
    const lease = host.beginSession()

    const opened = await lease.open(file)
    const image = await opened.decodeQuickRaw(undefined, lease.signal)

    expect(runtime.openSession).toHaveBeenCalledWith(
      file,
      { maxOutputPixels: QUICK_PREVIEW_MAX_PIXELS },
      lease.signal,
    )
    expect(opened.sourceDimensions).toEqual({ width: 6240, height: 4168 })
    expect(image).toMatchObject({
      source: 'quick',
      metadata: { make: 'Sony', model: 'A7', width: 1, height: 1 },
      renderExposure: { ev: 1, multiplier: 2, source: 'dng-baseline' },
    })
    await expect(opened.probeExportCapability?.()).rejects.toThrow()
    expect(jpegRuntimeAvailabilityProbe).toHaveBeenCalledTimes(1)

    opened.dispose()
    expect(session.dispose).toHaveBeenCalledTimes(1)
  })

  it('opens one session and runs every stage with the caller signal', async () => {
    const session = makeSession()
    const runtime = makeRuntime({
      openSession: vi
        .fn<LumaRawRuntime['openSession']>()
        .mockResolvedValue(session),
    })
    const host = createRawRuntimeHost({
      runtimeFactory: () => runtime,
      jpegRuntimeAvailabilityProbe: () => true,
    })
    const stageSignal = new AbortController().signal

    const opened = await host.beginSession().open(new File(['raw'], 'a.ARW'))
    await opened.extractEmbeddedPreview(stageSignal)
    await opened.decodeQuickRaw(undefined, stageSignal)
    await opened.decodeBoundedHqRaw(
      { maxOutputPixels: BOUNDED_HQ_PREVIEW_MAX_PIXELS },
      undefined,
      stageSignal,
    )

    expect(session.extractEmbeddedPreview).toHaveBeenCalledWith(stageSignal)
    expect(session.decodeQuick).toHaveBeenCalledWith(
      { maxOutputPixels: QUICK_PREVIEW_MAX_PIXELS },
      stageSignal,
    )
    expect(session.decodeBoundedHq).toHaveBeenCalledWith(
      { maxOutputPixels: BOUNDED_HQ_PREVIEW_MAX_PIXELS },
      stageSignal,
    )
  })

  it('carries a pinned exposure on the app side without changing the runtime request', async () => {
    const session = makeSession()
    const runtime = makeRuntime({
      openSession: vi
        .fn<LumaRawRuntime['openSession']>()
        .mockResolvedValue(session),
    })
    const host = createRawRuntimeHost({ runtimeFactory: () => runtime })
    const pinnedExposure = {
      ev: 0.75,
      multiplier: Math.pow(2, 0.75),
      source: 'image-statistics',
    } as const

    const opened = await host.beginSession().open(new File(['raw'], 'a.ARW'))
    const hq = await opened.decodeBoundedHqRaw({
      maxOutputPixels: BOUNDED_HQ_PREVIEW_MAX_PIXELS,
      pinnedExposure,
    })

    expect(hq.renderExposure).toEqual(pinnedExposure)
    expect(session.decodeBoundedHq).toHaveBeenCalledWith(
      { maxOutputPixels: BOUNDED_HQ_PREVIEW_MAX_PIXELS },
      undefined,
    )
  })

  describe('export capability gate', () => {
    async function probe(capability: LumaRawExportCapability) {
      const jpegRuntimeAvailabilityProbe = vi.fn().mockReturnValue(true)
      const runtime = makeRuntime({
        openSession: vi.fn<LumaRawRuntime['openSession']>().mockResolvedValue(
          makeSession({
            probeExportCapability: vi.fn().mockResolvedValue(capability),
          }),
        ),
      })
      const host = createRawRuntimeHost({
        runtimeFactory: () => runtime,
        jpegRuntimeAvailabilityProbe,
      })
      const opened = await host.beginSession().open(new File(['raw'], 'a.ARW'))
      return {
        result: await opened.probeExportCapability?.(),
        jpegRuntimeAvailabilityProbe,
      }
    }

    it('keeps the processed-window facts once the JPEG runtime is available', async () => {
      const { result, jpegRuntimeAvailabilityProbe } =
        await probe(makeCapability())

      expect(result).toEqual(makeCapability())
      expect(jpegRuntimeAvailabilityProbe).toHaveBeenCalledTimes(1)
    })

    it.each([
      ['missing color facts', { color: undefined }, 'missing-color-transform'],
      [
        'no processed window',
        { windows: { librawProcessed: false } },
        'processed-window-unavailable',
      ],
      [
        'a camera matrix the runtime did not apply',
        {
          color: {
            ...makeCapability().color!,
            cameraMatrixAppliedByRuntime: false,
          },
        },
        'missing-color-transform',
      ],
    ] as const)(
      'fails closed for %s before probing the JPEG runtime',
      async (_name, overrides, reason) => {
        const { result, jpegRuntimeAvailabilityProbe } = await probe({
          ...makeCapability(),
          ...overrides,
        } as LumaRawExportCapability)

        expect(result).toMatchObject({ supported: false, reasons: [reason] })
        expect(jpegRuntimeAvailabilityProbe).not.toHaveBeenCalled()
      },
    )
  })

  it('builds one default runtime, sized by the interactive policy', async () => {
    vi.resetModules()
    const runtime = makeRuntime()
    const createLumaRawRuntime = vi.fn(() => runtime)
    vi.doMock('@lumaforge/luma-raw-runtime', () => ({ createLumaRawRuntime }))
    try {
      const capability = await import('~/lib/runtime/capability-vector')
      capability.setCapabilityVectorForTest({
        coi: true,
        pthread: true,
        deviceMemoryGB: 4,
        hwConcurrency: 4,
        webKitClass: 'webkit-mobile',
        deviceFormFactor: 'mobile',
        maybeOpfsSupported: true,
      })
      const { createRawRuntimeHost: createDefaultHost } =
        await import('./raw-runtime-host')
      const host = createDefaultHost({
        jpegRuntimeAvailabilityProbe: () => true,
      })

      await Promise.all([
        host.prewarm(),
        host.beginSession().open(new File(['raw'], 'a.ARW')),
      ])

      expect(createLumaRawRuntime).toHaveBeenCalledTimes(1)
      expect(createLumaRawRuntime).toHaveBeenCalledWith({
        memoryProfile: 'low-memory',
        requireCrossOriginIsolation: false,
      })
      host.dispose()
      capability.resetCapabilityVectorForTest()
    } finally {
      vi.doUnmock('@lumaforge/luma-raw-runtime')
      vi.resetModules()
    }
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
      ).rejects.toMatchObject({ code: 'RAW_JOB_CANCELLED' })
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
      // The cancelled open rejects at once, before the source arrives.
      await expect(opening).rejects.toMatchObject({
        code: 'RAW_JOB_CANCELLED',
      })
      lateOpen.resolve(late)

      await vi.waitFor(() => expect(late.dispose).toHaveBeenCalledTimes(1))
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

  describe('superseded native work', () => {
    const fileA = new File(['raw'], 'a.ARW')
    const fileB = new File(['raw'], 'b.ARW')

    function makeHost(runtimeFactory: RawRuntimeHostOptions['runtimeFactory']) {
      return createRawRuntimeHost({
        runtimeFactory,
        jpegRuntimeAvailabilityProbe: () => true,
      })
    }

    it.each(['init', 'openSession'] as const)(
      'opens a replacement lease while an obsolete %s on the old generation never settles',
      async (operation) => {
        let gate!: ReturnType<typeof deferred<void>>
        const { workers, runtimeFactory } = createWorkerLikeRuntimes(
          (worker, index) => {
            if (index === 0) gate = worker.hold(operation)
          },
        )
        const host = makeHost(runtimeFactory)

        const leaseA = host.beginSession()
        const openingA = leaseA.open(fileA)
        await vi.waitFor(() =>
          expect(workers[0]?.runtime[operation]).toHaveBeenCalled(),
        )

        const leaseB = host.beginSession()
        await expect(openingA).rejects.toMatchObject({
          code: 'RAW_JOB_CANCELLED',
        })
        const openedB = await settled(leaseB.open(fileB))

        expect(openedB.sourceDimensions).toEqual({ width: 6240, height: 4168 })
        expect(runtimeFactory).toHaveBeenCalledTimes(2)
        expect(workers[0]!.runtime.dispose).toHaveBeenCalledTimes(1)
        expect(workers[1]!.runtime.openSession).toHaveBeenCalledWith(
          fileB,
          { maxOutputPixels: QUICK_PREVIEW_MAX_PIXELS },
          leaseB.signal,
        )

        // The obsolete work completing late opens nothing more, and disposes
        // only the session it had already opened.
        gate.resolve()
        await flushMicrotasks()
        if (operation === 'openSession') {
          await vi.waitFor(() =>
            expect(workers[0]!.session.dispose).toHaveBeenCalledTimes(1),
          )
        } else {
          expect(workers[0]!.runtime.openSession).not.toHaveBeenCalled()
        }
        expect(workers[1]!.session.dispose).not.toHaveBeenCalled()
        expect(workers[1]!.runtime.dispose).not.toHaveBeenCalled()
        expect(host.getSnapshot().runtime).toMatchObject({
          workerAlive: true,
          initialized: true,
        })

        leaseB.release()
        expect(workers[1]!.session.dispose).toHaveBeenCalledTimes(1)
      },
    )

    it('opens a replacement lease while an obsolete worker start never settles', async () => {
      const stalledStart = deferred<LumaRawRuntime>()
      const replacement = makeWorkerLikeRuntime()
      const runtimeFactory = vi
        .fn<() => LumaRawRuntime | Promise<LumaRawRuntime>>()
        .mockReturnValueOnce(stalledStart.promise)
        .mockReturnValueOnce(replacement.runtime)
      const host = makeHost(runtimeFactory)

      const leaseA = host.beginSession()
      const openingA = leaseA.open(fileA)
      await vi.waitFor(() => expect(runtimeFactory).toHaveBeenCalledTimes(1))

      host.cancelSession()
      await expect(openingA).rejects.toMatchObject({
        code: 'RAW_JOB_CANCELLED',
      })
      const leaseB = host.beginSession()
      await settled(leaseB.open(fileB))
      expect(replacement.runtime.openSession).toHaveBeenCalledTimes(1)

      // The obsolete start lands late and is disposed without publishing.
      const late = makeRuntime()
      stalledStart.resolve(late)
      await vi.waitFor(() => expect(late.dispose).toHaveBeenCalledTimes(1))
      expect(late.init).not.toHaveBeenCalled()
      expect(replacement.runtime.dispose).not.toHaveBeenCalled()
      expect(host.getSnapshot().runtime.workerAlive).toBe(true)
    })

    it.each([
      ['quick', 'decodeQuick', 'superseded'],
      ['bounded HQ', 'decodeBoundedHq', 'reset'],
      ['embedded preview', 'extractEmbeddedPreview', 'superseded'],
    ] as const)(
      'starts the replacement while an obsolete %s decode never settles (%s)',
      async (_label, operation, ending) => {
        let gate!: ReturnType<typeof deferred<void>>
        const { workers, runtimeFactory } = createWorkerLikeRuntimes(
          (worker, index) => {
            if (index === 0) gate = worker.hold(operation)
          },
        )
        const host = makeHost(runtimeFactory)

        const leaseA = host.beginSession()
        const sessionA = await leaseA.open(fileA)
        const stage =
          operation === 'decodeQuick'
            ? sessionA.decodeQuickRaw(undefined, leaseA.signal)
            : operation === 'decodeBoundedHq'
              ? sessionA.decodeBoundedHqRaw(
                  { maxOutputPixels: 4_000_000 },
                  undefined,
                  leaseA.signal,
                )
              : sessionA.extractEmbeddedPreview(leaseA.signal)
        await vi.waitFor(() =>
          expect(workers[0]!.session[operation]).toHaveBeenCalled(),
        )

        void stage.catch(() => undefined)

        if (ending === 'reset') host.cancelSession()
        const leaseB = host.beginSession()
        const sessionB = await settled(leaseB.open(fileB))
        await expect(
          settled(sessionB.decodeQuickRaw(undefined, leaseB.signal)),
        ).resolves.toMatchObject({ source: 'quick' })

        expect(runtimeFactory).toHaveBeenCalledTimes(2)
        expect(workers[0]!.runtime.dispose).toHaveBeenCalledTimes(1)
        expect(workers[0]!.session.dispose).toHaveBeenCalledTimes(1)

        gate.resolve()
        await flushMicrotasks()
        expect(workers[1]!.session.dispose).not.toHaveBeenCalled()
        expect(workers[1]!.runtime.dispose).not.toHaveBeenCalled()
        expect(host.getSnapshot().runtime.workerAlive).toBe(true)
      },
    )

    it('keeps the warm runtime for the next lease once a lease was released or its open failed', async () => {
      const { workers, runtimeFactory } = createWorkerLikeRuntimes()
      const host = makeHost(runtimeFactory)

      const leaseA = host.beginSession()
      const sessionA = await leaseA.open(fileA)
      await sessionA.decodeQuickRaw(undefined, leaseA.signal)
      leaseA.release()

      vi.mocked(workers[0]!.runtime.openSession).mockRejectedValueOnce(
        new Error('open exploded'),
      )
      const failed = host.beginSession()
      await expect(failed.open(fileB)).rejects.toMatchObject({
        code: 'RAW_OPEN_FAILED',
      })
      failed.cancel()

      const leaseB = host.beginSession()
      await settled(leaseB.open(fileB))

      expect(leaseA.signal.aborted).toBe(false)
      expect(runtimeFactory).toHaveBeenCalledTimes(1)
      expect(workers[0]!.runtime.dispose).not.toHaveBeenCalled()
      expect(workers[0]!.runtime.openSession).toHaveBeenCalledTimes(3)
    })

    it('restores on a fresh generation after evacuation while an obsolete open never settles', async () => {
      let gate!: ReturnType<typeof deferred<void>>
      const { workers, runtimeFactory } = createWorkerLikeRuntimes(
        (worker, index) => {
          if (index === 0) gate = worker.hold('openSession')
        },
      )
      const host = makeHost(runtimeFactory)

      const leaseA = host.beginSession()
      void leaseA.open(fileA).catch(() => undefined)
      await vi.waitFor(() =>
        expect(workers[0]?.runtime.openSession).toHaveBeenCalled(),
      )

      host.cancelSession()
      await host.terminateDecodeBridge()
      const restore = host.beginSession()
      const restored = await settled(restore.open(fileA))
      await expect(
        settled(restored.decodeQuickRaw(undefined, restore.signal)),
      ).resolves.toMatchObject({ source: 'quick' })

      gate.resolve()
      await vi.waitFor(() =>
        expect(workers[0]!.session.dispose).toHaveBeenCalledTimes(1),
      )
      expect(workers.at(-1)!.session.dispose).not.toHaveBeenCalled()
      expect(workers.at(-1)!.runtime.dispose).not.toHaveBeenCalled()
    })

    it('lets a late end of an obsolete lease never terminate its replacement', async () => {
      let gate!: ReturnType<typeof deferred<void>>
      const { workers, runtimeFactory } = createWorkerLikeRuntimes(
        (worker, index) => {
          if (index === 0) gate = worker.hold('decodeQuick')
        },
      )
      const host = makeHost(runtimeFactory)

      const leaseA = host.beginSession()
      const sessionA = await leaseA.open(fileA)
      void sessionA
        .decodeQuickRaw(undefined, leaseA.signal)
        .catch(() => undefined)
      await vi.waitFor(() =>
        expect(workers[0]!.session.decodeQuick).toHaveBeenCalled(),
      )
      const leaseB = host.beginSession()
      const sessionB = await settled(leaseB.open(fileB))
      const quickB = sessionB.decodeQuickRaw(undefined, leaseB.signal)

      leaseA.cancel()
      leaseA.release()
      gate.resolve()

      await expect(settled(quickB)).resolves.toMatchObject({ source: 'quick' })
      expect(leaseB.signal.aborted).toBe(false)
      expect(runtimeFactory).toHaveBeenCalledTimes(2)
      expect(workers[1]!.runtime.dispose).not.toHaveBeenCalled()
      expect(workers[1]!.session.dispose).not.toHaveBeenCalled()
    })

    it.each(['superseded', 'reset'] as const)(
      'warms a fresh generation for the next lease once a lease waiting on a startup init that never answers is %s',
      async (ending) => {
        let gate!: ReturnType<typeof deferred<void>>
        const { workers, runtimeFactory } = createWorkerLikeRuntimes(
          (worker, index) => {
            if (index === 0) gate = worker.hold('init')
          },
        )
        const host = makeHost(runtimeFactory)

        const startup = host.prewarm()
        const leaseA = host.beginSession()
        const warmingA = leaseA.prewarm()
        await vi.waitFor(() =>
          expect(workers[0]?.runtime.init).toHaveBeenCalled(),
        )
        expect(host.getSnapshot().initialization).toBe('pending')

        if (ending === 'reset') host.cancelSession()
        const leaseB = host.beginSession()
        await expect(warmingA).rejects.toMatchObject({
          code: 'RAW_JOB_CANCELLED',
        })
        await expect(settled(startup)).resolves.toMatchObject({
          status: 'failed',
          recoverable: true,
        })

        const warmingB = leaseB.prewarm()
        expect(warmingB).not.toBe(warmingA)
        await expect(settled(warmingB)).resolves.toEqual({ status: 'ready' })
        const openedB = await settled(leaseB.open(fileB))
        expect(openedB.sourceDimensions).toEqual({ width: 6240, height: 4168 })
        expect(runtimeFactory).toHaveBeenCalledTimes(2)
        expect(workers[0]!.runtime.dispose).toHaveBeenCalledTimes(1)
        expect(host.getSnapshot()).toMatchObject({
          initialization: 'ready',
          runtime: {
            generation: 2,
            workerAlive: true,
            initialized: true,
            lastTermination: { generation: 1, reason: 'explicit' },
          },
        })

        // The obsolete init answering late publishes and disposes nothing.
        gate.resolve()
        await flushMicrotasks()
        expect(workers[0]!.runtime.openSession).not.toHaveBeenCalled()
        expect(workers[1]!.runtime.dispose).not.toHaveBeenCalled()
        expect(workers[1]!.session.dispose).not.toHaveBeenCalled()
        expect(host.getSnapshot()).toMatchObject({
          initialization: 'ready',
          outcome: { status: 'ready' },
          runtime: { generation: 2, workerAlive: true, initialized: true },
        })
        expect(leaseB.signal.aborted).toBe(false)
      },
    )

    it('keeps the warm runtime for the next lease when a lease ends after its prewarm settled', async () => {
      const { workers, runtimeFactory } = createWorkerLikeRuntimes()
      const host = makeHost(runtimeFactory)

      const leaseA = host.beginSession()
      await expect(leaseA.prewarm()).resolves.toEqual({ status: 'ready' })
      const leaseB = host.beginSession()
      await expect(leaseB.prewarm()).resolves.toEqual({ status: 'ready' })
      await settled(leaseB.open(fileB))

      expect(leaseA.signal.aborted).toBe(true)
      expect(runtimeFactory).toHaveBeenCalledTimes(1)
      expect(workers[0]!.runtime.dispose).not.toHaveBeenCalled()
      expect(host.getSnapshot().runtime.lastTermination).toBeNull()
    })

    it('records an explicit termination when it ends the generation of a lease still opening', async () => {
      const { workers, runtimeFactory } = createWorkerLikeRuntimes(
        (worker, index) => {
          if (index === 0) worker.hold('openSession')
        },
      )
      const host = makeHost(runtimeFactory)

      const leaseA = host.beginSession()
      void leaseA.open(fileA).catch(() => undefined)
      await vi.waitFor(() =>
        expect(workers[0]?.runtime.openSession).toHaveBeenCalled(),
      )
      leaseA.cancel()

      expect(host.getSnapshot().runtime.lastTermination).toEqual({
        generation: 1,
        reason: 'explicit',
      })
    })

    it('settles a prewarm superseded by a termination and warms afresh while the old init never settles', async () => {
      let gate!: ReturnType<typeof deferred<void>>
      const { workers, runtimeFactory } = createWorkerLikeRuntimes(
        (worker, index) => {
          if (index === 0) gate = worker.hold('init')
        },
      )
      const host = makeHost(runtimeFactory)

      const obsolete = host.prewarm()
      await vi.waitFor(() =>
        expect(workers[0]?.runtime.init).toHaveBeenCalled(),
      )
      await host.terminateDecodeBridge()

      await expect(settled(obsolete)).resolves.toMatchObject({
        status: 'failed',
        recoverable: true,
      })
      expect(host.getSnapshot()).toMatchObject({
        initialization: 'idle',
        outcome: null,
      })

      const current = host.prewarm()
      expect(current).not.toBe(obsolete)
      await expect(settled(current)).resolves.toEqual({ status: 'ready' })
      expect(host.getSnapshot()).toMatchObject({
        initialization: 'ready',
        runtime: { generation: 2, workerAlive: true, initialized: true },
      })

      gate.resolve()
      await flushMicrotasks()
      expect(host.getSnapshot()).toMatchObject({
        initialization: 'ready',
        runtime: { generation: 2, workerAlive: true, initialized: true },
      })
      expect(workers[1]!.runtime.dispose).not.toHaveBeenCalled()
    })
  })

  describe('failure normalization', () => {
    async function openOnLease(session: LumaRawDecodeSession) {
      const runtime = makeRuntime({
        openSession: vi
          .fn<LumaRawRuntime['openSession']>()
          .mockResolvedValue(session),
      })
      const host = createRawRuntimeHost({ runtimeFactory: () => runtime })
      return host.beginSession().open(new File(['raw'], 'a.ARW'))
    }

    it('normalizes an asynchronous embedded-preview rejection to RAW_THUMBNAIL_UNAVAILABLE', async () => {
      const opened = await openOnLease(
        makeSession({
          extractEmbeddedPreview: vi
            .fn()
            .mockImplementationOnce(async () => {
              await Promise.resolve()
              throw new Error('thumbnail exploded')
            })
            .mockImplementationOnce(async () => {
              await Promise.resolve()
              throw Object.assign(new Error('out of memory'), {
                code: 'RAW_MEMORY_LIMIT',
              })
            }),
        }),
      )

      await expect(opened.extractEmbeddedPreview()).rejects.toMatchObject({
        name: 'RawAdapterError',
        code: 'RAW_THUMBNAIL_UNAVAILABLE',
        message: 'thumbnail exploded',
      })
      await expect(opened.extractEmbeddedPreview()).rejects.toMatchObject({
        name: 'RawAdapterError',
        code: 'RAW_MEMORY_LIMIT',
      })
    })

    it('reports an aborted decode as RAW_JOB_CANCELLED, not a decode failure', async () => {
      const decodeQuick = vi.fn(
        (_options?: unknown, signal?: AbortSignal) =>
          new Promise<LumaRawFrame>((_resolve, reject) => {
            // The worker client rejects a cancelled request with its own code.
            signal?.addEventListener('abort', () =>
              reject(
                Object.assign(new Error('RAW runtime worker was disposed.'), {
                  code: 'RAW_RUNTIME_UNAVAILABLE',
                }),
              ),
            )
          }),
      )
      const opened = await openOnLease(makeSession({ decodeQuick }))
      const controller = new AbortController()

      const quick = opened.decodeQuickRaw(undefined, controller.signal)
      await vi.waitFor(() => expect(decodeQuick).toHaveBeenCalled())
      controller.abort()

      await expect(quick).rejects.toMatchObject({
        name: 'RawAdapterError',
        code: 'RAW_JOB_CANCELLED',
      })
    })

    it('normalizes stage failures to RAW adapter error codes', async () => {
      const opened = await openOnLease(
        makeSession({
          decodeQuick: vi.fn().mockRejectedValue(new Error('quick exploded')),
          decodeBoundedHq: vi.fn().mockRejectedValue(new Error('hq exploded')),
        }),
      )

      await expect(opened.decodeQuickRaw()).rejects.toMatchObject({
        name: 'RawAdapterError',
        code: 'RAW_QUICK_DECODE_FAILED',
        message: 'quick exploded',
      })
      await expect(
        opened.decodeBoundedHqRaw({ maxOutputPixels: 4_000_000 }),
      ).rejects.toMatchObject({
        name: 'RawAdapterError',
        code: 'RAW_HQ_DECODE_FAILED',
        message: 'hq exploded',
      })

      const runtime = makeRuntime({
        openSession: vi
          .fn<LumaRawRuntime['openSession']>()
          .mockRejectedValue(new Error('open exploded')),
      })
      const host = createRawRuntimeHost({ runtimeFactory: () => runtime })
      await expect(
        host.beginSession().open(new File(['raw'], 'a.ARW')),
      ).rejects.toMatchObject({
        name: 'RawAdapterError',
        code: 'RAW_OPEN_FAILED',
        message: 'open exploded',
      })
    })
  })
})
