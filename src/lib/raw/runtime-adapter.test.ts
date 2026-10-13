import type {
  LumaRawExportCapability,
  LumaRawExportColorFacts,
  LumaRawFrame,
  LumaRawRuntime,
  LumaRawRuntimeInfo,
} from '@lumaforge/luma-raw-runtime'
import { JPEG_RUNTIME_UNAVAILABLE_MESSAGE } from '@lumaforge/render-engine/export'
import {
  BOUNDED_HQ_PREVIEW_LOW_MEMORY_MAX_PIXELS,
  BOUNDED_HQ_PREVIEW_MAX_PIXELS,
} from '@lumaforge/render-engine/preview'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { RawRuntimeHostOptions } from './raw-runtime-host'
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

function makeFrame(data: Uint16Array): LumaRawFrame {
  return {
    jobId: 'quick-1',
    source: 'quick',
    width: 1,
    height: 1,
    data,
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
    timings: { total: 20 },
  }
}

function makeLumaFrame(source: 'quick' | 'bounded-hq'): LumaRawFrame {
  return {
    jobId: `${source}-1`,
    source,
    width: 1,
    height: 1,
    data: new Uint16Array([0, 32768, 65535]),
    layout: 'rgb' as const,
    bitDepth: 16 as const,
    colorSpace: 'linear-prophoto-rgb' as const,
    orientation: 1,
    metadata: {
      width: 1,
      height: 1,
      supportLevel: 'experimental' as const,
    },
    timings: { total: 1 },
  }
}

/**
 * The color facts the native processed-window capability declares: the
 * green-normalized camera white balance, the camera-to-working matrix, linear
 * ProPhoto output, and both runtime-applied flags, every one explicit.
 */
function makeNativeColorFacts(): LumaRawExportColorFacts {
  return {
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
    cfa: { pattern: 'rggb', xPhase: 0, yPhase: 0 },
    blackLevel: 0,
    whiteLevel: 65535,
    strategy: 'libraw-processed-window',
    orientation: {
      code: 1,
      supported: true,
      outputWidth: 6240,
      outputHeight: 4168,
    },
    color: makeNativeColorFacts(),
    sensor: {
      layout: 'bayer',
      colorCount: 3,
      cfa: { pattern: 'rggb', xPhase: 0, yPhase: 0 },
      phaseIsWindowLocal: false,
    },
    levels: { black: 0, white: 65535 },
    windows: { librawProcessed: true },
    diagnostics: {
      hasRawImage: true,
      hasColor3Image: false,
      hasColor4Image: false,
      hasXTransTable: false,
    },
    reasons: [],
  }
}

/**
 * Native color facts with one fact left out, as an incomplete payload would
 * arrive. The omission must refuse export, never default to the native value.
 */
function colorFactsWithout(fact: keyof LumaRawExportColorFacts) {
  const facts: Partial<LumaRawExportColorFacts> = makeNativeColorFacts()
  delete facts[fact]
  return facts
}

function makeLumaRuntime(
  dataOrOverrides: Uint16Array | Partial<LumaRawRuntime> = new Uint16Array([
    0, 32768, 65535,
  ]),
) {
  const data =
    dataOrOverrides instanceof Uint16Array
      ? dataOrOverrides
      : new Uint16Array([0, 32768, 65535])
  const overrides =
    dataOrOverrides instanceof Uint16Array ? {} : dataOrOverrides
  const quickFrame = makeFrame(data)

  return {
    runtime: {
      init: vi
        .fn<LumaRawRuntime['init']>()
        .mockResolvedValue(makeRuntimeInfo()),
      probe: vi.fn<LumaRawRuntime['probe']>(),
      extractEmbeddedPreview: vi
        .fn<LumaRawRuntime['extractEmbeddedPreview']>()
        .mockResolvedValue({
          jobId: 'embedded-1',
          source: 'embedded',
          width: 1600,
          height: 1067,
          data: new Uint8Array([1, 2, 3]),
          mimeType: 'image/jpeg',
          colorSpace: 'display-srgb-preview',
          orientation: 1,
          timings: { total: 10 },
        }),
      decodeQuick: vi
        .fn<LumaRawRuntime['decodeQuick']>()
        .mockResolvedValue(quickFrame),
      decodeBoundedHq: vi
        .fn<LumaRawRuntime['decodeBoundedHq']>()
        .mockResolvedValue({
          ...quickFrame,
          jobId: 'bounded-hq-1',
          source: 'bounded-hq',
        }),
      dispose: vi.fn<LumaRawRuntime['dispose']>(),
      openSession: vi.fn<LumaRawRuntime['openSession']>().mockResolvedValue({
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
        decodeQuick: vi.fn().mockResolvedValue(makeLumaFrame('quick')),
        decodeBoundedHq: vi.fn().mockResolvedValue(makeLumaFrame('bounded-hq')),
        applyCalibration: vi.fn().mockResolvedValue({ applied: true } as const),
        dispose: vi.fn(),
      }),
      ...overrides,
    } satisfies LumaRawRuntime,
    quickFrame,
  }
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

describe('raw runtime host conversion and export gate', () => {
  it('uses the luma runtime by default without an env flag', async () => {
    const { runtime } = makeLumaRuntime()
    const host = createHost({
      runtimeFactory: () => runtime,
    })

    await host.decodeQuickRaw(new File(['raw'], 'sample.ARW'))

    expect(runtime.init).toHaveBeenCalledTimes(1)
    expect(runtime.decodeQuick).toHaveBeenCalledTimes(1)
  })

  it('returns embedded preview bytes from the default luma runtime', async () => {
    const { runtime } = makeLumaRuntime()
    const host = createHost({
      runtimeFactory: () => runtime,
    })

    const preview = await host.extractEmbeddedPreview(
      new File(['raw'], 'sample.ARW'),
    )

    expect(preview).toMatchObject({
      width: 1600,
      height: 1067,
      mimeType: 'image/jpeg',
    })
    expect(preview?.data).toEqual(new Uint8Array([1, 2, 3]))
    expect(runtime.init).toHaveBeenCalledTimes(1)
    expect(runtime.extractEmbeddedPreview).toHaveBeenCalledTimes(1)
  })

  it('preserves RGB16 Linear ProPhoto quick decode data', async () => {
    const quickData = new Uint16Array([0, 32768, 65535])
    const { runtime } = makeLumaRuntime(quickData)
    const host = createHost({
      runtimeFactory: () => runtime,
    })

    const image = await host.decodeQuickRaw(new File(['raw'], 'sample.ARW'))

    expect(image.data).toBe(quickData)
    expect(image.data).toBeInstanceOf(Uint16Array)
    expect(image.channels).toBe(3)
    expect(image.bitsPerChannel).toBe(16)
    expect(image.layout).toBe('rgb-u16')
    expect(image.colorSpace).toBe('linear-prophoto-rgb')
    expect(image.source).toBe('quick')
    expect(image.metadata).toMatchObject({
      make: 'Sony',
      model: 'A7',
      width: 1,
      height: 1,
      orientation: 1,
    })
  })

  it('attaches DNG baseline render exposure to decoded images', async () => {
    const frame = makeLumaFrame('quick')
    frame.metadata.baselineExposure = 1
    const { runtime } = makeLumaRuntime({
      decodeQuick: vi.fn().mockResolvedValue(frame),
    })
    const host = createHost({
      runtimeFactory: () => runtime,
    })

    const image = await host.decodeQuickRaw(new File(['raw'], 'sample.DNG'))

    expect(image.renderExposure).toEqual({
      ev: 1,
      multiplier: 2,
      source: 'dng-baseline',
    })
  })

  it('attaches statistical render exposure when metadata is missing', async () => {
    const frame = makeLumaFrame('quick')
    frame.metadata.baselineExposure = undefined
    frame.data = new Uint16Array([
      2048, 2048, 2048, 4096, 4096, 4096, 8192, 8192, 8192,
    ])
    frame.width = 3
    frame.height = 1
    const { runtime } = makeLumaRuntime({
      decodeQuick: vi.fn().mockResolvedValue(frame),
    })
    const host = createHost({
      runtimeFactory: () => runtime,
    })

    const image = await host.decodeQuickRaw(new File(['raw'], 'sample.RAF'))

    expect(image.renderExposure.source).toBe('image-statistics')
    expect(image.renderExposure.ev).toBeGreaterThan(0)
  })

  it('preserves stable luma runtime error codes', async () => {
    const { runtime } = makeLumaRuntime()
    const runtimeError = Object.assign(
      new Error('Cross-origin isolation is required.'),
      {
        code: 'RAW_CROSS_ORIGIN_ISOLATION_REQUIRED',
      },
    )
    vi.mocked(runtime.init).mockRejectedValue(runtimeError)
    const host = createHost({
      runtimeFactory: () => runtime,
    })

    await expect(
      host.decodeQuickRaw(new File(['raw'], 'sample.ARW')),
    ).rejects.toMatchObject({
      code: 'RAW_CROSS_ORIGIN_ISOLATION_REQUIRED',
      message: 'Cross-origin isolation is required.',
    })
  })

  it('opens one luma session and decodes stages without rereading the file', async () => {
    const extractEmbeddedPreview = vi.fn().mockResolvedValue(null)
    const probeExportCapability = vi.fn().mockResolvedValue(makeCapability())
    const decodeQuick = vi.fn().mockResolvedValue(makeLumaFrame('quick'))
    const decodeBoundedHq = vi
      .fn()
      .mockResolvedValue(makeLumaFrame('bounded-hq'))
    const dispose = vi.fn()
    const openSignal = new AbortController().signal
    const stageSignal = new AbortController().signal
    const { runtime } = makeLumaRuntime({
      openSession: vi.fn().mockResolvedValue({
        sessionId: 'session-1',
        probe: {
          jobId: 'probe',
          width: 6240,
          height: 4168,
          supportLevel: 'experimental',
          timings: { total: 1 },
        },
        timings: { total: 1 },
        extractEmbeddedPreview,
        probeExportCapability,
        readProcessedWindow: vi.fn(),
        decodeQuick,
        decodeBoundedHq,
        applyCalibration: vi.fn().mockResolvedValue({ applied: true } as const),
        dispose,
      }),
    })

    const host = createHost({
      runtimeFactory: () => runtime,
      jpegRuntimeAvailabilityProbe: vi.fn().mockReturnValue(true),
    })

    const file = new File(['raw'], 'sample.ARW')
    const session = await host.openSession(file, openSignal)
    await session.extractEmbeddedPreview(stageSignal)
    await session.probeExportCapability?.(stageSignal)
    await session.decodeQuickRaw(undefined, stageSignal)
    await session.decodeBoundedHqRaw(
      { maxOutputPixels: BOUNDED_HQ_PREVIEW_MAX_PIXELS },
      undefined,
      stageSignal,
    )
    session.dispose()

    expect(runtime.openSession).toHaveBeenCalledWith(
      file,
      expect.objectContaining({ maxOutputPixels: expect.any(Number) }),
      openSignal,
    )
    expect(extractEmbeddedPreview).toHaveBeenCalledWith(stageSignal)
    expect(probeExportCapability).toHaveBeenCalledWith(stageSignal)
    expect(decodeQuick).toHaveBeenCalledWith(
      expect.objectContaining({ maxOutputPixels: expect.any(Number) }),
      stageSignal,
    )
    expect(decodeBoundedHq).toHaveBeenCalledWith(
      { maxOutputPixels: BOUNDED_HQ_PREVIEW_MAX_PIXELS },
      stageSignal,
    )
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('requests bounded HQ with the configured preview cap through an open session', async () => {
    const decodeBoundedHq = vi
      .fn()
      .mockResolvedValue(makeLumaFrame('bounded-hq'))
    const { runtime } = makeLumaRuntime({
      openSession: vi.fn().mockResolvedValue({
        sessionId: 'raw-session-1',
        probe: {
          jobId: 'probe',
          width: 11662,
          height: 8746,
          supportLevel: 'experimental',
          timings: { total: 1 },
        },
        timings: { total: 1 },
        extractEmbeddedPreview: vi.fn(),
        decodeQuick: vi.fn().mockResolvedValue(makeLumaFrame('quick')),
        decodeBoundedHq,
        probeExportCapability: vi.fn().mockResolvedValue(makeCapability()),
        readProcessedWindow: vi.fn(),
        applyCalibration: vi.fn().mockResolvedValue({ applied: true } as const),
        dispose: vi.fn(),
      }),
    })
    const host = createHost({
      runtimeFactory: () => runtime,
    })
    const session = await host.openSession(new File(['raw'], 'sample.RAF'))

    const image = await session.decodeBoundedHqRaw({
      maxOutputPixels: BOUNDED_HQ_PREVIEW_LOW_MEMORY_MAX_PIXELS,
    })

    expect(image.source).toBe('bounded-hq')
    expect(decodeBoundedHq).toHaveBeenCalledWith(
      { maxOutputPixels: BOUNDED_HQ_PREVIEW_LOW_MEMORY_MAX_PIXELS },
      undefined,
    )
    expect(session.sourceDimensions).toEqual({ width: 11662, height: 8746 })
  })

  it('normalizes bounded HQ failures to RAW_HQ_DECODE_FAILED', async () => {
    const { runtime } = makeLumaRuntime({
      openSession: vi.fn().mockResolvedValue({
        sessionId: 'raw-session-1',
        probe: {
          jobId: 'probe',
          width: 6240,
          height: 4168,
          supportLevel: 'experimental',
          timings: { total: 1 },
        },
        timings: { total: 1 },
        extractEmbeddedPreview: vi.fn(),
        decodeQuick: vi.fn().mockResolvedValue(makeLumaFrame('quick')),
        decodeBoundedHq: vi.fn().mockRejectedValue(new Error('bounded failed')),
        probeExportCapability: vi.fn().mockResolvedValue(makeCapability()),
        readProcessedWindow: vi.fn(),
        applyCalibration: vi.fn().mockResolvedValue({ applied: true } as const),
        dispose: vi.fn(),
      }),
    })
    const host = createHost({
      runtimeFactory: () => runtime,
    })
    const session = await host.openSession(new File(['raw'], 'sample.RAF'))

    await expect(
      session.decodeBoundedHqRaw({
        maxOutputPixels: BOUNDED_HQ_PREVIEW_MAX_PIXELS,
      }),
    ).rejects.toMatchObject({
      code: 'RAW_HQ_DECODE_FAILED',
    })
  })

  it('preserves processed-window export capability facts when JPEG runtime is available', async () => {
    const probeExportCapability = vi.fn().mockResolvedValue(makeCapability())
    const jpegRuntimeAvailabilityProbe = vi.fn().mockReturnValue(true)
    const { runtime } = makeLumaRuntime({
      openSession: vi.fn().mockResolvedValue({
        sessionId: 'session-1',
        probe: {
          jobId: 'probe',
          width: 6240,
          height: 4168,
          supportLevel: 'experimental',
          timings: { total: 1 },
        },
        timings: { total: 1 },
        extractEmbeddedPreview: vi.fn(),
        probeExportCapability,
        readProcessedWindow: vi.fn(),
        decodeQuick: vi.fn(),
        decodeBoundedHq: vi.fn(),
        applyCalibration: vi.fn().mockResolvedValue({ applied: true } as const),
        dispose: vi.fn(),
      }),
    })
    const host = createHost({
      runtimeFactory: () => runtime,
      jpegRuntimeAvailabilityProbe,
    })

    const session = await host.openSession(new File(['raw'], 'sample.ARW'))

    await expect(session.probeExportCapability?.()).resolves.toEqual(
      makeCapability(),
    )
    expect(probeExportCapability).toHaveBeenCalledTimes(1)
    expect(jpegRuntimeAvailabilityProbe).toHaveBeenCalledTimes(1)
  })

  it('keeps an open session usable past the decode bridge idle window', async () => {
    vi.useFakeTimers()
    try {
      // Mirrors LumaRawWorkerClient: once the runtime is disposed, every
      // session request rejects with this message.
      let runtimeDisposed = false
      const probeExportCapability = vi.fn(async () => {
        if (runtimeDisposed) {
          throw new Error('RAW runtime worker was disposed.')
        }
        return makeCapability()
      })
      const sessionDispose = vi.fn()
      const { runtime } = makeLumaRuntime({
        dispose: vi.fn<LumaRawRuntime['dispose']>(() => {
          runtimeDisposed = true
        }),
        openSession: vi.fn<LumaRawRuntime['openSession']>().mockResolvedValue({
          sessionId: 'session-1',
          probe: {
            jobId: 'probe',
            width: 11648,
            height: 8736,
            supportLevel: 'experimental',
            timings: { total: 1 },
          },
          timings: { total: 1 },
          extractEmbeddedPreview: vi.fn().mockResolvedValue(null),
          probeExportCapability,
          readProcessedWindow: vi.fn(),
          decodeQuick: vi.fn().mockResolvedValue(makeLumaFrame('quick')),
          decodeBoundedHq: vi
            .fn()
            .mockResolvedValue(makeLumaFrame('bounded-hq')),
          applyCalibration: vi
            .fn()
            .mockResolvedValue({ applied: true } as const),
          dispose: sessionDispose,
        }),
      })
      const host = createHost({
        runtimeFactory: () => runtime,
        jpegRuntimeAvailabilityProbe: () => true,
      })

      const session = await host.openSession(new File(['raw'], 'GFX100RF.RAF'))
      // A 100 MP quick decode can outlast the bridge idle window on its own;
      // the session's requests never pass through the bridge queue.
      await vi.advanceTimersByTimeAsync(30_000)

      await expect(session.probeExportCapability?.()).resolves.toMatchObject({
        supported: true,
      })
      expect(runtime.dispose).not.toHaveBeenCalled()

      // Once the session closes, the idle window reclaims the worker again.
      session.dispose()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(sessionDispose).toHaveBeenCalledTimes(1)
      expect(runtime.dispose).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails export capability closed when the JPEG runtime is unavailable', async () => {
    const probeExportCapability = vi.fn().mockResolvedValue(makeCapability())
    const jpegRuntimeAvailabilityProbe = vi.fn().mockReturnValue(false)
    const { runtime } = makeLumaRuntime({
      openSession: vi.fn().mockResolvedValue({
        sessionId: 'session-1',
        probe: {
          jobId: 'probe',
          width: 6240,
          height: 4168,
          supportLevel: 'experimental',
          timings: { total: 1 },
        },
        timings: { total: 1 },
        extractEmbeddedPreview: vi.fn(),
        probeExportCapability,
        readProcessedWindow: vi.fn(),
        decodeQuick: vi.fn(),
        decodeBoundedHq: vi.fn(),
        applyCalibration: vi.fn().mockResolvedValue({ applied: true } as const),
        dispose: vi.fn(),
      }),
    })
    const host = createHost({
      runtimeFactory: () => runtime,
      jpegRuntimeAvailabilityProbe,
    })

    const session = await host.openSession(new File(['raw'], 'sample.ARW'))

    await expect(session.probeExportCapability?.()).rejects.toMatchObject({
      message: JPEG_RUNTIME_UNAVAILABLE_MESSAGE,
    })
    expect(probeExportCapability).toHaveBeenCalledTimes(1)
    expect(jpegRuntimeAvailabilityProbe).toHaveBeenCalledTimes(1)
  })

  it.each([
    [
      'missing-color-transform',
      { color: undefined },
      ['missing-color-transform'],
    ],
    [
      'missing processed window',
      { windows: { librawProcessed: false } },
      ['processed-window-unavailable'],
    ],
    ['missing dimensions', { width: 0 }, ['missing-dimensions']],
    [
      'a working space other than linear ProPhoto',
      { color: { ...makeNativeColorFacts(), workingSpace: 'linear-srgb' } },
      ['missing-color-transform'],
    ],
    [
      'an omitted working space',
      { color: colorFactsWithout('workingSpace') },
      ['missing-color-transform'],
    ],
    [
      'an omitted runtime white balance flag',
      { color: colorFactsWithout('cameraWhiteBalanceAppliedByRuntime') },
      ['missing-color-transform'],
    ],
    [
      'an omitted runtime camera matrix flag',
      { color: colorFactsWithout('cameraMatrixAppliedByRuntime') },
      ['missing-color-transform'],
    ],
    [
      'a runtime white balance flag set false',
      {
        color: {
          ...makeNativeColorFacts(),
          cameraWhiteBalanceAppliedByRuntime: false,
        },
      },
      ['missing-color-transform'],
    ],
    [
      'a runtime camera matrix flag set false',
      {
        color: {
          ...makeNativeColorFacts(),
          cameraMatrixAppliedByRuntime: false,
        },
      },
      ['missing-color-transform'],
    ],
    [
      'an omitted strategy',
      { strategy: undefined },
      ['processed-window-unavailable'],
    ],
  ] as Array<
    [
      string,
      Partial<LumaRawExportCapability> | LumaRawExportCapability,
      string[],
    ]
  >)(
    'fails export capability closed for %s',
    async (_name, overrides, reasons) => {
      const jpegRuntimeAvailabilityProbe = vi.fn().mockReturnValue(true)
      const { runtime } = makeLumaRuntime({
        openSession: vi.fn().mockResolvedValue({
          sessionId: 'session-1',
          probe: {
            jobId: 'probe',
            width: 6240,
            height: 4168,
            supportLevel: 'experimental',
            timings: { total: 1 },
          },
          timings: { total: 1 },
          extractEmbeddedPreview: vi.fn(),
          probeExportCapability: vi
            .fn()
            .mockResolvedValue({ ...makeCapability(), ...overrides }),
          readProcessedWindow: vi.fn(),
          decodeQuick: vi.fn(),
          decodeBoundedHq: vi.fn(),
          applyCalibration: vi
            .fn()
            .mockResolvedValue({ applied: true } as const),
          dispose: vi.fn(),
        }),
      })
      const host = createHost({
        runtimeFactory: () => runtime,
        jpegRuntimeAvailabilityProbe,
      })

      const session = await host.openSession(new File(['raw'], 'sample.ARW'))

      await expect(session.probeExportCapability?.()).resolves.toMatchObject({
        supported: false,
        reasons,
      })
      expect(jpegRuntimeAvailabilityProbe).not.toHaveBeenCalled()
    },
  )

  it('normalizes generic luma session open failures', async () => {
    const { runtime } = makeLumaRuntime({
      openSession: vi.fn().mockRejectedValue(new Error('open exploded')),
    })
    const host = createHost({
      runtimeFactory: () => runtime,
    })

    await expect(
      host.openSession(new File(['raw'], 'sample.ARW')),
    ).rejects.toMatchObject({
      name: 'RawAdapterError',
      code: 'RAW_OPEN_FAILED',
      message: 'open exploded',
    })
  })

  it('normalizes generic luma session stage failures', async () => {
    const extractEmbeddedPreview = vi
      .fn()
      .mockRejectedValue(new Error('thumbnail exploded'))
    const decodeQuick = vi.fn().mockRejectedValue(new Error('quick exploded'))
    const decodeBoundedHq = vi
      .fn()
      .mockRejectedValue(new Error('bounded hq exploded'))
    const { runtime } = makeLumaRuntime({
      openSession: vi.fn().mockResolvedValue({
        sessionId: 'session-1',
        probe: {
          jobId: 'probe',
          width: 6240,
          height: 4168,
          supportLevel: 'experimental',
          timings: { total: 1 },
        },
        timings: { total: 1 },
        extractEmbeddedPreview,
        readProcessedWindow: vi.fn(),
        decodeQuick,
        decodeBoundedHq,
        applyCalibration: vi.fn().mockResolvedValue({ applied: true } as const),
        dispose: vi.fn(),
      }),
    })
    const host = createHost({
      runtimeFactory: () => runtime,
    })
    const session = await host.openSession(new File(['raw'], 'sample.ARW'))

    await expect(session.extractEmbeddedPreview()).rejects.toMatchObject({
      name: 'RawAdapterError',
      code: 'RAW_THUMBNAIL_UNAVAILABLE',
      message: 'thumbnail exploded',
    })
    await expect(session.decodeQuickRaw()).rejects.toMatchObject({
      name: 'RawAdapterError',
      code: 'RAW_QUICK_DECODE_FAILED',
      message: 'quick exploded',
    })
    await expect(
      session.decodeBoundedHqRaw({
        maxOutputPixels: BOUNDED_HQ_PREVIEW_MAX_PIXELS,
      }),
    ).rejects.toMatchObject({
      name: 'RawAdapterError',
      code: 'RAW_HQ_DECODE_FAILED',
      message: 'bounded hq exploded',
    })
  })

  it('shares one default runtime across concurrent first calls on a host', async () => {
    vi.resetModules()

    const { runtime } = makeLumaRuntime()
    const createLumaRawRuntime = vi.fn(() => runtime)
    vi.doMock('@lumaforge/luma-raw-runtime', () => ({
      createLumaRawRuntime,
    }))

    try {
      const { createRawRuntimeHost } = await import('./raw-runtime-host')
      const host = createRawRuntimeHost({
        jpegRuntimeAvailabilityProbe: () => true,
      })

      await Promise.all([
        host.decodeQuickRaw(new File(['raw-a'], 'a.ARW')),
        host.decodeQuickRaw(new File(['raw-b'], 'b.ARW')),
      ])

      expect(createLumaRawRuntime).toHaveBeenCalledTimes(1)
      expect(runtime.decodeQuick).toHaveBeenCalledTimes(2)

      host.dispose()
    } finally {
      vi.doUnmock('@lumaforge/luma-raw-runtime')
      vi.resetModules()
    }
  })

  it('returns ready outcome and ready state after a successful prewarm', async () => {
    const { runtime } = makeLumaRuntime()
    const host = createHost({
      runtimeFactory: () => runtime,
    })

    expect(host.getPrewarmState()).toBe('idle')

    const outcome = await host.prewarm()

    expect(outcome).toEqual({ status: 'ready' })
    expect(host.getPrewarmState()).toBe('ready')
    expect(runtime.init).toHaveBeenCalledTimes(1)
  })

  it('returns failed outcome with recoverable=false for irrecoverable RAW_CROSS_ORIGIN_ISOLATION_REQUIRED', async () => {
    const { runtime } = makeLumaRuntime()
    const error = Object.assign(
      new Error('Cross-origin isolation is required.'),
      { code: 'RAW_CROSS_ORIGIN_ISOLATION_REQUIRED' },
    )
    vi.mocked(runtime.init).mockRejectedValue(error)
    const host = createHost({
      runtimeFactory: () => runtime,
    })

    const outcome = await host.prewarm()

    expect(outcome).toMatchObject({
      status: 'failed',
      recoverable: false,
    })
    expect(outcome.reason).toContain('Cross-origin isolation')
    expect(host.getPrewarmState()).toBe('failed')
  })

  it('classifies unknown errors as recoverable failures', async () => {
    const { runtime } = makeLumaRuntime()
    vi.mocked(runtime.init).mockRejectedValue(new Error('network blip'))
    const host = createHost({
      runtimeFactory: () => runtime,
    })

    const outcome = await host.prewarm()

    expect(outcome).toMatchObject({
      status: 'failed',
      recoverable: true,
      reason: 'network blip',
    })
    expect(host.getPrewarmState()).toBe('failed')
  })

  it('retries a recoverable prewarm failure on the next explicit call', async () => {
    const { runtime } = makeLumaRuntime()
    vi.mocked(runtime.init).mockRejectedValueOnce(new Error('network blip'))
    const host = createHost({
      runtimeFactory: () => runtime,
    })

    const failed = await host.prewarm()
    expect(failed).toMatchObject({ status: 'failed', recoverable: true })
    expect(host.getPrewarmState()).toBe('failed')

    const retried = await host.prewarm()

    expect(retried).toEqual({ status: 'ready' })
    expect(host.getPrewarmState()).toBe('ready')
    expect(runtime.init).toHaveBeenCalledTimes(2)
  })

  it('shares one retry attempt across concurrent callers after a recoverable failure', async () => {
    let resolveInit: ((info: LumaRawRuntimeInfo) => void) | undefined
    const { runtime } = makeLumaRuntime()
    vi.mocked(runtime.init)
      .mockRejectedValueOnce(new Error('network blip'))
      .mockImplementationOnce(
        () =>
          new Promise<LumaRawRuntimeInfo>((resolve) => {
            resolveInit = resolve
          }),
      )
    const host = createHost({
      runtimeFactory: () => runtime,
    })

    await expect(host.prewarm()).resolves.toMatchObject({
      status: 'failed',
      recoverable: true,
    })

    const first = host.prewarm()
    const second = host.prewarm()
    expect(host.getPrewarmState()).toBe('pending')

    await vi.waitFor(() => expect(resolveInit).toBeTypeOf('function'))
    resolveInit?.(makeRuntimeInfo())

    const [a, b] = await Promise.all([first, second])
    expect(a).toEqual({ status: 'ready' })
    expect(b).toEqual({ status: 'ready' })
    expect(runtime.init).toHaveBeenCalledTimes(2)
  })

  it('keeps an irrecoverable failure sticky without re-init until dispose', async () => {
    const { runtime } = makeLumaRuntime()
    const error = Object.assign(
      new Error('Cross-origin isolation is required.'),
      { code: 'RAW_CROSS_ORIGIN_ISOLATION_REQUIRED' },
    )
    vi.mocked(runtime.init).mockRejectedValue(error)
    const host = createHost({
      runtimeFactory: () => runtime,
    })

    const first = await host.prewarm()
    const second = await host.prewarm()

    expect(first).toMatchObject({ status: 'failed', recoverable: false })
    expect(second).toBe(first)
    expect(host.getPrewarmState()).toBe('failed')
    expect(runtime.init).toHaveBeenCalledTimes(1)

    host.dispose()
    vi.mocked(runtime.init).mockResolvedValue(makeRuntimeInfo())

    await expect(host.prewarm()).resolves.toEqual({ status: 'ready' })
    expect(runtime.init).toHaveBeenCalledTimes(2)
  })

  it('shares one in-flight prewarm across concurrent callers', async () => {
    let resolveInit: ((info: LumaRawRuntimeInfo) => void) | undefined
    const { runtime } = makeLumaRuntime()
    vi.mocked(runtime.init).mockImplementation(
      () =>
        new Promise<LumaRawRuntimeInfo>((resolve) => {
          resolveInit = resolve
        }),
    )
    const host = createHost({
      runtimeFactory: () => runtime,
    })

    const first = host.prewarm()
    const second = host.prewarm()
    expect(host.getPrewarmState()).toBe('pending')

    await vi.waitFor(() => expect(resolveInit).toBeTypeOf('function'))
    resolveInit?.(makeRuntimeInfo())

    const [a, b] = await Promise.all([first, second])
    expect(a).toEqual({ status: 'ready' })
    expect(b).toEqual({ status: 'ready' })
    expect(runtime.init).toHaveBeenCalledTimes(1)
  })

  it('memoizes outcome across calls (no re-init on repeat prewarm)', async () => {
    const { runtime } = makeLumaRuntime()
    const host = createHost({
      runtimeFactory: () => runtime,
    })

    const first = await host.prewarm()
    const second = await host.prewarm()

    expect(first).toEqual({ status: 'ready' })
    expect(second).toEqual({ status: 'ready' })
    expect(runtime.init).toHaveBeenCalledTimes(1)
  })

  it('host dispose resets prewarm state to idle', async () => {
    const { runtime } = makeLumaRuntime()
    const host = createHost({
      runtimeFactory: () => runtime,
    })

    await host.prewarm()
    expect(host.getPrewarmState()).toBe('ready')

    host.dispose()

    expect(host.getPrewarmState()).toBe('idle')
  })

  it('re-initializes after dispose drops a memoized ready outcome', async () => {
    const { runtime } = makeLumaRuntime()
    const host = createHost({
      runtimeFactory: () => runtime,
    })

    await expect(host.prewarm()).resolves.toEqual({ status: 'ready' })
    await expect(host.prewarm()).resolves.toEqual({ status: 'ready' })
    expect(runtime.init).toHaveBeenCalledTimes(1)

    host.dispose()

    await expect(host.prewarm()).resolves.toEqual({ status: 'ready' })
    expect(host.getPrewarmState()).toBe('ready')
    expect(runtime.init).toHaveBeenCalledTimes(2)
  })
})
