import type {
  LumaRawCameraCalibrationProfile,
  LumaRawRuntime,
} from '@lumaforge/luma-raw-runtime'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { RawRuntimeHostOptions } from './raw-runtime-host'
import { createRawRuntimeHost } from './raw-runtime-host'

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

    const session = await host
      .beginSession()
      .open(new File(['raw'], 'sample.ARW'))
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

    const session = await host
      .beginSession()
      .open(new File(['raw'], 'sample.ARW'))
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

    const session = await host
      .beginSession()
      .open(new File(['raw'], 'sample.ARW'))

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

    const session = await host
      .beginSession()
      .open(new File(['raw'], 'sample.ARW'))

    await expect(
      session.applyCalibration(makeCalibrationProfile()),
    ).rejects.toMatchObject({
      name: 'RawAdapterError',
      code: 'RAW_RUNTIME_UNAVAILABLE',
      message: 'matrix invalid',
    })
  })
})
