import type { RawRenderExposure } from '@lumaforge/luma-color-runtime'
import { resolveRawRenderExposure } from '@lumaforge/luma-color-runtime'
import type {
  LumaRawCameraCalibrationProfile,
  LumaRawFrame,
  LumaRawRuntime,
} from '@lumaforge/luma-raw-runtime'
import { QUICK_PREVIEW_MAX_PIXELS } from '@lumaforge/render-engine/preview'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { RawRuntimeHostOptions } from './raw-runtime-host'
import { createRawRuntimeHost } from './raw-runtime-host'

vi.mock('@lumaforge/luma-color-runtime', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@lumaforge/luma-color-runtime')>()
  return {
    ...actual,
    resolveRawRenderExposure: vi.fn(actual.resolveRawRenderExposure),
  }
})

function makeLumaRuntime(
  overrides: Partial<LumaRawRuntime> & {
    applyCalibration?: ReturnType<typeof vi.fn>
    sessionDecodeQuick?: ReturnType<typeof vi.fn>
    sessionDecodeBoundedHq?: ReturnType<typeof vi.fn>
  } = {},
) {
  const applyCalibration =
    overrides.applyCalibration ??
    vi.fn().mockResolvedValue({ applied: true } as const)
  const dispose = vi.fn()
  const sessionDecodeQuick = overrides.sessionDecodeQuick ?? vi.fn()
  const sessionDecodeBoundedHq = overrides.sessionDecodeBoundedHq ?? vi.fn()

  const runtime = {
    init: vi.fn().mockResolvedValue({
      runtime: 'luma',
      version: '0.1.0',
      simd: true,
      pthreads: true,
      crossOriginIsolated: true,
      memoryTier: 'normal',
      memoryProfile: 'desktop',
      workerPoolSize: 2,
    }),
    probe: vi.fn(),
    extractEmbeddedPreview: vi.fn().mockResolvedValue(null),
    decodeQuick: vi.fn(),
    decodeBoundedHq: vi.fn(),
    dispose: vi.fn(),
    openSession: vi.fn().mockResolvedValue({
      sessionId: 'cal-session-1',
      probe: {
        jobId: 'probe',
        width: 6240,
        height: 4168,
        supportLevel: 'experimental',
        timings: { total: 1 },
      },
      timings: { total: 1 },
      extractEmbeddedPreview: vi.fn().mockResolvedValue(null),
      probeExportCapability: vi.fn(),
      readProcessedWindow: vi.fn(),
      decodeQuick: sessionDecodeQuick,
      decodeBoundedHq: sessionDecodeBoundedHq,
      applyCalibration,
      dispose,
    }),
    ...overrides,
  } satisfies LumaRawRuntime

  return {
    runtime,
    applyCalibration,
    dispose,
    sessionDecodeQuick,
    sessionDecodeBoundedHq,
  }
}

function makeFrame(
  source: LumaRawFrame['source'],
  level: number,
  metadata: Partial<LumaRawFrame['metadata']> = {},
): LumaRawFrame {
  const width = 4
  const height = 4
  return {
    jobId: `${source}-job`,
    sessionId: 'cal-session-1',
    source,
    width,
    height,
    data: new Uint16Array(width * height * 3).fill(level),
    layout: 'rgb',
    bitDepth: 16,
    colorSpace: 'linear-prophoto-rgb',
    orientation: 1,
    metadata: { supportLevel: 'experimental', ...metadata },
    timings: { total: 1 },
  }
}

function estimateFor(frame: LumaRawFrame): RawRenderExposure {
  return resolveRawRenderExposure({
    metadata: { baselineExposure: frame.metadata.baselineExposure },
    image: { data: frame.data, width: frame.width, height: frame.height },
  })
}

function makeCalibrationProfile(
  toneCurve = false,
): LumaRawCameraCalibrationProfile {
  const profile: LumaRawCameraCalibrationProfile = {
    profileId: 'adobe-standard-ilce-7m4',
    profileName: 'Sony ILCE-7M4 Adobe Standard',
    xyzToCamera: new Float32Array([
      0.7, 0.2, 0.1, 0.3, 0.85, -0.15, -0.05, 0.1, 0.95,
    ]),
  }
  if (toneCurve) {
    profile.toneCurveLut = new Float32Array(4096)
    for (let index = 0; index < profile.toneCurveLut.length; index += 1) {
      profile.toneCurveLut[index] = index / (profile.toneCurveLut.length - 1)
    }
  }
  return profile
}

const hosts: ReturnType<typeof createRawRuntimeHost>[] = []

function createHost(options: RawRuntimeHostOptions) {
  const host = createRawRuntimeHost(options)
  hosts.push(host)
  return host
}

afterEach(() => {
  for (const host of hosts.splice(0)) host.dispose()
  vi.clearAllMocks()
})

describe('raw runtime host session applyCalibration', () => {
  it('forwards the calibration profile through the session, including the tone-curve LUT', async () => {
    const applyCalibration = vi
      .fn()
      .mockResolvedValue({ applied: true } as const)
    const { runtime } = makeLumaRuntime({ applyCalibration })
    const host = createHost({
      runtimeFactory: () => runtime,
    })

    const session = await host.openSession(new File(['raw'], 'sample.ARW'))
    const profile = makeCalibrationProfile(true)
    const controller = new AbortController()

    await expect(
      session.applyCalibration(profile, controller.signal),
    ).resolves.toEqual({ applied: true })

    expect(applyCalibration).toHaveBeenCalledTimes(1)
    const [calledProfile, calledSignal] = applyCalibration.mock.calls[0]
    expect(calledProfile).toBe(profile)
    expect(calledProfile.xyzToCamera).toBeInstanceOf(Float32Array)
    expect(calledProfile.toneCurveLut).toBeInstanceOf(Float32Array)
    expect(calledSignal).toBe(controller.signal)
  })

  it('forwards a calibration profile without a tone-curve LUT', async () => {
    const applyCalibration = vi
      .fn()
      .mockResolvedValue({ applied: true } as const)
    const { runtime } = makeLumaRuntime({ applyCalibration })
    const host = createHost({
      runtimeFactory: () => runtime,
    })

    const session = await host.openSession(new File(['raw'], 'sample.ARW'))
    const profile = makeCalibrationProfile(false)

    await session.applyCalibration(profile)

    expect(applyCalibration).toHaveBeenCalledTimes(1)
    const [calledProfile] = applyCalibration.mock.calls[0]
    expect(calledProfile.xyzToCamera).toBeInstanceOf(Float32Array)
    expect(calledProfile.toneCurveLut).toBeUndefined()
  })

  it('normalizes runtime calibration failures into a RawAdapterError', async () => {
    const applyCalibration = vi.fn().mockRejectedValue(
      Object.assign(new Error('calibration unsupported'), {
        code: 'RAW_RUNTIME_UNAVAILABLE',
      }),
    )
    const { runtime } = makeLumaRuntime({ applyCalibration })
    const host = createHost({
      runtimeFactory: () => runtime,
    })

    const session = await host.openSession(new File(['raw'], 'sample.ARW'))

    await expect(
      session.applyCalibration(makeCalibrationProfile()),
    ).rejects.toMatchObject({
      name: 'RawAdapterError',
      code: 'RAW_RUNTIME_UNAVAILABLE',
      message: 'calibration unsupported',
    })
  })

  it('normalizes a generic calibration error using the fallback adapter code', async () => {
    const applyCalibration = vi
      .fn()
      .mockRejectedValue(new Error('matrix invalid'))
    const { runtime } = makeLumaRuntime({ applyCalibration })
    const host = createHost({
      runtimeFactory: () => runtime,
    })

    const session = await host.openSession(new File(['raw'], 'sample.ARW'))

    await expect(
      session.applyCalibration(makeCalibrationProfile()),
    ).rejects.toMatchObject({
      name: 'RawAdapterError',
      code: 'RAW_RUNTIME_UNAVAILABLE',
      message: 'matrix invalid',
    })
  })
})

describe('raw runtime host source exposure', () => {
  const quickFrame = makeFrame('quick', 20_000)
  const hqFrame = makeFrame('bounded-hq', 40_000)

  async function openSessionWithFrames(
    frames: { quick?: LumaRawFrame[]; hq?: LumaRawFrame[] } = {},
  ) {
    const sessionDecodeQuick = vi.fn()
    for (const frame of frames.quick ?? [quickFrame]) {
      sessionDecodeQuick.mockResolvedValueOnce(frame)
    }
    const sessionDecodeBoundedHq = vi.fn()
    for (const frame of frames.hq ?? [hqFrame]) {
      sessionDecodeBoundedHq.mockResolvedValueOnce(frame)
    }
    const fixture = makeLumaRuntime({
      sessionDecodeQuick,
      sessionDecodeBoundedHq,
    })
    const host = createHost({
      runtimeFactory: () => fixture.runtime,
    })
    const session = await host.openSession(new File(['raw'], 'sample.ARW'))
    vi.mocked(resolveRawRenderExposure).mockClear()
    return { ...fixture, host, session }
  }

  it('estimates quick and bounded HQ independently when nothing is pinned', async () => {
    const { session } = await openSessionWithFrames()

    const quick = await session.decodeQuickRaw()
    const hq = await session.decodeBoundedHqRaw({ maxOutputPixels: 12_000_000 })

    expect(quick.renderExposure).toEqual(estimateFor(quickFrame))
    expect(hq.renderExposure).toEqual(estimateFor(hqFrame))
    expect(quick.renderExposure.source).toBe('image-statistics')
    expect(hq.renderExposure.ev).not.toBeCloseTo(quick.renderExposure.ev, 2)
  })

  it('lets bounded HQ reuse the quick exposure without re-estimating', async () => {
    const { session, sessionDecodeBoundedHq } = await openSessionWithFrames()
    const controller = new AbortController()

    const quick = await session.decodeQuickRaw()
    vi.mocked(resolveRawRenderExposure).mockClear()
    const hq = await session.decodeBoundedHqRaw(
      { maxOutputPixels: 12_000_000, pinnedExposure: quick.renderExposure },
      undefined,
      controller.signal,
    )

    expect(hq.renderExposure).toEqual(quick.renderExposure)
    expect(hq.renderExposure).not.toBe(quick.renderExposure)
    expect(hq.data).toBe(hqFrame.data)
    expect(resolveRawRenderExposure).not.toHaveBeenCalled()
    // The pin stays on the app side; the runtime request is unchanged.
    expect(sessionDecodeBoundedHq).toHaveBeenCalledWith(
      { maxOutputPixels: 12_000_000 },
      controller.signal,
    )
  })

  it('re-estimates a repeated quick decode unless the source exposure is pinned', async () => {
    const shiftedQuickFrame = makeFrame('quick', 30_000)
    const { session, sessionDecodeQuick } = await openSessionWithFrames({
      quick: [quickFrame, shiftedQuickFrame, shiftedQuickFrame],
    })

    const first = await session.decodeQuickRaw()
    const repeated = await session.decodeQuickRaw()
    const restored = await session.decodeQuickRaw(undefined, undefined, {
      pinnedExposure: first.renderExposure,
    })

    expect(repeated.renderExposure).toEqual(estimateFor(shiftedQuickFrame))
    expect(restored.renderExposure).toEqual(first.renderExposure)
    expect(restored.data).toBe(shiftedQuickFrame.data)
    expect(sessionDecodeQuick).toHaveBeenLastCalledWith(
      { maxOutputPixels: QUICK_PREVIEW_MAX_PIXELS },
      undefined,
    )
  })

  it('treats a pinned zero exposure as a real value', async () => {
    const { session } = await openSessionWithFrames()
    const zero: RawRenderExposure = {
      ev: 0,
      multiplier: 1,
      source: 'image-statistics',
    }

    const hq = await session.decodeBoundedHqRaw({
      maxOutputPixels: 12_000_000,
      pinnedExposure: zero,
    })

    expect(resolveRawRenderExposure).not.toHaveBeenCalled()
    expect(hq.renderExposure).toEqual(zero)
    expect(estimateFor(hqFrame).ev).not.toBe(0)
  })

  it('keeps DNG baseline exposure as the unpinned result and carries it when pinned', async () => {
    const baselineQuick = makeFrame('quick', 20_000, { baselineExposure: 0.5 })
    const baselineHq = makeFrame('bounded-hq', 40_000, {
      baselineExposure: 0.5,
    })
    const { session } = await openSessionWithFrames({
      quick: [baselineQuick],
      hq: [baselineHq],
    })

    const quick = await session.decodeQuickRaw()
    const hq = await session.decodeBoundedHqRaw({
      maxOutputPixels: 12_000_000,
      pinnedExposure: quick.renderExposure,
    })

    expect(quick.renderExposure).toEqual({
      ev: 0.5,
      multiplier: Math.pow(2, 0.5),
      source: 'dng-baseline',
    })
    expect(hq.renderExposure).toEqual(quick.renderExposure)
    expect(hq.metadata.baselineExposure).toBe(0.5)
  })

  it('still normalizes decode failures when an exposure is pinned', async () => {
    const sessionDecodeBoundedHq = vi
      .fn()
      .mockRejectedValue(new Error('window decode failed'))
    const { runtime } = makeLumaRuntime({ sessionDecodeBoundedHq })
    const host = createHost({
      runtimeFactory: () => runtime,
    })
    const session = await host.openSession(new File(['raw'], 'sample.ARW'))

    await expect(
      session.decodeBoundedHqRaw({
        maxOutputPixels: 12_000_000,
        pinnedExposure: estimateFor(quickFrame),
      }),
    ).rejects.toMatchObject({
      name: 'RawAdapterError',
      code: 'RAW_HQ_DECODE_FAILED',
      message: 'window decode failed',
    })
  })

  it('does not carry a pin into a later session or the standalone decode calls', async () => {
    const first = await openSessionWithFrames()
    const quick = await first.session.decodeQuickRaw()
    await first.session.decodeBoundedHqRaw({
      maxOutputPixels: 12_000_000,
      pinnedExposure: quick.renderExposure,
    })

    const second = await openSessionWithFrames()
    const secondHq = await second.session.decodeBoundedHqRaw({
      maxOutputPixels: 12_000_000,
    })
    expect(secondHq.renderExposure).toEqual(estimateFor(hqFrame))

    const runtime = second.runtime
    vi.mocked(runtime.decodeQuick).mockResolvedValue(quickFrame)
    vi.mocked(runtime.decodeBoundedHq).mockResolvedValue(hqFrame)
    const standaloneQuick = await second.host.decodeQuickRaw(
      new File(['raw'], 'sample.ARW'),
    )
    const standaloneHq = await second.host.decodeBoundedHqRaw(
      new File(['raw'], 'sample.ARW'),
      { maxOutputPixels: 12_000_000 },
    )
    expect(standaloneQuick.renderExposure).toEqual(estimateFor(quickFrame))
    expect(standaloneHq.renderExposure).toEqual(estimateFor(hqFrame))
  })
})
