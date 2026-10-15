import type {
  LumaRawDecodeSession,
  LumaRawExportCapability,
  LumaRawFrame,
  LumaRawRuntime,
  LumaRawRuntimeInfo,
} from '@lumaforge/luma-raw-runtime'
import { JPEG_RUNTIME_UNAVAILABLE_MESSAGE } from '@lumaforge/render-engine/export'
import {
  BOUNDED_HQ_PREVIEW_MAX_PIXELS,
  QUICK_PREVIEW_MAX_PIXELS,
} from '@lumaforge/render-engine/preview'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  RawRuntimeHost,
  RawRuntimeHostOptions,
  RawRuntimeHostSnapshot,
  RawRuntimeSessionLease,
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

function makeFrame(source: LumaRawFrame['source']): LumaRawFrame {
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

/** A host on one runtime whose sessions open as `openSession` answers. */
function makeHostOn(
  openSession: LumaRawRuntime['openSession'],
  options: Omit<RawRuntimeHostOptions, 'runtimeFactory'> = {},
) {
  const runtime = makeRuntime({ openSession: vi.fn(openSession) })
  return {
    runtime,
    host: createRawRuntimeHost({ runtimeFactory: () => runtime, ...options }),
  }
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
  const calls: WorkerOperation[] = []
  let tail: Promise<unknown> = Promise.resolve()
  const gates = new Map<WorkerOperation, ReturnType<typeof deferred<void>>>()
  function run<T>(operation: WorkerOperation, value: () => T): Promise<T> {
    calls.push(operation)
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
    calls,
    /** Holds `operation` until the returned gate opens. */
    hold(operation: WorkerOperation) {
      const gate = deferred<void>()
      gates.set(operation, gate)
      return gate
    },
  }
}

/**
 * A host that starts one worker-like runtime per generation; the first one
 * holds `held` until the returned gate opens.
 */
function makeWorkerLikeHost(held?: WorkerOperation) {
  const workers: Array<ReturnType<typeof makeWorkerLikeRuntime>> = []
  let gate = deferred<void>()
  const runtimeFactory = vi.fn(() => {
    const worker = makeWorkerLikeRuntime()
    if (held && workers.length === 0) gate = worker.hold(held)
    workers.push(worker)
    return worker.runtime
  })
  const host = createRawRuntimeHost({
    runtimeFactory,
    jpegRuntimeAvailabilityProbe: () => true,
  })
  return { host, workers, runtimeFactory, openGate: () => gate.resolve() }
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

const fileA = new File(['raw'], 'a.ARW')
const fileB = new File(['raw'], 'b.ARW')

afterEach(() => {
  vi.useRealTimers()
})

describe('raw runtime host prewarm history', () => {
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

    await hostA.prewarm()

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

  it('shares one in-flight prewarm and answers again without re-initializing a live runtime', async () => {
    const init = deferred<LumaRawRuntimeInfo>()
    const runtime = makeRuntime({
      init: vi.fn<LumaRawRuntime['init']>(() => init.promise),
    })
    const runtimeFactory = vi.fn(() => runtime)
    const host = createRawRuntimeHost({ runtimeFactory })

    const first = host.prewarm()
    expect(host.prewarm()).toBe(first)
    expect(host.getSnapshot().initialization).toBe('pending')
    await vi.waitFor(() => expect(runtime.init).toHaveBeenCalled())
    init.resolve(makeRuntimeInfo())
    const ready = await first

    expect(ready).toEqual({ status: 'ready' })
    await expect(host.prewarm()).resolves.toBe(ready)
    expect(runtimeFactory).toHaveBeenCalledTimes(1)
    expect(runtime.init).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['retries a recoverable failure on the next call', new Error('blip'), true],
    ['keeps a cross-origin isolation failure until dispose', coiError(), false],
  ] as const)('%s', async (_name, error, recoverable) => {
    const runtime = makeRuntime()
    vi.mocked(runtime.init).mockRejectedValueOnce(error)
    const host = createRawRuntimeHost({ runtimeFactory: () => runtime })

    const failed = await host.prewarm()

    expect(failed).toEqual({
      status: 'failed',
      reason: error.message,
      recoverable,
    })
    expect(host.getSnapshot()).toMatchObject({
      initialization: 'failed',
      outcome: failed,
      runtime: { initialized: false },
    })
    if (!recoverable) {
      await expect(host.prewarm()).resolves.toBe(failed)
      expect(runtime.init).toHaveBeenCalledTimes(1)
      host.dispose()
      expect(host.getSnapshot()).toMatchObject({
        initialization: 'idle',
        outcome: null,
      })
    }
    await expect(host.prewarm()).resolves.toEqual({ status: 'ready' })
    expect(host.getSnapshot()).toMatchObject({
      initialization: 'ready',
      runtime: { initialized: true },
    })
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
    const unsubscribe = host.subscribe(() => snapshots.push(host.getSnapshot()))

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
    unsubscribe()

    await expect(host.prewarm()).resolves.toEqual({ status: 'ready' })
    expect(runtime.init).toHaveBeenCalledTimes(2)
    expect(host.getSnapshot()).toMatchObject({
      initialization: 'ready',
      runtime: { generation: 2, workerAlive: true, initialized: true },
    })
    expect(snapshots.at(-1)).toBe(idle)
  })

  it.each(
    (['terminated', 'disposed'] as const).flatMap((ending) =>
      (['answers', 'fails', 'never answers'] as const).map(
        (late) => [ending, late] as const,
      ),
    ),
  )(
    'lets a prewarm whose runtime was %s, and which %s late, neither record history nor end the next attempt',
    async (ending, late) => {
      const stale = deferred<LumaRawRuntimeInfo>()
      const fresh = deferred<LumaRawRuntimeInfo>()
      const runtime = makeRuntime({
        init: vi
          .fn<LumaRawRuntime['init']>()
          .mockReturnValueOnce(stale.promise)
          .mockReturnValueOnce(fresh.promise),
      })
      const host = createRawRuntimeHost({ runtimeFactory: () => runtime })

      const obsolete = host.prewarm()
      await vi.waitFor(() => expect(runtime.init).toHaveBeenCalledTimes(1))
      if (ending === 'terminated') await host.terminateDecodeBridge()
      else host.dispose()
      expect(host.getSnapshot()).toMatchObject({
        initialization: 'idle',
        outcome: null,
        runtime: {
          workerAlive: false,
          lastTermination: { generation: 1, reason: 'explicit' },
        },
      })

      const current = host.prewarm()
      if (late === 'answers') stale.resolve(makeRuntimeInfo())
      if (late === 'fails') stale.reject(coiError())
      await expect(obsolete).resolves.toMatchObject({
        status: 'failed',
        recoverable: true,
      })
      await vi.waitFor(() => expect(runtime.init).toHaveBeenCalledTimes(2))
      expect(host.getSnapshot()).toMatchObject({
        initialization: 'pending',
        outcome: null,
      })
      expect(host.prewarm()).toBe(current)

      fresh.resolve(makeRuntimeInfo())
      await expect(current).resolves.toEqual({ status: 'ready' })
      expect(host.getSnapshot()).toMatchObject({
        initialization: 'ready',
        outcome: { status: 'ready' },
        runtime: { generation: 2, workerAlive: true, initialized: true },
      })
    },
  )
})

describe('raw runtime host sessions', () => {
  it('opens the source on the lease signal and runs each stage with the caller signal, keeping a pinned exposure on the app side', async () => {
    const session = makeSession()
    const { runtime, host } = makeHostOn(async () => session)
    const lease = host.beginSession()
    const stageSignal = new AbortController().signal
    const pinnedExposure = {
      ev: 0.75,
      multiplier: 2 ** 0.75,
      source: 'image-statistics',
    } as const

    const opened = await lease.open(fileA)
    await opened.extractEmbeddedPreview(stageSignal)
    const quick = await opened.decodeQuickRaw(undefined, stageSignal)
    const hq = await opened.decodeBoundedHqRaw(
      { maxOutputPixels: BOUNDED_HQ_PREVIEW_MAX_PIXELS, pinnedExposure },
      undefined,
      stageSignal,
    )

    expect(runtime.openSession).toHaveBeenCalledExactlyOnceWith(
      fileA,
      { maxOutputPixels: QUICK_PREVIEW_MAX_PIXELS },
      lease.signal,
    )
    expect(opened.sourceDimensions).toEqual({ width: 6240, height: 4168 })
    expect(session.extractEmbeddedPreview).toHaveBeenCalledWith(stageSignal)
    expect(session.decodeQuick).toHaveBeenCalledWith(
      { maxOutputPixels: QUICK_PREVIEW_MAX_PIXELS },
      stageSignal,
    )
    expect(quick).toMatchObject({
      source: 'quick',
      metadata: { make: 'Sony', model: 'A7', width: 1, height: 1 },
    })
    expect(session.decodeBoundedHq).toHaveBeenCalledWith(
      { maxOutputPixels: BOUNDED_HQ_PREVIEW_MAX_PIXELS },
      stageSignal,
    )
    expect(hq.renderExposure).toEqual(pinnedExposure)
  })

  it('opens one source per lease and disposes it once however a settled lease ends', async () => {
    const session = makeSession()
    const { runtime, host } = makeHostOn(async () => session)

    const lease = host.beginSession()
    await lease.open(fileA)
    await expect(lease.open(fileA)).rejects.toThrow(
      'A RAW session lease opens one source.',
    )
    expect(session.dispose).not.toHaveBeenCalled()

    lease.release()
    lease.release()
    lease.cancel()
    host.cancelSession()

    expect(lease.signal.aborted).toBe(false)
    expect(session.dispose).toHaveBeenCalledTimes(1)

    const unopened = host.beginSession()
    unopened.release()
    await expect(unopened.open(fileA)).rejects.toMatchObject({
      code: 'RAW_JOB_CANCELLED',
    })
    expect(runtime.openSession).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['the lease is cancelled', (_host, lease) => lease.cancel()],
    ['the host cancels its session', (host) => host.cancelSession()],
    ['the next lease begins', (host) => host.beginSession()],
    ['the host terminates its runtime', (host) => host.terminateDecodeBridge()],
    ['the host is disposed', (host) => host.dispose()],
  ] as Array<
    [string, (host: RawRuntimeHost, lease: RawRuntimeSessionLease) => unknown]
  >)(
    'aborts an open lease and disposes its source once when %s',
    async (_name, end) => {
      const session = makeSession()
      const { host } = makeHostOn(async () => session)
      const lease = host.beginSession()
      await lease.open(fileA)

      await end(host, lease)
      lease.cancel()
      lease.release()

      expect(lease.signal.aborted).toBe(true)
      expect(session.dispose).toHaveBeenCalledTimes(1)
    },
  )

  describe('export capability gate', () => {
    async function probe(capability: LumaRawExportCapability, jpeg = true) {
      const jpegRuntimeAvailabilityProbe = vi.fn(() => jpeg)
      const { host } = makeHostOn(
        async () =>
          makeSession({
            probeExportCapability: vi.fn().mockResolvedValue(capability),
          }),
        { jpegRuntimeAvailabilityProbe },
      )
      const opened = await host.beginSession().open(fileA)
      return opened.probeExportCapability!().then((result) => ({
        result,
        jpegRuntimeAvailabilityProbe,
      }))
    }

    it('keeps the processed-window facts only once the JPEG runtime is available', async () => {
      await expect(probe(makeCapability())).resolves.toMatchObject({
        result: makeCapability(),
      })
      await expect(probe(makeCapability(), false)).rejects.toThrow(
        JPEG_RUNTIME_UNAVAILABLE_MESSAGE,
      )
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

  describe('failure normalization', () => {
    type Stage =
      | 'open'
      | 'extractEmbeddedPreview'
      | 'decodeQuick'
      | 'decodeBoundedHq'

    /** Runs `stage` on a fresh lease whose runtime rejects it with `error`. */
    async function runFailing(
      stage: Stage,
      error: unknown,
      signal?: AbortSignal,
    ) {
      const fail = vi.fn().mockRejectedValue(error)
      const { host } = makeHostOn(
        stage === 'open'
          ? fail
          : async () =>
              makeSession({ [stage]: fail } as Partial<LumaRawDecodeSession>),
      )
      const opened = await host.beginSession().open(fileA)
      if (stage === 'extractEmbeddedPreview') {
        return opened.extractEmbeddedPreview(signal)
      }
      if (stage === 'decodeQuick')
        return opened.decodeQuickRaw(undefined, signal)
      return opened.decodeBoundedHqRaw(
        { maxOutputPixels: 4_000_000 },
        undefined,
        signal,
      )
    }

    it.each([
      ['open', 'RAW_OPEN_FAILED'],
      ['extractEmbeddedPreview', 'RAW_THUMBNAIL_UNAVAILABLE'],
      ['decodeQuick', 'RAW_QUICK_DECODE_FAILED'],
      ['decodeBoundedHq', 'RAW_HQ_DECODE_FAILED'],
    ] as const)(
      'reports a failed %s as %s unless the runtime published its own RAW code',
      async (stage, code) => {
        await expect(
          runFailing(stage, new Error(`${stage} exploded`)),
        ).rejects.toMatchObject({
          name: 'RawAdapterError',
          code,
          message: `${stage} exploded`,
        })
        await expect(
          runFailing(
            stage,
            Object.assign(new Error('out of memory'), {
              code: 'RAW_MEMORY_LIMIT',
            }),
          ),
        ).rejects.toMatchObject({
          name: 'RawAdapterError',
          code: 'RAW_MEMORY_LIMIT',
        })
      },
    )

    it('reports a stage its caller aborted as RAW_JOB_CANCELLED whatever the worker answered', async () => {
      const controller = new AbortController()
      controller.abort()

      await expect(
        runFailing(
          'decodeQuick',
          Object.assign(new Error('RAW runtime worker was disposed.'), {
            code: 'RAW_RUNTIME_UNAVAILABLE',
          }),
          controller.signal,
        ),
      ).rejects.toMatchObject({
        name: 'RawAdapterError',
        code: 'RAW_JOB_CANCELLED',
      })
    })
  })

  it('sizes the default runtime by the interactive policy', async () => {
    vi.resetModules()
    const createLumaRawRuntime = vi.fn(() => makeRuntime())
    vi.doMock('@lumaforge/luma-raw-runtime', () => ({ createLumaRawRuntime }))
    try {
      const capability = await import('~/lib/runtime/capability-vector')
      vi.spyOn(capability, 'getCapabilityVectorSnapshot').mockReturnValue({
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
      const host = createDefaultHost()

      await host.prewarm()

      expect(createLumaRawRuntime).toHaveBeenCalledExactlyOnceWith({
        memoryProfile: 'low-memory',
        requireCrossOriginIsolation: false,
      })
      host.dispose()
    } finally {
      vi.restoreAllMocks()
      vi.doUnmock('@lumaforge/luma-raw-runtime')
      vi.resetModules()
    }
  })
})

describe('raw runtime host superseded native work', () => {
  /** Starts `stage` on the lease; `init` and `openSession` are its open. */
  function startStage(
    lease: RawRuntimeSessionLease,
    stage: WorkerOperation,
  ): Promise<unknown> {
    const opening = lease.open(fileA)
    if (stage === 'init' || stage === 'openSession') return opening
    return opening.then((session): Promise<unknown> => {
      if (stage === 'decodeQuick') {
        return session.decodeQuickRaw(undefined, lease.signal)
      }
      if (stage === 'decodeBoundedHq') {
        return session.decodeBoundedHqRaw(
          { maxOutputPixels: 4_000_000 },
          undefined,
          lease.signal,
        )
      }
      return session.extractEmbeddedPreview(lease.signal)
    })
  }

  it.each([
    ['init', 'superseded'],
    ['openSession', 'superseded'],
    ['openSession', 'evacuated'],
    ['extractEmbeddedPreview', 'superseded'],
    ['decodeQuick', 'superseded'],
    ['decodeBoundedHq', 'reset'],
  ] as const)(
    'runs the next lease on a fresh generation while an obsolete %s, %s, never answers',
    async (stage, ending) => {
      const { host, workers, runtimeFactory, openGate } =
        makeWorkerLikeHost(stage)

      const leaseA = host.beginSession()
      const obsolete = startStage(leaseA, stage)
      obsolete.catch(() => undefined)
      await vi.waitFor(() => expect(workers[0]?.calls).toContain(stage))

      if (ending !== 'superseded') host.cancelSession()
      if (ending === 'evacuated') await host.terminateDecodeBridge()
      const leaseB = host.beginSession()
      const sessionB = await settled(leaseB.open(fileB))
      await expect(
        settled(sessionB.decodeQuickRaw(undefined, leaseB.signal)),
      ).resolves.toMatchObject({ source: 'quick' })
      if (stage === 'init' || stage === 'openSession') {
        await expect(obsolete).rejects.toMatchObject({
          code: 'RAW_JOB_CANCELLED',
        })
      }
      expect(runtimeFactory).toHaveBeenCalledTimes(2)
      expect(workers[0]!.runtime.dispose).toHaveBeenCalledTimes(1)

      // A late end of the obsolete lease and its work answering late leave
      // the new generation alone; only a source it opened is disposed.
      leaseA.cancel()
      leaseA.release()
      openGate()
      await flushMicrotasks()
      const opened = stage !== 'init'
      await vi.waitFor(() =>
        expect(workers[0]!.session.dispose).toHaveBeenCalledTimes(
          opened ? 1 : 0,
        ),
      )
      expect(workers[0]!.runtime.openSession).toHaveBeenCalledTimes(
        opened ? 1 : 0,
      )
      expect(leaseB.signal.aborted).toBe(false)
      expect(workers[1]!.session.dispose).not.toHaveBeenCalled()
      expect(workers[1]!.runtime.dispose).not.toHaveBeenCalled()
      expect(host.getSnapshot().runtime).toMatchObject({
        generation: 2,
        workerAlive: true,
        initialized: true,
        lastTermination: { generation: 1, reason: 'explicit' },
      })
    },
  )

  it.each(['superseded', 'reset'] as const)(
    'warms a fresh generation for the next lease once a lease waiting on a startup init that never answers is %s',
    async (ending) => {
      const { host, workers, runtimeFactory, openGate } =
        makeWorkerLikeHost('init')

      const startup = host.prewarm()
      const leaseA = host.beginSession()
      const warmingA = leaseA.prewarm()
      await vi.waitFor(() => expect(workers[0]?.calls).toContain('init'))
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
      await expect(settled(leaseB.prewarm())).resolves.toEqual({
        status: 'ready',
      })
      await settled(leaseB.open(fileB))
      expect(runtimeFactory).toHaveBeenCalledTimes(2)
      expect(workers[0]!.runtime.dispose).toHaveBeenCalledTimes(1)

      // The obsolete init answering late publishes and disposes nothing.
      openGate()
      await flushMicrotasks()
      expect(workers[0]!.runtime.openSession).not.toHaveBeenCalled()
      expect(workers[1]!.runtime.dispose).not.toHaveBeenCalled()
      expect(host.getSnapshot()).toMatchObject({
        initialization: 'ready',
        outcome: { status: 'ready' },
        runtime: {
          generation: 2,
          workerAlive: true,
          initialized: true,
          lastTermination: { generation: 1, reason: 'explicit' },
        },
      })
      expect(leaseB.signal.aborted).toBe(false)
    },
  )

  it('leaves the warm runtime to the next lease once earlier leases ended after their work settled', async () => {
    const { host, workers, runtimeFactory } = makeWorkerLikeHost()

    const warmed = host.beginSession()
    await expect(warmed.prewarm()).resolves.toEqual({ status: 'ready' })
    const released = host.beginSession()
    const session = await released.open(fileA)
    await session.decodeQuickRaw(undefined, released.signal)
    released.release()
    vi.mocked(workers[0]!.runtime.openSession).mockRejectedValueOnce(
      new Error('open exploded'),
    )
    const failed = host.beginSession()
    await expect(failed.open(fileB)).rejects.toMatchObject({
      code: 'RAW_OPEN_FAILED',
    })
    failed.cancel()

    await settled(host.beginSession().open(fileB))

    expect(warmed.signal.aborted).toBe(true)
    expect(released.signal.aborted).toBe(false)
    expect(runtimeFactory).toHaveBeenCalledTimes(1)
    expect(workers[0]!.runtime.dispose).not.toHaveBeenCalled()
    expect(host.getSnapshot().runtime.lastTermination).toBeNull()
  })
})
