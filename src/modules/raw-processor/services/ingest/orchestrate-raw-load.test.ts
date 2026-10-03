import type { ProcessingParams } from '@lumaforge/luma-color-runtime'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { DecodedImage } from '~/lib/raw/decoder'
import type { CapabilityVector } from '~/lib/runtime/capability-vector'

import { createImageSession } from '../../model/session-factory'
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

vi.mock('~/lib/raw/runtime-adapter', () => ({
  rawRuntimeAdapter: {
    openSession: vi.fn(),
    extractEmbeddedPreview: vi.fn(),
    decodeQuickRaw: vi.fn(),
    decodeBoundedHqRaw: vi.fn(),
    prewarm: vi.fn(),
    getPrewarmState: vi.fn(),
  },
}))

vi.mock('~/lib/runtime/capability-vector', () => capabilityVectorMock)
vi.mock('~/lib/runtime/preview-gpu-budget', () => previewGpuBudgetMock)
vi.mock('~/lib/preview/gpu-backend', () => previewBackendMock)

const defaultParams: ProcessingParams = {
  intensity: 0.7,
  viewMode: 'compare',
  compareSplit: 0.5,
  styleKind: 'none',
  builtinPreset: null,
  userExposureEv: 0,
  userContrast: 0,
  userHighlights: 0,
  userShadows: 0,
  userWhites: 0,
  userBlacks: 0,
  userTemperature: 0,
  userTint: 0,
  userSaturation: 0,
  userVibrance: 0,
}

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

function buildContext(hooks: OrderingHooks): RawLoadContext {
  const { order } = hooks
  return {
    atoms: {
      setStatus: vi.fn((status) => order.push(`status:${status}`)),
      setError: vi.fn(),
      setProgress: vi.fn(),
      getProcessingParams: vi.fn(() => defaultParams),
      getLut: vi.fn(() => null),
      setParams: vi.fn(),
      setSession: vi.fn(),
      setDecodedImageVersion: vi.fn(),
      setStats: vi.fn(),
      setPendingRecoveryRetry: vi.fn(),
    },
    services: {
      scheduleToast: vi.fn(),
      replaceFile: vi.fn((file) => {
        order.push('replaceFile')
        return createImageSession(file)
      }),
      abortRuntimeWork: vi.fn(() => order.push('abortRuntimeWork')),
      abortExportWork: vi.fn(() => order.push('abortExportWork')),
      queueExportResultResourceDisposal: vi.fn(),
      revokeCurrentEmbeddedPreviewUrl: vi.fn(),
      clearSessionEmbeddedPreviewUrl: vi.fn(),
      setDecodedImageRef: vi.fn(),
      invalidateExportGraph: vi.fn(),
      registerCurrentPreviewPipelineForEvacuation: vi.fn(),
      disposeRuntimeSession: vi.fn(),
      yieldToPaint: vi.fn(async () => {
        order.push('yieldToPaint')
        await hooks.yieldToPaint()
      }),
      getPrewarmState: hooks.getPrewarmState,
      prewarm:
        hooks.prewarm ??
        (async () => {
          order.push('prewarm')
          return { status: 'ready' as const }
        }),
    },
    refs: {
      runtimeAbortControllerRef: { current: null },
      runtimeSessionRef: { current: null },
      disposedRuntimeSessionsRef: { current: new WeakSet() },
      decodedImageRef: { current: null },
      sessionRef: { current: null },
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

  beforeEach(async () => {
    const { rawRuntimeAdapter } = await import('~/lib/raw/runtime-adapter')
    vi.mocked(rawRuntimeAdapter.openSession).mockReset()
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
    const { rawRuntimeAdapter } = await import('~/lib/raw/runtime-adapter')
    vi.mocked(rawRuntimeAdapter.openSession).mockImplementation(
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

  it('does not open a runtime session when superseded during capability detection', async () => {
    const order: string[] = []
    const { rawRuntimeAdapter } = await import('~/lib/raw/runtime-adapter')
    const capability = deferred<CapabilityVector>()
    capabilityVectorMock.detectCapabilityVector.mockReturnValue(
      capability.promise,
    )
    vi.mocked(rawRuntimeAdapter.openSession).mockImplementation(
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

    expect(rawRuntimeAdapter.openSession).not.toHaveBeenCalled()
  })

  it('enters warming when prewarm is pending and flips to loading after prewarm resolves', async () => {
    const order: string[] = []
    const { rawRuntimeAdapter } = await import('~/lib/raw/runtime-adapter')
    vi.mocked(rawRuntimeAdapter.openSession).mockImplementation(
      () => new Promise(() => {}),
    )

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
    const { rawRuntimeAdapter } = await import('~/lib/raw/runtime-adapter')
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
    vi.mocked(rawRuntimeAdapter.openSession).mockResolvedValue({
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
    expect(rawRuntimeAdapter.openSession).not.toHaveBeenCalled()
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
      { maxOutputPixels: 12_000_000 },
      undefined,
      expect.any(AbortSignal),
    )
  })

  it('does not open RAW when forced backend initialization fails', async () => {
    const { rawRuntimeAdapter } = await import('~/lib/raw/runtime-adapter')
    const ctx = buildContext({
      order: [],
      yieldToPaint: () => Promise.resolve(),
      getPrewarmState: () => 'ready',
    })
    previewBackendMock.resolvePreviewBackend.mockRejectedValue(
      new Error('WebGPU preview is unavailable'),
    )
    await orchestrateRawLoad(new File(['raw'], 'sample.ARW'), ctx)
    expect(rawRuntimeAdapter.openSession).not.toHaveBeenCalled()
    expect(ctx.atoms.setStatus).toHaveBeenCalledWith('error')
  })

  it('does not open a superseded session after delayed backend detection', async () => {
    const { rawRuntimeAdapter } = await import('~/lib/raw/runtime-adapter')
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
    expect(rawRuntimeAdapter.openSession).not.toHaveBeenCalled()
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
