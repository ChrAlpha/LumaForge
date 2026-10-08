import type { ColorGraphIntent } from '@lumaforge/luma-color-runtime'
import { NEUTRAL_USER_COLOR_INTENT } from '@lumaforge/luma-color-runtime'
import type { CapabilityVector } from '@lumaforge/render-engine/policy'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ParsedLUT } from '~/lib/lut/cube-parser'
import type { PreviewView } from '~/lib/preview/preview-view'
import type { DecodedImage } from '~/lib/raw/decoder'
import type { RawRuntimeSessionLease } from '~/lib/raw/raw-runtime-host'
import type { RawRuntimeSession } from '~/lib/raw/runtime-adapter'

import type { ImageSession } from '../../model/session'
import { createImageSession } from '../../model/session-factory'
import { toCustomStyle } from '../look/style-system'
import type { RawLoadContext } from './orchestrate-raw-load'
import { orchestrateRawLoad } from './orchestrate-raw-load'

const capabilityVectorMock = vi.hoisted(() => ({
  detectCapabilityVector: vi.fn(),
  getCapabilityVectorSnapshot: vi.fn(),
}))

const previewGpuBudgetMock = vi.hoisted(() => ({
  detectPreviewGpuCapabilitySnapshot: vi.fn(),
  derivePreviewGpuBudget: vi.fn(),
}))

const previewBackendMock = vi.hoisted(() => ({
  resolvePreviewBackend: vi.fn(),
}))

/** What each test's host opens for a lease's source. */
const openSessionMock =
  vi.fn<(file: File, signal: AbortSignal) => Promise<RawRuntimeSession>>()

type TestLease = RawRuntimeSessionLease & {
  prewarm: ReturnType<typeof vi.fn<RawRuntimeSessionLease['prewarm']>>
  open: ReturnType<typeof vi.fn<RawRuntimeSessionLease['open']>>
  release: ReturnType<typeof vi.fn<RawRuntimeSessionLease['release']>>
  cancel: ReturnType<typeof vi.fn<RawRuntimeSessionLease['cancel']>>
}

/**
 * A host stand-in: every lease warms through `prewarm` and opens through
 * `openSessionMock`.
 */
function createLeaseHost(
  prewarm: RawRuntimeSessionLease['prewarm'] = async () => ({
    status: 'ready',
  }),
) {
  const leases: TestLease[] = []
  const beginRuntimeSession = vi.fn((): RawRuntimeSessionLease => {
    const controller = new AbortController()
    const lease: TestLease = {
      signal: controller.signal,
      prewarm: vi.fn(prewarm),
      open: vi.fn((file: File) => openSessionMock(file, controller.signal)),
      release: vi.fn(),
      cancel: vi.fn(() => controller.abort()),
    }
    leases.push(lease)
    return lease
  })
  return { leases, beginRuntimeSession }
}

vi.mock('~/lib/runtime/capability-vector', () => capabilityVectorMock)
vi.mock('~/lib/runtime/preview-gpu-budget', () => previewGpuBudgetMock)
vi.mock('~/lib/preview/gpu-backend', () => previewBackendMock)

const defaultIntent: ColorGraphIntent = {
  ...NEUTRAL_USER_COLOR_INTENT,
  intensity: 0.7,
  styleKind: 'none',
  builtinPreset: null,
}

const defaultView: PreviewView = { mode: 'compare', compareSplit: 0.5 }

interface OrderingHooks {
  order: string[]
  yieldToPaint: () => Promise<void>
  prewarm?: () => Promise<{
    status: 'ready' | 'failed'
    reason?: string
    recoverable?: boolean
  }>
  openSession?: () => Promise<never>
  getPrewarmState: () => 'idle' | 'pending' | 'ready' | 'failed'
}

/**
 * A synchronous session store stand-in: a write is visible to the next read
 * in the same tick, as with the production store.
 */
function createSessionStore(initial: ImageSession | null = null) {
  let current = initial
  return {
    get: () => current,
    set: (
      value:
        | ImageSession
        | null
        | ((prev: ImageSession | null) => ImageSession | null),
    ) => {
      current = typeof value === 'function' ? value(current) : value
    },
  }
}

function buildContext(
  hooks: OrderingHooks,
  host = createLeaseHost(
    hooks.prewarm ??
      (async () => {
        hooks.order.push('prewarm')
        return { status: 'ready' as const }
      }),
  ),
  store = createSessionStore(),
): RawLoadContext {
  const { order } = hooks
  return {
    atoms: {
      setStatus: vi.fn((status) => order.push(`status:${status}`)),
      setError: vi.fn(),
      setProgress: vi.fn(),
      getColorIntent: vi.fn(() => defaultIntent),
      getView: vi.fn(() => defaultView),
      getLut: vi.fn(() => null),
      setColorIntent: vi.fn(),
      getSession: vi.fn(store.get),
      setSession: vi.fn(store.set),
      setDecodedImageVersion: vi.fn(),
      setStats: vi.fn(),
    },
    services: {
      scheduleToast: vi.fn(),
      replaceFile: vi.fn((file, retained) => {
        order.push('replaceFile')
        const next = createImageSession(file, retained)
        store.set(next)
        return next
      }),
      abortRuntimeWork: vi.fn(() => order.push('abortRuntimeWork')),
      abortExportWork: vi.fn(() => order.push('abortExportWork')),
      queueExportResultResourceDisposal: vi.fn(),
      revokeCurrentEmbeddedPreviewUrl: vi.fn(),
      clearSessionEmbeddedPreviewUrl: vi.fn(),
      setDecodedImageRef: vi.fn(),
      invalidateExportGraph: vi.fn(),
      registerCurrentPreviewPipelineForEvacuation: vi.fn(),
      yieldToPaint: vi.fn(async () => {
        order.push('yieldToPaint')
        await hooks.yieldToPaint()
      }),
      getPrewarmState: hooks.getPrewarmState,
      beginRuntimeSession: host.beginRuntimeSession,
    },
    refs: {
      decodedImageRef: { current: null },
      embeddedPreviewUrlRef: { current: null },
      isMountedRef: { current: true },
      runtimeWorkSessionIdRef: { current: null },
      pendingLoadSessionIdRef: { current: null },
      previewCopyCanvasRef: { current: null },
    },
  }
}

async function flushMicrotasks(rounds = 4) {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve()
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve
    reject = innerReject
  })

  return { promise, resolve, reject }
}

function createDecodedImage(width: number, height: number): DecodedImage {
  return {
    width,
    height,
    channels: 3,
    bitsPerChannel: 16,
    data: new Uint16Array(0),
    layout: 'rgb-u16',
    colorSpace: 'linear-prophoto-rgb',
    source: 'quick',
    metadata: { width, height },
    renderExposure: { ev: 0, multiplier: 1, source: 'identity' },
  }
}

function createRuntimeSession(
  overrides: Partial<RawRuntimeSession> = {},
): RawRuntimeSession {
  return {
    sourceDimensions: { width: 6000, height: 4000 },
    extractEmbeddedPreview: vi.fn().mockResolvedValue(null),
    decodeQuickRaw: vi.fn().mockResolvedValue(createDecodedImage(1600, 1067)),
    decodeBoundedHqRaw: vi
      .fn()
      .mockResolvedValue(createDecodedImage(4243, 2828)),
    applyCalibration: vi.fn().mockResolvedValue({ applied: true } as const),
    dispose: vi.fn(),
    ...overrides,
  }
}

describe('orchestrateRawLoad ack-before-work contract', () => {
  const defaultCapability: CapabilityVector = {
    coi: false,
    pthread: false,
    deviceMemoryGB: null,
    hwConcurrency: 2,
    webKitClass: 'unknown',
    deviceFormFactor: 'unknown',
    maybeOpfsSupported: false,
  }

  beforeEach(() => {
    openSessionMock.mockReset()
    previewBackendMock.resolvePreviewBackend
      .mockReset()
      .mockResolvedValue({ backend: 'cpu' })

    capabilityVectorMock.getCapabilityVectorSnapshot.mockReset()
    capabilityVectorMock.detectCapabilityVector
      .mockReset()
      .mockResolvedValue(defaultCapability)
    previewGpuBudgetMock.detectPreviewGpuCapabilitySnapshot
      .mockReset()
      .mockReturnValue(null)
    previewGpuBudgetMock.derivePreviewGpuBudget
      .mockReset()
      .mockReturnValue({ boundedHqMaxPixels: 8_000_000 })
  })

  it('commits visible status and sync setup before awaiting the paint boundary', async () => {
    const order: string[] = []
    openSessionMock.mockImplementation(
      () =>
        new Promise(() => {
          order.push('openSession')
        }),
    )

    let resolvePaint: () => void = () => {}
    const paintGate = new Promise<void>((resolve) => {
      resolvePaint = resolve
    })

    const ctx = buildContext({
      order,
      yieldToPaint: () => paintGate,
      getPrewarmState: () => 'ready',
    })

    const file = new File(['raw'], 'sample.ARW')
    const loadPromise = orchestrateRawLoad(file, ctx)

    await flushMicrotasks()

    expect(order[0]).toBe('status:loading')
    expect(order).toContain('yieldToPaint')
    expect(order).toContain('replaceFile')
    expect(order).toContain('abortRuntimeWork')
    expect(order.indexOf('replaceFile')).toBeLessThan(
      order.indexOf('yieldToPaint'),
    )
    expect(order).not.toContain('openSession')

    resolvePaint()
    await flushMicrotasks()

    expect(order).toContain('openSession')
    expect(order.indexOf('yieldToPaint')).toBeLessThan(
      order.indexOf('openSession'),
    )

    loadPromise.catch(() => undefined)
  })

  it('reads the split from the view port and resets only the look through the color port', async () => {
    openSessionMock.mockImplementation(() => new Promise(() => {}))
    const ctx = buildContext({
      order: [],
      yieldToPaint: () => Promise.resolve(),
      getPrewarmState: () => 'ready',
    })
    const intent: ColorGraphIntent = {
      ...defaultIntent,
      intensity: 0.37,
      userContrast: 24,
    }
    vi.mocked(ctx.atoms.getColorIntent).mockReturnValue(intent)
    vi.mocked(ctx.atoms.getView).mockReturnValue({
      mode: 'original',
      compareSplit: 0.62,
    })

    const loadPromise = orchestrateRawLoad(new File(['raw'], 'next.ARW'), ctx)
    await flushMicrotasks()

    expect(ctx.atoms.setColorIntent).toHaveBeenCalledTimes(1)
    const writeIntent = vi.mocked(ctx.atoms.setColorIntent).mock.calls[0]![0]
    const written =
      typeof writeIntent === 'function' ? writeIntent(intent) : writeIntent
    expect(written).toEqual({
      ...intent,
      intensity: 0.7,
      styleKind: 'none',
      builtinPreset: null,
    })
    expect(written).not.toHaveProperty('viewMode')
    expect(written).not.toHaveProperty('compareSplit')

    const nextSession = vi.mocked(ctx.services.replaceFile).mock.results[0]!
      .value as ReturnType<typeof createImageSession>
    const startSession = vi
      .mocked(ctx.atoms.setSession)
      .mock.calls.map(([update]) => update)
      .find((update) => typeof update === 'function')
    expect(startSession).toBeDefined()
    const started = (
      startSession as (
        prev: ReturnType<typeof createImageSession> | null,
      ) => ReturnType<typeof createImageSession> | null
    )(nextSession)
    expect(started?.viewState).toMatchObject({
      mode: 'compare',
      compareSplit: 0.62,
    })

    loadPromise.catch(() => undefined)
  })

  it('does not open a runtime session when superseded during capability detection', async () => {
    const order: string[] = []
    const capability = deferred<CapabilityVector>()
    capabilityVectorMock.detectCapabilityVector.mockReturnValue(
      capability.promise,
    )
    openSessionMock.mockImplementation(
      () =>
        new Promise(() => {
          order.push('openSession')
        }),
    )

    const ctx = buildContext({
      order,
      yieldToPaint: () => Promise.resolve(),
      getPrewarmState: () => 'ready',
    })

    const file = new File(['raw'], 'sample.ARW')
    const loadPromise = orchestrateRawLoad(file, ctx)

    await flushMicrotasks()

    ctx.refs.runtimeWorkSessionIdRef.current = 'newer-session'
    capability.resolve(defaultCapability)
    await loadPromise

    expect(openSessionMock).not.toHaveBeenCalled()
    expect(
      vi.mocked(ctx.services.beginRuntimeSession).mock.results[0]!.value,
    ).toMatchObject({ signal: { aborted: true } })
  })

  it('enters warming when prewarm is pending and flips to loading after prewarm resolves', async () => {
    const order: string[] = []
    openSessionMock.mockImplementation(() => new Promise(() => {}))

    let resolvePrewarm: (outcome: {
      status: 'ready' | 'failed'
      reason?: string
    }) => void = () => {}
    const prewarmPromise = new Promise<{
      status: 'ready' | 'failed'
      reason?: string
    }>((resolve) => {
      resolvePrewarm = resolve
    })

    const ctx = buildContext({
      order,
      yieldToPaint: () => Promise.resolve(),
      getPrewarmState: () => 'pending',
      prewarm: () => prewarmPromise,
    })

    const file = new File(['raw'], 'sample.ARW')
    const loadPromise = orchestrateRawLoad(file, ctx)

    await flushMicrotasks()

    expect(order[0]).toBe('status:warming')
    expect(order).not.toContain('status:loading')

    resolvePrewarm({ status: 'ready' })
    await flushMicrotasks()

    expect(order).toContain('status:loading')
    expect(order.indexOf('status:warming')).toBeLessThan(
      order.indexOf('status:loading'),
    )

    loadPromise.catch(() => undefined)
  })

  it('awaits the backend before opening RAW and applying its bounded HQ budget', async () => {
    const order: string[] = []
    const gpu = {
      webgpu: true,
      maxTextureSize: 8192,
    }
    const quick = createDecodedImage(1600, 1067)
    const bounded = createDecodedImage(4243, 2828)
    const decodeBoundedHqRaw = vi.fn().mockResolvedValue(bounded)

    capabilityVectorMock.detectCapabilityVector.mockResolvedValue({
      ...defaultCapability,
      pthread: false,
      hwConcurrency: 8,
      webKitClass: 'chromium',
      deviceFormFactor: 'desktop',
    })
    previewGpuBudgetMock.detectPreviewGpuCapabilitySnapshot.mockReturnValue(gpu)
    previewGpuBudgetMock.derivePreviewGpuBudget.mockReturnValue({
      boundedHqMaxPixels: 12_000_000,
    })
    openSessionMock.mockResolvedValue({
      sourceDimensions: { width: 6000, height: 4000 },
      extractEmbeddedPreview: vi.fn().mockResolvedValue(null),
      decodeQuickRaw: vi.fn().mockResolvedValue(quick),
      decodeBoundedHqRaw,
      applyCalibration: vi.fn().mockResolvedValue({ applied: true } as const),
      dispose: vi.fn(),
    })

    const ctx = buildContext({
      order,
      yieldToPaint: () => Promise.resolve(),
      getPrewarmState: () => 'ready',
    })

    const backendReady = deferred<{ backend: 'webgpu' }>()
    previewBackendMock.resolvePreviewBackend.mockReturnValue(
      backendReady.promise,
    )
    const load = orchestrateRawLoad(new File(['raw'], 'sample.ARW'), ctx)
    await flushMicrotasks(8)
    expect(openSessionMock).not.toHaveBeenCalled()
    expect(previewGpuBudgetMock.derivePreviewGpuBudget).not.toHaveBeenCalled()
    backendReady.resolve({ backend: 'webgpu' })
    await load

    expect(previewGpuBudgetMock.derivePreviewGpuBudget).toHaveBeenCalledWith({
      capability: {
        ...defaultCapability,
        pthread: false,
        hwConcurrency: 8,
        webKitClass: 'chromium',
        deviceFormFactor: 'desktop',
      },
      gpu,
      sourceWidth: 6000,
      sourceHeight: 4000,
    })
    expect(decodeBoundedHqRaw).toHaveBeenCalledWith(
      { maxOutputPixels: 12_000_000, pinnedExposure: quick.renderExposure },
      undefined,
      expect.any(AbortSignal),
    )
  })

  it('does not open RAW when forced backend initialization fails', async () => {
    const ctx = buildContext({
      order: [],
      yieldToPaint: () => Promise.resolve(),
      getPrewarmState: () => 'ready',
    })
    previewBackendMock.resolvePreviewBackend.mockRejectedValue(
      new Error('WebGPU preview is unavailable'),
    )
    await orchestrateRawLoad(new File(['raw'], 'sample.ARW'), ctx)
    expect(openSessionMock).not.toHaveBeenCalled()
    expect(ctx.atoms.setStatus).toHaveBeenCalledWith('error')
  })

  it('does not open a superseded session after delayed backend detection', async () => {
    const ctx = buildContext({
      order: [],
      yieldToPaint: () => Promise.resolve(),
      getPrewarmState: () => 'ready',
    })
    const backendReady = deferred<void>()
    previewBackendMock.resolvePreviewBackend.mockReturnValue(
      backendReady.promise,
    )
    const load = orchestrateRawLoad(new File(['raw'], 'sample.ARW'), ctx)
    await flushMicrotasks(8)
    ctx.refs.runtimeWorkSessionIdRef.current = 'newer-session'
    backendReady.resolve()
    await load
    expect(openSessionMock).not.toHaveBeenCalled()
  })

  it('surfaces failures thrown before the session exists instead of sticking in loading', async () => {
    const order: string[] = []
    const ctx = buildContext({
      order,
      yieldToPaint: () => Promise.resolve(),
      getPrewarmState: () => 'ready',
    })
    vi.mocked(ctx.services.replaceFile).mockImplementation(() => {
      throw new Error('session creation failed')
    })

    await orchestrateRawLoad(new File(['raw'], 'sample.ARW'), ctx)

    expect(ctx.atoms.setError).toHaveBeenCalledWith('session creation failed')
    expect(order).toContain('status:error')
    expect(ctx.services.scheduleToast).toHaveBeenCalled()
  })
})

describe('orchestrateRawLoad host session lease', () => {
  const capability: CapabilityVector = {
    coi: false,
    pthread: false,
    deviceMemoryGB: null,
    hwConcurrency: 2,
    webKitClass: 'unknown',
    deviceFormFactor: 'unknown',
    maybeOpfsSupported: false,
  }

  beforeEach(() => {
    openSessionMock.mockReset()
    previewBackendMock.resolvePreviewBackend
      .mockReset()
      .mockResolvedValue({ backend: 'cpu' })
    capabilityVectorMock.getCapabilityVectorSnapshot.mockReset()
    capabilityVectorMock.detectCapabilityVector
      .mockReset()
      .mockResolvedValue(capability)
    previewGpuBudgetMock.detectPreviewGpuCapabilitySnapshot
      .mockReset()
      .mockReturnValue(null)
    previewGpuBudgetMock.derivePreviewGpuBudget.mockReset()
  })

  function buildLeaseContext() {
    const host = createLeaseHost()
    const ctx = buildContext(
      {
        order: [],
        yieldToPaint: () => Promise.resolve(),
        getPrewarmState: () => 'ready',
      },
      host,
    )
    return { ctx, host }
  }

  it('opens the source once on its own lease, decodes quick before bounded HQ, and keeps the lease until HQ settles', async () => {
    const quick = createDecodedImage(1600, 1067)
    const boundedHq = deferred<DecodedImage>()
    const runtimeSession = createRuntimeSession({
      decodeQuickRaw: vi.fn().mockResolvedValue(quick),
      decodeBoundedHqRaw: vi.fn(() => boundedHq.promise),
    })
    openSessionMock.mockResolvedValue(runtimeSession)
    const { ctx, host } = buildLeaseContext()
    const file = new File(['raw'], 'sample.ARW')

    await orchestrateRawLoad(file, ctx)

    expect(host.beginRuntimeSession).toHaveBeenCalledTimes(1)
    const [lease] = host.leases
    expect(lease!.open).toHaveBeenCalledTimes(1)
    expect(lease!.open).toHaveBeenCalledWith(file)
    expect(runtimeSession.decodeQuickRaw).toHaveBeenCalledWith(
      expect.any(Function),
      lease!.signal,
    )
    expect(runtimeSession.decodeBoundedHqRaw).toHaveBeenCalledWith(
      expect.objectContaining({ pinnedExposure: quick.renderExposure }),
      undefined,
      lease!.signal,
    )
    expect(
      vi.mocked(runtimeSession.decodeQuickRaw).mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(runtimeSession.decodeBoundedHqRaw).mock.invocationCallOrder[0]!,
    )
    expect(lease!.release).not.toHaveBeenCalled()
    expect(lease!.cancel).not.toHaveBeenCalled()
    expect(ctx.refs.runtimeWorkSessionIdRef.current).not.toBeNull()

    boundedHq.resolve(createDecodedImage(4243, 2828))
    await vi.waitFor(() => expect(lease!.release).toHaveBeenCalled())
    expect(lease!.cancel).not.toHaveBeenCalled()
    expect(ctx.refs.runtimeWorkSessionIdRef.current).toBeNull()
    expect(runtimeSession.dispose).not.toHaveBeenCalled()
  })

  it('releases the lease as soon as a preview without bounded HQ completes', async () => {
    previewGpuBudgetMock.detectPreviewGpuCapabilitySnapshot.mockReturnValue({
      webgpu: true,
      maxTextureSize: 8192,
    })
    previewGpuBudgetMock.derivePreviewGpuBudget.mockReturnValue({
      boundedHqMaxPixels: 1,
    })
    const runtimeSession = createRuntimeSession({
      sourceDimensions: { width: 1200, height: 800 },
    })
    openSessionMock.mockResolvedValue(runtimeSession)
    const { ctx, host } = buildLeaseContext()

    await orchestrateRawLoad(new File(['raw'], 'small.ARW'), ctx)

    const [lease] = host.leases
    expect(runtimeSession.decodeBoundedHqRaw).not.toHaveBeenCalled()
    expect(lease!.release).toHaveBeenCalled()
    expect(lease!.cancel).not.toHaveBeenCalled()
    expect(ctx.refs.runtimeWorkSessionIdRef.current).toBeNull()
  })

  it('fails early and cancels the lease when the source does not open', async () => {
    openSessionMock.mockRejectedValue(
      Object.assign(new Error('open exploded'), { code: 'RAW_OPEN_FAILED' }),
    )
    const { ctx, host } = buildLeaseContext()

    await orchestrateRawLoad(new File(['raw'], 'broken.ARW'), ctx)

    const [lease] = host.leases
    expect(lease!.open).toHaveBeenCalledTimes(1)
    expect(lease!.cancel).toHaveBeenCalled()
    expect(ctx.atoms.setError).toHaveBeenLastCalledWith('open exploded')
    expect(ctx.atoms.setStatus).toHaveBeenLastCalledWith('error')
    expect(ctx.refs.runtimeWorkSessionIdRef.current).toBeNull()
  })

  it('cancels the lease without opening when prewarm fails', async () => {
    const host = createLeaseHost(async () => ({
      status: 'failed',
      reason: 'no runtime',
    }))
    const ctx = buildContext(
      {
        order: [],
        yieldToPaint: () => Promise.resolve(),
        getPrewarmState: () => 'idle',
      },
      host,
    )

    await orchestrateRawLoad(new File(['raw'], 'sample.ARW'), ctx)

    const [lease] = host.leases
    expect(lease!.prewarm).toHaveBeenCalledTimes(1)
    expect(lease!.open).not.toHaveBeenCalled()
    expect(lease!.cancel).toHaveBeenCalled()
    expect(ctx.atoms.setError).toHaveBeenLastCalledWith('no runtime')
  })

  it('reports nothing when a newer load ends its warm-up', async () => {
    const warmup = deferred<never>()
    const host = createLeaseHost(() => warmup.promise)
    const ctx = buildContext(
      {
        order: [],
        yieldToPaint: () => Promise.resolve(),
        getPrewarmState: () => 'pending',
      },
      host,
    )

    const load = orchestrateRawLoad(new File(['raw'], 'sample.ARW'), ctx)
    await vi.waitFor(() => expect(host.leases[0]!.prewarm).toHaveBeenCalled())
    ctx.refs.runtimeWorkSessionIdRef.current = 'newer-session'
    warmup.reject(
      Object.assign(new Error('The RAW session lease ended.'), {
        code: 'RAW_JOB_CANCELLED',
      }),
    )
    await load

    expect(host.leases[0]!.open).not.toHaveBeenCalled()
    expect(host.leases[0]!.cancel).toHaveBeenCalled()
    expect(ctx.atoms.setError).not.toHaveBeenCalledWith(
      'The RAW session lease ended.',
    )
    expect(ctx.atoms.setStatus).not.toHaveBeenCalledWith('error')
    expect(ctx.services.scheduleToast).not.toHaveBeenCalled()
  })

  it('publishes nothing from an open that settles after unmount and cancels the lease', async () => {
    const open = deferred<RawRuntimeSession>()
    const runtimeSession = createRuntimeSession()
    openSessionMock.mockReturnValue(open.promise)
    const { ctx, host } = buildLeaseContext()

    const load = orchestrateRawLoad(new File(['raw'], 'sample.ARW'), ctx)
    await vi.waitFor(() => expect(openSessionMock).toHaveBeenCalled())
    const sessionWrites = vi.mocked(ctx.atoms.setSession).mock.calls.length
    ctx.refs.isMountedRef.current = false
    open.resolve(runtimeSession)
    await load

    expect(host.leases[0]!.cancel).toHaveBeenCalled()
    expect(runtimeSession.decodeQuickRaw).not.toHaveBeenCalled()
    expect(ctx.atoms.setSession).toHaveBeenCalledTimes(sessionWrites)
    expect(ctx.atoms.setError).not.toHaveBeenCalledWith(expect.any(String))
  })

  it('publishes no bounded HQ frame after unmount and still releases the lease', async () => {
    const boundedHq = deferred<DecodedImage>()
    const runtimeSession = createRuntimeSession({
      decodeBoundedHqRaw: vi.fn(() => boundedHq.promise),
    })
    openSessionMock.mockResolvedValue(runtimeSession)
    const { ctx, host } = buildLeaseContext()

    await orchestrateRawLoad(new File(['raw'], 'sample.ARW'), ctx)
    const decodedWrites = vi.mocked(ctx.services.setDecodedImageRef).mock.calls
      .length
    ctx.refs.isMountedRef.current = false
    boundedHq.resolve(createDecodedImage(4243, 2828))

    await vi.waitFor(() => expect(host.leases[0]!.release).toHaveBeenCalled())
    expect(ctx.services.setDecodedImageRef).toHaveBeenCalledTimes(decodedWrites)
    expect(ctx.services.scheduleToast).not.toHaveBeenCalled()
  })

  it('begins a fresh lease for each load', async () => {
    openSessionMock.mockImplementation(async () => createRuntimeSession())
    const { ctx, host } = buildLeaseContext()

    await orchestrateRawLoad(new File(['raw'], 'a.ARW'), ctx)
    await orchestrateRawLoad(new File(['raw'], 'b.ARW'), ctx)

    expect(host.beginRuntimeSession).toHaveBeenCalledTimes(2)
    expect(host.leases[0]!.open).toHaveBeenCalledTimes(1)
    expect(host.leases[1]!.open).toHaveBeenCalledTimes(1)
  })
})

describe('orchestrateRawLoad session store', () => {
  const capability: CapabilityVector = {
    coi: false,
    pthread: false,
    deviceMemoryGB: null,
    hwConcurrency: 2,
    webKitClass: 'unknown',
    deviceFormFactor: 'unknown',
    maybeOpfsSupported: false,
  }

  beforeEach(() => {
    openSessionMock.mockReset()
    previewBackendMock.resolvePreviewBackend
      .mockReset()
      .mockResolvedValue({ backend: 'cpu' })
    capabilityVectorMock.getCapabilityVectorSnapshot.mockReset()
    capabilityVectorMock.detectCapabilityVector
      .mockReset()
      .mockResolvedValue(capability)
    previewGpuBudgetMock.detectPreviewGpuCapabilitySnapshot
      .mockReset()
      .mockReturnValue(null)
    previewGpuBudgetMock.derivePreviewGpuBudget.mockReset()
  })

  function createParsedLut(): ParsedLUT {
    return {
      title: 'Store Look',
      sourceName: 'store-look.cube',
      comments: [],
      size: 2,
      domainMin: [0, 0, 0],
      domainMax: [1, 1, 1],
      data: new Float32Array(2 * 2 * 2 * 3),
      fingerprint: 'store-look-fingerprint',
      profileResolution: { kind: 'unknown' },
      inputProfile: 'display-srgb',
    }
  }

  function buildStoreContext(
    options: {
      store?: ReturnType<typeof createSessionStore>
      host?: ReturnType<typeof createLeaseHost>
      getPrewarmState?: OrderingHooks['getPrewarmState']
    } = {},
  ) {
    const store = options.store ?? createSessionStore()
    const host = options.host ?? createLeaseHost()
    const ctx = buildContext(
      {
        order: [],
        yieldToPaint: () => Promise.resolve(),
        getPrewarmState: options.getPrewarmState ?? (() => 'ready'),
      },
      host,
      store,
    )
    return { ctx, store, host }
  }

  it('publishes the replacement to the store before any later command in the same tick', () => {
    openSessionMock.mockImplementation(() => new Promise(() => {}))
    const { ctx, store } = buildStoreContext()

    void orchestrateRawLoad(new File(['raw'], 'next.ARW'), ctx)

    // Nothing has been awaited yet: the next command in this tick reads the
    // replacement, with its load already started, from the store.
    const published = store.get()
    expect(published?.sourceFile.name).toBe('next.ARW')
    expect(published?.id).toBe(ctx.refs.runtimeWorkSessionIdRef.current)
    expect(published?.id).toBe(ctx.refs.pendingLoadSessionIdRef.current)
    expect(published?.viewState).toMatchObject({
      mode: 'compare',
      compareSplit: 0.5,
    })
  })

  it('carries the look strength the store holds when the load starts', async () => {
    openSessionMock.mockImplementation(() => new Promise(() => {}))
    const lut = createParsedLut()
    const store = createSessionStore(
      createImageSession(new File(['raw'], 'first.ARW'), {
        activeStyle: { ...toCustomStyle(lut), currentIntensity: 0.33 },
      }),
    )
    const { ctx } = buildStoreContext({ store })
    vi.mocked(ctx.atoms.getLut).mockReturnValue(lut)

    void orchestrateRawLoad(new File(['raw'], 'second.ARW'), ctx)
    await flushMicrotasks()

    expect(store.get()).toMatchObject({
      sourceFile: { name: 'second.ARW' },
      activeStyle: { kind: 'custom', currentIntensity: 0.33 },
    })
    expect(ctx.atoms.setColorIntent).toHaveBeenCalledTimes(1)
  })

  it('publishes no frame once the store holds another session, even while the runtime epoch still names the load', async () => {
    const quick = deferred<DecodedImage>()
    const runtimeSession = createRuntimeSession({
      decodeQuickRaw: vi.fn(() => quick.promise),
    })
    openSessionMock.mockResolvedValue(runtimeSession)
    const { ctx, store } = buildStoreContext()

    const load = orchestrateRawLoad(new File(['raw'], 'first.ARW'), ctx)
    await vi.waitFor(() =>
      expect(runtimeSession.decodeQuickRaw).toHaveBeenCalled(),
    )
    const loadSessionId = store.get()!.id
    const successor = createImageSession(new File(['raw'], 'other.ARW'))
    store.set(successor)
    quick.resolve(createDecodedImage(1600, 1067))
    await load

    expect(ctx.refs.runtimeWorkSessionIdRef.current).toBe(loadSessionId)
    expect(store.get()).toBe(successor)
    expect(ctx.services.setDecodedImageRef).toHaveBeenCalledTimes(1)
    expect(ctx.services.setDecodedImageRef).toHaveBeenCalledWith(null)
    expect(ctx.atoms.setStatus).not.toHaveBeenCalledWith('ready')
  })

  it('leaves the successor alone when a replaced open rejects late', async () => {
    const lateOpen = deferred<RawRuntimeSession>()
    const successorOpen = deferred<RawRuntimeSession>()
    openSessionMock
      .mockReturnValueOnce(lateOpen.promise)
      .mockReturnValueOnce(successorOpen.promise)
    const { ctx, store, host } = buildStoreContext()

    const first = orchestrateRawLoad(new File(['raw'], 'first.ARW'), ctx)
    await vi.waitFor(() => expect(openSessionMock).toHaveBeenCalledTimes(1))
    void orchestrateRawLoad(new File(['raw'], 'second.ARW'), ctx)
    await vi.waitFor(() => expect(openSessionMock).toHaveBeenCalledTimes(2))
    const successor = store.get()!
    expect(successor.sourceFile.name).toBe('second.ARW')

    lateOpen.reject(
      Object.assign(new Error('open exploded'), { code: 'RAW_OPEN_FAILED' }),
    )
    await first

    expect(store.get()).toBe(successor)
    expect(ctx.refs.runtimeWorkSessionIdRef.current).toBe(successor.id)
    expect(ctx.refs.pendingLoadSessionIdRef.current).toBe(successor.id)
    expect(ctx.atoms.setError).not.toHaveBeenCalledWith('open exploded')
    expect(ctx.atoms.setStatus).not.toHaveBeenCalledWith('error')
    expect(ctx.services.scheduleToast).not.toHaveBeenCalled()
    expect(host.leases[0]!.cancel).toHaveBeenCalled()
    expect(host.leases[1]!.cancel).not.toHaveBeenCalled()
    expect(host.leases[1]!.release).not.toHaveBeenCalled()
  })

  it('reports nothing from a replaced quick decode that fails late', async () => {
    const quick = deferred<DecodedImage>()
    const replaced = createRuntimeSession({
      decodeQuickRaw: vi.fn(() => quick.promise),
    })
    openSessionMock
      .mockResolvedValueOnce(replaced)
      .mockReturnValueOnce(new Promise(() => {}))
    const { ctx, store } = buildStoreContext()

    const first = orchestrateRawLoad(new File(['raw'], 'first.ARW'), ctx)
    await vi.waitFor(() => expect(replaced.decodeQuickRaw).toHaveBeenCalled())
    void orchestrateRawLoad(new File(['raw'], 'second.ARW'), ctx)
    await vi.waitFor(() => expect(openSessionMock).toHaveBeenCalledTimes(2))
    const successor = store.get()!
    const sessionWrites = vi.mocked(ctx.atoms.setSession).mock.calls.length

    quick.reject(
      Object.assign(new Error('decode exploded'), {
        code: 'RAW_DECODE_FAILED',
      }),
    )
    await first

    expect(store.get()).toBe(successor)
    expect(ctx.atoms.setSession).toHaveBeenCalledTimes(sessionWrites)
    expect(ctx.refs.runtimeWorkSessionIdRef.current).toBe(successor.id)
    expect(ctx.refs.pendingLoadSessionIdRef.current).toBe(successor.id)
    expect(ctx.atoms.setStatus).not.toHaveBeenCalledWith('error')
    expect(ctx.services.scheduleToast).not.toHaveBeenCalled()
  })

  it('opens nothing for a load replaced while it warms and leaves the successor its epochs', async () => {
    const warmup = deferred<{ status: 'ready' }>()
    const prewarm = vi
      .fn<RawRuntimeSessionLease['prewarm']>()
      .mockReturnValueOnce(warmup.promise)
      .mockResolvedValue({ status: 'ready' })
    const host = createLeaseHost(prewarm)
    const getPrewarmState = vi
      .fn<OrderingHooks['getPrewarmState']>()
      .mockReturnValueOnce('pending')
      .mockReturnValue('ready')
    openSessionMock.mockReturnValue(new Promise(() => {}))
    const { ctx, store } = buildStoreContext({ host, getPrewarmState })

    const first = orchestrateRawLoad(new File(['raw'], 'first.ARW'), ctx)
    await vi.waitFor(() => expect(host.leases[0]!.prewarm).toHaveBeenCalled())
    void orchestrateRawLoad(new File(['raw'], 'second.ARW'), ctx)
    await vi.waitFor(() => expect(host.leases[1]!.open).toHaveBeenCalled())
    const successor = store.get()!

    warmup.resolve({ status: 'ready' })
    await first

    expect(host.leases[0]!.open).not.toHaveBeenCalled()
    expect(host.leases[0]!.cancel).toHaveBeenCalled()
    expect(openSessionMock).toHaveBeenCalledTimes(1)
    expect(store.get()).toBe(successor)
    expect(ctx.refs.runtimeWorkSessionIdRef.current).toBe(successor.id)
    expect(ctx.refs.pendingLoadSessionIdRef.current).toBe(successor.id)
  })

  it('keeps the bounded HQ lease of a replaced load until it settles, then leaves the successor epoch', async () => {
    const boundedHq = deferred<DecodedImage>()
    const replaced = createRuntimeSession({
      decodeBoundedHqRaw: vi.fn(() => boundedHq.promise),
    })
    openSessionMock
      .mockResolvedValueOnce(replaced)
      .mockReturnValueOnce(new Promise(() => {}))
    const { ctx, store, host } = buildStoreContext()

    await orchestrateRawLoad(new File(['raw'], 'first.ARW'), ctx)
    expect(host.leases[0]!.release).not.toHaveBeenCalled()
    void orchestrateRawLoad(new File(['raw'], 'second.ARW'), ctx)
    await vi.waitFor(() => expect(openSessionMock).toHaveBeenCalledTimes(2))
    const successor = store.get()!
    const decodedWrites = vi.mocked(ctx.services.setDecodedImageRef).mock.calls
      .length

    boundedHq.resolve(createDecodedImage(4243, 2828))
    await vi.waitFor(() => expect(host.leases[0]!.release).toHaveBeenCalled())

    expect(ctx.services.setDecodedImageRef).toHaveBeenCalledTimes(decodedWrites)
    expect(store.get()).toBe(successor)
    expect(ctx.refs.runtimeWorkSessionIdRef.current).toBe(successor.id)
  })
})
