import type { ColorGraphIntent, ParsedLUT } from '@lumaforge/luma-color-runtime'
import {
  NEUTRAL_USER_COLOR_INTENT,
  parseCubeLUT,
} from '@lumaforge/luma-color-runtime'
import type { CapabilityVector } from '@lumaforge/render-engine/policy'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { DecodedImage, ProgressCallback } from '~/lib/raw/decoder'
import type { RawRuntimeSessionLease } from '~/lib/raw/raw-runtime-host'
import type {
  PrewarmOutcome,
  PrewarmState,
  RawRuntimeSession,
} from '~/lib/raw/runtime-adapter'

import type { ImageSession } from '../../model/session'
import { createImageSession } from '../../model/session-factory'
import {
  createTestCube,
  createTestDecodedImage,
  createTestSession,
} from '../../test-support/builders'
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

vi.mock('~/lib/runtime/capability-vector', () => capabilityVectorMock)
vi.mock('~/lib/runtime/preview-gpu-budget', () => previewGpuBudgetMock)
vi.mock('~/lib/preview/gpu-backend', () => previewBackendMock)

const CAPABILITY: CapabilityVector = {
  coi: false,
  pthread: false,
  deviceMemoryGB: null,
  hwConcurrency: 2,
  webKitClass: 'unknown',
  deviceFormFactor: 'unknown',
  maybeOpfsSupported: false,
}

const INTENT: ColorGraphIntent = {
  ...NEUTRAL_USER_COLOR_INTENT,
  intensity: 0.7,
  styleKind: 'none',
  builtinPreset: null,
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

const never = () => new Promise<never>(() => {})

function createRuntimeSession(
  overrides: Partial<RawRuntimeSession> = {},
): RawRuntimeSession {
  return {
    sourceDimensions: { width: 6000, height: 4000 },
    extractEmbeddedPreview: vi.fn().mockResolvedValue(null),
    decodeQuickRaw: vi.fn().mockResolvedValue(createTestDecodedImage()),
    decodeBoundedHqRaw: vi
      .fn()
      .mockResolvedValue(createTestDecodedImage({ source: 'bounded-hq' })),
    dispose: vi.fn(),
    ...overrides,
  }
}

type TestLease = RawRuntimeSessionLease & {
  [K in 'prewarm' | 'open' | 'release' | 'cancel']: ReturnType<
    typeof vi.fn<RawRuntimeSessionLease[K]>
  >
}

/**
 * The load's ports over a synchronous session store, where a write is
 * visible to the next read in the same tick as with the production store,
 * and a host stand-in whose every lease warms through `prewarm` and opens
 * through `open`. `order` logs the status tail, the outgoing release, the
 * lease, the replacement, the paint boundary, and each open.
 */
function createLoad(initialSession: ImageSession | null = null) {
  const order: string[] = []
  let current = initialSession
  const set: RawLoadContext['atoms']['setSession'] = (value) => {
    current = typeof value === 'function' ? value(current) : value
  }
  const store = { get: () => current, set }
  const prewarm = vi.fn<RawRuntimeSessionLease['prewarm']>(async () => ({
    status: 'ready',
  }))
  const open = vi.fn<(file: File) => Promise<RawRuntimeSession>>(async () =>
    createRuntimeSession(),
  )
  const leases: TestLease[] = []
  const ctx: RawLoadContext = {
    atoms: {
      setStatus: vi.fn((status) => order.push(`status:${status}`)),
      setError: vi.fn((error) => order.push(`error:${String(error)}`)),
      setProgress: vi.fn((progress) => order.push(`progress:${progress}`)),
      getColorIntent: vi.fn(() => INTENT),
      getView: vi.fn(() => ({ mode: 'compare' as const, compareSplit: 0.5 })),
      getLut: vi.fn(() => null),
      setColorIntent: vi.fn(),
      getSession: vi.fn(store.get),
      setSession: vi.fn(store.set),
    },
    services: {
      notify: vi.fn(),
      replaceFile: vi.fn((file, retained) => {
        order.push('replaceFile')
        current = createImageSession(file, retained)
        return current
      }),
      abortRuntimeWork: vi.fn(() => order.push('abortRuntimeWork')),
      abortExportWork: vi.fn(() => order.push('abortExportWork')),
      queueExportResultResourceDisposal: vi.fn(),
      revokeCurrentEmbeddedPreviewUrl: vi.fn(),
      setDecodedImageRef: vi.fn(),
      yieldToPaint: vi.fn(async () => {
        order.push('yieldToPaint')
      }),
      getPrewarmState: vi.fn((): PrewarmState => 'ready'),
      beginRuntimeSession: vi.fn(() => {
        order.push('beginRuntimeSession')
        const controller = new AbortController()
        const lease: TestLease = {
          signal: controller.signal,
          prewarm: vi.fn(() => prewarm()),
          open: vi.fn((file: File) => {
            order.push('open')
            return open(file)
          }),
          release: vi.fn(),
          cancel: vi.fn(() => controller.abort()),
        }
        leases.push(lease)
        return lease
      }),
    },
    refs: {
      embeddedPreviewUrlRef: { current: null },
      isMountedRef: { current: true },
      runtimeWorkSessionIdRef: { current: null },
      pendingLoadSessionIdRef: { current: null },
      previewCopyCanvasRef: { current: null },
    },
  }
  return { ctx, store, order, prewarm, open, leases }
}

type Load = ReturnType<typeof createLoad>

const rawFile = (name = 'sample.ARW') => new File(['raw'], name)

beforeEach(() => {
  capabilityVectorMock.getCapabilityVectorSnapshot.mockReset()
  capabilityVectorMock.detectCapabilityVector
    .mockReset()
    .mockResolvedValue(CAPABILITY)
  previewGpuBudgetMock.detectPreviewGpuCapabilitySnapshot
    .mockReset()
    .mockReturnValue(null)
  previewGpuBudgetMock.derivePreviewGpuBudget.mockReset()
  previewBackendMock.resolvePreviewBackend
    .mockReset()
    .mockResolvedValue({ backend: 'cpu' })
})

describe('orchestrateRawLoad', () => {
  it('acks the load, releases the outgoing source, and publishes the replacement before the paint boundary, then opens', async () => {
    const h = createLoad()
    const paint = deferred<void>()
    h.ctx.services.yieldToPaint = () => {
      h.order.push('yieldToPaint')
      return paint.promise
    }
    h.open.mockReturnValue(never())

    void orchestrateRawLoad(rawFile('next.ARW'), h.ctx)

    expect(h.order).toEqual([
      'status:loading',
      'progress:0',
      'error:null',
      'abortExportWork',
      'abortRuntimeWork',
      'beginRuntimeSession',
      'replaceFile',
      'yieldToPaint',
    ])
    const published = h.store.get()!
    expect(published.sourceFile.name).toBe('next.ARW')
    expect(h.ctx.refs.runtimeWorkSessionIdRef.current).toBe(published.id)
    expect(h.ctx.refs.pendingLoadSessionIdRef.current).toBe(published.id)

    paint.resolve()
    await vi.waitFor(() => expect(h.order.at(-1)).toBe('open'))
  })

  it('starts the new session with the current split and resets only the look of the stored intent', () => {
    const h = createLoad()
    h.open.mockReturnValue(never())
    const intent = { ...INTENT, intensity: 0.37, userContrast: 24 }
    vi.mocked(h.ctx.atoms.getColorIntent).mockReturnValue(intent)
    vi.mocked(h.ctx.atoms.getView).mockReturnValue({
      mode: 'original',
      compareSplit: 0.62,
    })

    void orchestrateRawLoad(rawFile('next.ARW'), h.ctx)

    expect(h.ctx.atoms.setColorIntent).toHaveBeenCalledOnce()
    const write = vi.mocked(h.ctx.atoms.setColorIntent).mock.calls[0]![0]
    expect(typeof write === 'function' ? write(intent) : write).toEqual({
      ...intent,
      intensity: 0.7,
      styleKind: 'none',
      builtinPreset: null,
    })
    expect(h.store.get()?.viewState).toMatchObject({
      mode: 'compare',
      compareSplit: 0.62,
    })
  })

  it('retains the stored LUT look and its strength into the next session', () => {
    const lut: ParsedLUT = {
      ...parseCubeLUT(createTestCube('Store Look', 2), {
        sourceName: 'store-look.cube',
      }),
      fingerprint: 'store-look-fingerprint',
      profileResolution: { kind: 'unknown' },
    }
    const h = createLoad(
      createTestSession({
        activeStyle: { ...toCustomStyle(lut), currentIntensity: 0.33 },
      }),
    )
    h.open.mockReturnValue(never())
    vi.mocked(h.ctx.atoms.getLut).mockReturnValue(lut)

    void orchestrateRawLoad(rawFile('second.ARW'), h.ctx)

    expect(h.store.get()).toMatchObject({
      sourceFile: { name: 'second.ARW' },
      activeStyle: { kind: 'custom', currentIntensity: 0.33 },
    })
  })

  it('shows warming until its lease warms the runtime, then loading', async () => {
    const h = createLoad()
    const warm = deferred<PrewarmOutcome>()
    vi.mocked(h.ctx.services.getPrewarmState).mockReturnValue('pending')
    h.prewarm.mockReturnValue(warm.promise)
    h.open.mockReturnValue(never())

    void orchestrateRawLoad(rawFile(), h.ctx)
    await vi.waitFor(() => expect(h.leases[0]!.prewarm).toHaveBeenCalled())

    expect(h.order[0]).toBe('status:warming')
    expect(h.order).not.toContain('status:loading')

    warm.resolve({ status: 'ready' })
    await vi.waitFor(() => expect(h.order.at(-1)).toBe('open'))
    expect(h.order).toContain('status:loading')
  })

  it('awaits the preview backend before opening and sizes bounded HQ by its GPU budget with the quick frame exposure', async () => {
    const gpu = { webgpu: true, maxTextureSize: 8192 }
    previewGpuBudgetMock.detectPreviewGpuCapabilitySnapshot.mockReturnValue(gpu)
    previewGpuBudgetMock.derivePreviewGpuBudget.mockReturnValue({
      boundedHqMaxPixels: 12_000_000,
    })
    const backend = deferred<unknown>()
    previewBackendMock.resolvePreviewBackend.mockReturnValue(backend.promise)
    const quick = createTestDecodedImage({
      renderExposure: { ev: 0.5, multiplier: Math.SQRT2, source: 'identity' },
    })
    const session = createRuntimeSession({
      decodeQuickRaw: vi.fn().mockResolvedValue(quick),
    })
    const h = createLoad()
    h.open.mockResolvedValue(session)

    const load = orchestrateRawLoad(rawFile(), h.ctx)
    await vi.waitFor(() =>
      expect(previewBackendMock.resolvePreviewBackend).toHaveBeenCalled(),
    )
    expect(h.open).not.toHaveBeenCalled()
    backend.resolve({ backend: 'webgpu' })
    await load

    expect(previewGpuBudgetMock.derivePreviewGpuBudget).toHaveBeenCalledWith({
      capability: CAPABILITY,
      gpu,
      sourceWidth: 6000,
      sourceHeight: 4000,
    })
    expect(session.decodeBoundedHqRaw).toHaveBeenCalledWith(
      { maxOutputPixels: 12_000_000, pinnedExposure: quick.renderExposure },
      undefined,
      h.leases[0]!.signal,
    )
  })

  it('decodes on its lease, reports the loaded source once bounded HQ lands, and releases the lease only then', async () => {
    const hq = deferred<DecodedImage>()
    const session = createRuntimeSession({
      decodeQuickRaw: vi.fn(async (onProgress?: ProgressCallback) => {
        onProgress?.({ phase: 'decoding', progress: 50 })
        return createTestDecodedImage()
      }),
      decodeBoundedHqRaw: vi.fn(() => hq.promise),
    })
    const h = createLoad()
    h.open.mockResolvedValue(session)
    const file = rawFile()

    await orchestrateRawLoad(file, h.ctx)

    const lease = h.leases[0]!
    expect(lease.open).toHaveBeenCalledExactlyOnceWith(file)
    expect(session.decodeQuickRaw).toHaveBeenCalledWith(
      expect.any(Function),
      lease.signal,
    )
    expect(h.order).toEqual(
      expect.arrayContaining(['status:decoding', 'progress:50']),
    )
    expect(h.ctx.atoms.setStatus).toHaveBeenLastCalledWith('ready')
    expect(h.ctx.services.notify).not.toHaveBeenCalled()
    expect(lease.release).not.toHaveBeenCalled()
    expect(h.ctx.refs.runtimeWorkSessionIdRef.current).toBe(h.store.get()!.id)

    hq.resolve(
      createTestDecodedImage({
        source: 'bounded-hq',
        width: 80,
        height: 60,
        metadata: { width: 80, height: 60, make: 'Sony', model: 'ILCE-7RM5' },
      }),
    )
    await vi.waitFor(() => expect(lease.release).toHaveBeenCalled())

    expect(lease.cancel).not.toHaveBeenCalled()
    expect(h.ctx.refs.runtimeWorkSessionIdRef.current).toBeNull()
    expect(h.ctx.services.notify).toHaveBeenCalledExactlyOnceWith({
      kind: 'loaded',
      fileName: 'sample.ARW',
      width: 80,
      height: 60,
      make: 'Sony',
      model: 'ILCE-7RM5',
    })
  })

  it('releases the lease as soon as a preview with no bounded HQ step completes', async () => {
    previewGpuBudgetMock.detectPreviewGpuCapabilitySnapshot.mockReturnValue({
      webgpu: true,
      maxTextureSize: 8192,
    })
    previewGpuBudgetMock.derivePreviewGpuBudget.mockReturnValue({
      boundedHqMaxPixels: 1,
    })
    const session = createRuntimeSession({
      sourceDimensions: { width: 1200, height: 800 },
    })
    const h = createLoad()
    h.open.mockResolvedValue(session)

    await orchestrateRawLoad(rawFile('small.ARW'), h.ctx)

    expect(session.decodeBoundedHqRaw).not.toHaveBeenCalled()
    expect(h.leases[0]!.release).toHaveBeenCalled()
    expect(h.leases[0]!.cancel).not.toHaveBeenCalled()
    expect(h.ctx.refs.runtimeWorkSessionIdRef.current).toBeNull()
  })

  it.each([
    [
      'the runtime build has no probe',
      undefined,
      'Full-resolution export is not available in this runtime build yet.',
    ],
    [
      'the probe rejects',
      () => Promise.reject(new Error('probe exploded')),
      'probe exploded',
    ],
  ] as const)(
    'marks full-resolution export unsupported when %s',
    async (_case, probeExportCapability, reason) => {
      const h = createLoad()
      h.open.mockResolvedValue(
        createRuntimeSession(
          probeExportCapability ? { probeExportCapability } : {},
        ),
      )

      await orchestrateRawLoad(rawFile(), h.ctx)

      expect(h.store.get()?.exportState.fullResCapability).toEqual({
        status: 'unsupported',
        reason,
      })
    },
  )

  /** Holds the first load's step at a phase on `held`; later calls answer. */
  const HOLD_AT = {
    'detects capability': (_h: Load, held: Promise<never>) =>
      capabilityVectorMock.detectCapabilityVector.mockReturnValueOnce(held),
    'resolves the preview backend': (_h: Load, held: Promise<never>) =>
      previewBackendMock.resolvePreviewBackend.mockReturnValueOnce(held),
    warms: (h: Load, held: Promise<never>) => {
      vi.mocked(h.ctx.services.getPrewarmState).mockReturnValueOnce('pending')
      return h.prewarm.mockReturnValueOnce(held)
    },
    opens: (h: Load, held: Promise<never>) => h.open.mockReturnValueOnce(held),
    'decodes quick': (h: Load, held: Promise<never>) => {
      const session = createRuntimeSession({ decodeQuickRaw: () => held })
      h.open.mockResolvedValueOnce(session)
      return vi.spyOn(session, 'decodeQuickRaw')
    },
    'decodes bounded HQ': (h: Load, held: Promise<never>) => {
      const session = createRuntimeSession({ decodeBoundedHqRaw: () => held })
      h.open.mockResolvedValueOnce(session)
      return vi.spyOn(session, 'decodeBoundedHqRaw')
    },
  }

  it.each([
    ['detects capability', CAPABILITY, 'cancel'],
    ['resolves the preview backend', { backend: 'cpu' }, 'cancel'],
    [
      'warms',
      Object.assign(new Error('The RAW session lease ended.'), {
        code: 'RAW_JOB_CANCELLED',
      }),
      'cancel',
    ],
    ['opens', new Error('open exploded'), 'cancel'],
    ['decodes quick', new Error('decode exploded'), 'release'],
    [
      'decodes bounded HQ',
      createTestDecodedImage({ source: 'bounded-hq' }),
      'release',
    ],
  ] as const)(
    'leaves its successor alone when a load replaced while it %s settles late',
    async (phase, late, end) => {
      const h = createLoad()
      h.open.mockReturnValue(never())
      const held = deferred<never>()
      const step = HOLD_AT[phase](h, held.promise)

      const first = orchestrateRawLoad(rawFile('first.ARW'), h.ctx)
      await vi.waitFor(() => expect(step).toHaveBeenCalled())
      void orchestrateRawLoad(rawFile('second.ARW'), h.ctx)
      await vi.waitFor(() => expect(h.leases[1]?.open).toHaveBeenCalled())
      const successor = h.store.get()!
      const sessionWrites = vi.mocked(h.ctx.atoms.setSession).mock.calls.length
      const frameWrites = vi.mocked(h.ctx.services.setDecodedImageRef).mock
        .calls.length

      if (late instanceof Error) held.reject(late)
      else held.resolve(late as never)
      await first
      await vi.waitFor(() => expect(h.leases[0]![end]).toHaveBeenCalled())

      expect(h.store.get()).toBe(successor)
      expect(h.ctx.refs.runtimeWorkSessionIdRef.current).toBe(successor.id)
      expect(h.ctx.refs.pendingLoadSessionIdRef.current).toBe(successor.id)
      expect(h.ctx.atoms.setSession).toHaveBeenCalledTimes(sessionWrites)
      expect(h.ctx.services.setDecodedImageRef).toHaveBeenCalledTimes(
        frameWrites,
      )
      expect(h.ctx.atoms.setStatus).not.toHaveBeenCalledWith('error')
      expect(h.ctx.services.notify).not.toHaveBeenCalled()
      expect(h.leases[1]!.cancel).not.toHaveBeenCalled()
      expect(h.leases[1]!.release).not.toHaveBeenCalled()
    },
  )

  it('publishes nothing from an open that settles after the view unmounts, and cancels its lease', async () => {
    const open = deferred<RawRuntimeSession>()
    const session = createRuntimeSession()
    const h = createLoad()
    h.open.mockReturnValue(open.promise)

    const load = orchestrateRawLoad(rawFile(), h.ctx)
    await vi.waitFor(() => expect(h.open).toHaveBeenCalled())
    const sessionWrites = vi.mocked(h.ctx.atoms.setSession).mock.calls.length
    h.ctx.refs.isMountedRef.current = false
    open.resolve(session)
    await load

    expect(session.decodeQuickRaw).not.toHaveBeenCalled()
    expect(h.ctx.atoms.setSession).toHaveBeenCalledTimes(sessionWrites)
    expect(h.ctx.atoms.setError).not.toHaveBeenCalledWith(expect.any(String))
    expect(h.leases[0]!.cancel).toHaveBeenCalled()
  })

  it('publishes no frame once the store holds another session, even while the runtime epoch still names the load', async () => {
    const quick = deferred<DecodedImage>()
    const session = createRuntimeSession({
      decodeQuickRaw: vi.fn(() => quick.promise),
    })
    const h = createLoad()
    h.open.mockResolvedValue(session)

    const load = orchestrateRawLoad(rawFile('first.ARW'), h.ctx)
    await vi.waitFor(() => expect(session.decodeQuickRaw).toHaveBeenCalled())
    const loadSessionId = h.store.get()!.id
    const successor = createTestSession({ id: 'successor' })
    h.store.set(successor)
    quick.resolve(createTestDecodedImage())
    await load

    expect(h.ctx.refs.runtimeWorkSessionIdRef.current).toBe(loadSessionId)
    expect(h.store.get()).toBe(successor)
    expect(h.ctx.services.setDecodedImageRef).toHaveBeenCalledExactlyOnceWith(
      null,
    )
    expect(h.ctx.atoms.setStatus).not.toHaveBeenCalledWith('ready')
  })

  it.each([
    {
      failure: 'the source does not open',
      message: 'open exploded',
      opens: true,
      arrange: (h: Load) =>
        h.open.mockRejectedValue(
          Object.assign(new Error('open exploded'), {
            code: 'RAW_OPEN_FAILED',
          }),
        ),
    },
    {
      failure: 'the open rejects without a message',
      message: null,
      opens: true,
      arrange: (h: Load) => h.open.mockRejectedValue({ reason: 'closed' }),
    },
    {
      failure: 'the runtime does not warm',
      message: 'no runtime',
      opens: false,
      arrange: (h: Load) => {
        vi.mocked(h.ctx.services.getPrewarmState).mockReturnValue('idle')
        h.prewarm.mockResolvedValue({ status: 'failed', reason: 'no runtime' })
      },
    },
    {
      failure: 'the preview backend fails',
      message: 'WebGPU preview is unavailable',
      opens: false,
      arrange: () =>
        previewBackendMock.resolvePreviewBackend.mockRejectedValue(
          new Error('WebGPU preview is unavailable'),
        ),
    },
    {
      failure: 'the session cannot be created',
      message: 'session creation failed',
      opens: false,
      arrange: (h: Load) =>
        vi.mocked(h.ctx.services.replaceFile).mockImplementation(() => {
          throw new Error('session creation failed')
        }),
    },
  ])(
    'reports one load failure and cancels its lease when $failure',
    async ({ message, opens, arrange }) => {
      const h = createLoad()
      arrange(h)

      await orchestrateRawLoad(rawFile('broken.ARW'), h.ctx)

      expect(h.ctx.atoms.setError).toHaveBeenLastCalledWith(
        message ?? 'Failed to load file',
      )
      expect(h.ctx.atoms.setStatus).toHaveBeenLastCalledWith('error')
      expect(h.ctx.services.notify).toHaveBeenCalledExactlyOnceWith({
        kind: 'load-failed',
        message,
      })
      expect(h.open).toHaveBeenCalledTimes(opens ? 1 : 0)
      expect(h.leases[0]!.cancel).toHaveBeenCalled()
      expect(h.ctx.refs.runtimeWorkSessionIdRef.current).toBeNull()
    },
  )

  it('reports an unavailable preview once when the quick decode fails', async () => {
    const h = createLoad()
    h.open.mockResolvedValue(
      createRuntimeSession({
        decodeQuickRaw: vi.fn().mockRejectedValue(
          Object.assign(new Error('decode exploded'), {
            code: 'RAW_DECODE_FAILED',
          }),
        ),
      }),
    )

    await orchestrateRawLoad(rawFile(), h.ctx)

    expect(h.ctx.atoms.setError).toHaveBeenLastCalledWith('decode exploded')
    expect(h.ctx.atoms.setStatus).toHaveBeenLastCalledWith('error')
    expect(h.ctx.services.notify).toHaveBeenCalledExactlyOnceWith({
      kind: 'preview-unavailable',
    })
  })

  it('refuses an unsupported file before any work and reports nothing', async () => {
    const h = createLoad()

    await orchestrateRawLoad(new File(['x'], 'notes.txt'), h.ctx)

    expect(h.ctx.atoms.setError).toHaveBeenCalledExactlyOnceWith(
      'Unsupported file format: notes.txt',
    )
    expect(h.ctx.services.beginRuntimeSession).not.toHaveBeenCalled()
    expect(h.ctx.services.notify).not.toHaveBeenCalled()
  })
})
